#!/usr/bin/env python3
"""
Auto-tag Firestore documents by title pattern (v2).

OPENSPEC
  Purpose   Add tags to existing em-dash-md documents based on their title.
  Scope     The `tags` field only. Never touches title, content, parentId,
            isDeleted or any other field. Never removes an existing tag.
  Inputs    RULES below (regex on the title -> tag), the Firestore documents
            collection read through the REST API with your gcloud login.
  Outputs   A console report, a run log and (with --apply) a backup file, all
            in ~/Temp (never inside the repo, which is published by hosting).
  Skips     Folders (type == "folder") and trashed documents (isDeleted).
  Safety    Preview is the default. Nothing is written without --apply.
            Self-tests run first and halt the script on any failure.
            Each write carries the document updateTime read earlier, so a
            document edited meanwhile (for example in the app) is skipped
            instead of overwritten. A backup of the old tags is written
            before the first change, and --restore puts them back.
  Risk      HIGH (alters production data): hard halt on a failed self-test.

Usage
  python3 firestore_autotag.py --self-test          no network, checks the rules
  python3 firestore_autotag.py --list               read only, all titles + tags
  python3 firestore_autotag.py                      preview (default, read only)
  python3 firestore_autotag.py --apply              write the tag changes
  python3 firestore_autotag.py --restore FILE       put back tags from a backup
  Optional last argument: project id (default em-dash-md)
"""

import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

PROJECT_ID = "em-dash-md"
OUT_DIR = os.path.expanduser("~/Temp")

# -- Tag rules ----------------------------------------------------------------
# (regex matched against the title, tag). Tags are stored lower case, the same
# way the app stores tags typed in the Open Document list.
RULES = [
    (re.compile(r"daily diary", re.IGNORECASE), "daily diary"),
    (re.compile(r"work instructions?", re.IGNORECASE), "work instructions"),
    # Document type rules (approved 2026-10-12).
    (re.compile(r"^(\d{4}-\d{2}-\d{2}|\d{8})( \(.*\))?(\.md)?$", re.IGNORECASE), "day page"),
    (re.compile(r"\brunbook\b", re.IGNORECASE), "runbook"),
    (re.compile(r"\bpolicy\b", re.IGNORECASE), "policy"),
    (re.compile(r"\bincident\b", re.IGNORECASE), "incident response"),
    (re.compile(r"\bchecklist\b", re.IGNORECASE), "checklist"),
    (re.compile(r"troubleshoot", re.IGNORECASE), "troubleshooting"),
    (re.compile(r"executive summary", re.IGNORECASE), "executive summary"),
    (re.compile(r"\bcab\b", re.IGNORECASE), "cab"),
    (re.compile(r"\bsop\b|standard operating procedure", re.IGNORECASE), "sop"),
    (re.compile(r"^1on1\b", re.IGNORECASE), "1on1"),
    (re.compile(r"\bguidelines?\b", re.IGNORECASE), "guideline"),
    (re.compile(r"\btraining\b", re.IGNORECASE), "training"),
    (re.compile(r"\bto-?do\b", re.IGNORECASE), "to-do"),
    (re.compile(r"phishing", re.IGNORECASE), "phishing"),
]
# -----------------------------------------------------------------------------


def norm_tag(t):
    return re.sub(r"\s+", " ", str(t)).strip().lower()


def tags_for_title(title, rules=None):
    rules = RULES if rules is None else rules
    out = []
    for pattern, tag in rules:
        t = norm_tag(tag)
        if t and pattern.search(title or "") and t not in out:
            out.append(t)
    return out


def plan_updates(docs, rules=None):
    """Return [(doc, merged_tags)] for documents that gain at least one tag.
    Existing tags are kept as they are, in their order; new ones are appended."""
    plan = []
    for d in docs:
        if d.get("isFolder") or d.get("isDeleted"):
            continue
        have = list(d.get("tags", []))
        have_norm = {norm_tag(t) for t in have}
        add = [t for t in tags_for_title(d.get("title", ""), rules) if t not in have_norm]
        if add:
            plan.append((d, have + add))
    return plan


# -- Self-tests (the regression gate) ------------------------------------------
def self_test():
    """Returns a list of failure messages. Empty list means every check passed."""
    fails = []

    def expect(name, cond):
        if not cond:
            fails.append(name)

    expect("rules compile and have lower-case tags",
           all(hasattr(p, "search") and norm_tag(t) == t for p, t in RULES))
    expect("daily diary matches case-insensitively",
           tags_for_title("2026-10-12 Daily Diary") == ["daily diary"])
    expect("work instructions matches singular and plural",
           tags_for_title("Work Instruction: VPN") == ["work instructions"]
           and tags_for_title("work instructions index") == ["work instructions"])
    expect("a title with no match gets no tags", tags_for_title("Shopping list") == [])
    expect("empty or missing title is safe", tags_for_title("") == [] and tags_for_title(None) == [])
    expect("two rules can match one title",
           tags_for_title("Daily Diary work instructions") == ["daily diary", "work instructions"])
    cases = {  # tag: (title that must get it, title that must not)
        "day page": ("2024-05-22.md", "2024-05-22 Standup notes.md"),
        "runbook": ("Runbook - Patching.md", "Runbooks galore.md"),
        "policy": ("IT Policy Backup.md", "Policyholder list.md"),
        "incident response": ("Incident Response Plan.md", "2025 Cyber Incidents.md"),
        "checklist": ("Safe Migration Checklist.md", "Check list.md"),
        "troubleshooting": ("Printer Troubleshooting.md", "Trouble.md"),
        "executive summary": ("Executive Summary Foo.md", "Summary.md"),
        "cab": ("CAB GSBFarm.md", "Cabinet inventory.md"),
        "sop": ("SOP FNBO.md", "Soap notes.md"),
        "1on1": ("1on1 - 2025-01-03.md", "Notes from 1on1.md"),
        "guideline": ("Guideline LAPs.md", "Guidance.md"),
        "training": ("Training Teams chats.md", "Trainings.md"),
        "to-do": ("20260916 To-Do.md", "Todos.md"),
        "phishing": ("Phishing drill.md", "Fishing trip.md"),
    }
    for tag, (yes, no) in cases.items():
        expect("rule " + tag + " matches its example", tag in tags_for_title(yes))
        expect("rule " + tag + " does not match a near miss", tag not in tags_for_title(no))
    expect("every rule has a test case", {t for _, t in RULES} - set(cases) <= {"daily diary", "work instructions"})
    r = [(re.compile("a"), "X"), (re.compile("b"), "x")]
    expect("duplicate tags from two rules are collapsed", tags_for_title("ab", r) == ["x"])

    docs = [
        {"name": "n1", "title": "Daily Diary 1", "tags": []},
        {"name": "n2", "title": "Daily Diary 2", "tags": ["daily diary"]},
        {"name": "n3", "title": "Daily Diary 3", "tags": ["keep", "Daily Diary"]},
        {"name": "n4", "title": "Daily Diary folder", "tags": [], "isFolder": True},
        {"name": "n5", "title": "Daily Diary old", "tags": [], "isDeleted": True},
        {"name": "n6", "title": "Notes", "tags": ["a"]},
        {"name": "n7", "title": "Daily Diary 7", "tags": ["keep"]},
    ]
    plan = {d["name"]: m for d, m in plan_updates(docs)}
    expect("untagged document gains the tag", plan.get("n1") == ["daily diary"])
    expect("already tagged document is left alone (idempotent)", "n2" not in plan)
    expect("tag match ignores case of an existing tag", "n3" not in plan)
    expect("folders are skipped", "n4" not in plan)
    expect("trashed documents are skipped", "n5" not in plan)
    expect("non-matching document is untouched", "n6" not in plan)
    expect("existing tags are preserved and the new one appended", plan.get("n7") == ["keep", "daily diary"])
    again = [(dict(d, tags=plan.get(d["name"], d["tags"])), None) for d in docs]
    expect("a second run finds nothing to do", plan_updates([d for d, _ in again]) == [])
    expect("plan never removes a tag",
           all(set(d["tags"]) <= set(m) for d, m in plan_updates(docs)))
    return fails


# -- Firestore REST -------------------------------------------------------------
def get_token():
    try:
        r = subprocess.run(["gcloud", "auth", "application-default", "print-access-token"],
                           capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    print("ERROR: run `gcloud auth application-default login` first")
    sys.exit(1)


def _req(url, token, body=None, method="GET"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %s: %s" % (e.code, e.read().decode()[:300]))


def all_docs(token):
    base = "projects/%s/databases/(default)/documents" % PROJECT_ID
    fields = ["title", "tags", "type", "isDeleted"]
    q = {"structuredQuery": {"from": [{"collectionId": "documents"}],
                             "select": {"fields": [{"fieldPath": f} for f in fields]}}}
    items = _req("https://firestore.googleapis.com/v1/%s:runQuery" % base, token, q, "POST")
    docs = []
    for item in items or []:
        doc = item.get("document")
        if not doc:
            continue
        f = doc.get("fields", {})
        raw = f.get("tags", {}).get("arrayValue", {}).get("values", [])
        docs.append({
            "name": doc["name"],
            "updateTime": doc.get("updateTime"),
            "title": f.get("title", {}).get("stringValue", ""),
            "tags": [v["stringValue"] for v in raw if v.get("stringValue")],
            "isFolder": f.get("type", {}).get("stringValue") == "folder",
            "isDeleted": f.get("isDeleted", {}).get("booleanValue", False) is True,
        })
    return docs


def patch_tags(token, name, tags, update_time=None):
    q = {"updateMask.fieldPaths": "tags"}
    if update_time:
        q["currentDocument.updateTime"] = update_time
    url = "https://firestore.googleapis.com/v1/%s?%s" % (name, urllib.parse.urlencode(q))
    body = {"fields": {"tags": {"arrayValue": {"values": [{"stringValue": t} for t in tags]}}}}
    _req(url, token, body, "PATCH")


# -- Logging ----------------------------------------------------------------------
class Log:
    def __init__(self, mode):
        os.makedirs(OUT_DIR, exist_ok=True)
        self.stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        self.path = os.path.join(OUT_DIR, "%s-em-dash-md-autotag-%s.log" % (self.stamp[:8], mode))
        self.fh = open(self.path, "a", encoding="utf-8")

    def __call__(self, msg=""):
        print(msg)
        self.fh.write(msg + "\n")
        self.fh.flush()


def main():
    global PROJECT_ID
    args = sys.argv[1:]
    flag = lambda f: (f in args) and (args.remove(f) or True)
    restore = None
    if "--restore" in args:
        i = args.index("--restore")
        restore = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
        if not restore:
            print("ERROR: --restore needs a backup file path")
            sys.exit(2)
    do_self = flag("--self-test")
    do_list = flag("--list")
    apply_ = flag("--apply")
    if args:
        PROJECT_ID = args[0]
    mode = "self-test" if do_self else "list" if do_list else "restore" if restore else "apply" if apply_ else "preview"

    # Regression gate: always first, hard halt on any failure.
    fails = self_test()
    if fails:
        print("SELF-TEST FAILED, halting. No network call was made.")
        for f in fails:
            print("  FAIL " + f)
        sys.exit(1)
    if do_self:
        print("Self-test passed.")
        return

    log = Log(mode)
    log("Project : %s" % PROJECT_ID)
    log("Mode    : %s%s" % (mode, "  (WRITES to Firestore)" if mode in ("apply", "restore") else "  (read only)"))
    log("Self-test passed")
    token = get_token()

    if restore:
        with open(restore, encoding="utf-8") as fh:
            backup = json.load(fh)
        log("Restoring tags on %d document(s) from %s" % (len(backup["docs"]), restore))
        ok = bad = 0
        for d in backup["docs"]:
            try:
                patch_tags(token, d["name"], d["tags"])
                ok += 1
            except RuntimeError as e:
                log("  ERROR %s: %s" % (d["title"], e))
                bad += 1
        log("Restore done. Restored %d, errors %d." % (ok, bad))
        log("Log: " + log.path)
        sys.exit(1 if bad else 0)

    docs = all_docs(token)
    live = [d for d in docs if not d["isFolder"] and not d["isDeleted"]]
    log("Found %d documents (%d live, %d folders, %d trashed)\n" % (
        len(docs), len(live), sum(d["isFolder"] for d in docs), sum(d["isDeleted"] for d in docs)))

    if do_list:
        for d in sorted(live, key=lambda x: x["title"].lower()):
            log("%s    %s" % (d["title"], d["tags"] if d["tags"] else ""))
        log("\nLog: " + log.path)
        return

    plan = plan_updates(docs)
    log("%d document(s) would gain tags\n" % len(plan))
    for d, merged in plan:
        added = [t for t in merged if t not in d["tags"]]
        log('  "%s"\n    %s -> %s  (+%s)' % (d["title"], d["tags"], merged, added))
    counts = {}
    for d, merged in plan:
        for t in merged:
            if t not in d["tags"]:
                counts[t] = counts.get(t, 0) + 1
    if counts:
        log("\nTags to be added (documents per tag):")
        for t, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            log("  %-20s %d" % (t, n))
        log("")
    if not plan:
        log("Nothing to do.")
        log("Log: " + log.path)
        return
    if not apply_:
        log("\nPreview only. Nothing was written. Run with --apply to write these changes.")
        log("Log: " + log.path)
        return

    backup_path = os.path.join(OUT_DIR, "%s-em-dash-md-tags-backup.json" % log.stamp)
    with open(backup_path, "w", encoding="utf-8") as fh:
        json.dump({"project": PROJECT_ID, "created": log.stamp,
                   "docs": [{"name": d["name"], "title": d["title"], "tags": d["tags"]} for d, _ in plan]}, fh, indent=2)
    log("\nBackup written: " + backup_path + "  (restore with --restore)")
    ok = skipped = bad = 0
    for d, merged in plan:
        try:
            patch_tags(token, d["name"], merged, d["updateTime"])
            ok += 1
        except RuntimeError as e:
            if "FAILED_PRECONDITION" in str(e) or "HTTP 400" in str(e) or "HTTP 409" in str(e):
                log('  SKIPPED (changed since it was read) "%s"' % d["title"])
                skipped += 1
            else:
                log('  ERROR "%s": %s' % (d["title"], e))
                bad += 1
    log("\nDone. Updated %d, skipped %d (edited meanwhile, run again), errors %d." % (ok, skipped, bad))
    log("Log: " + log.path)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
