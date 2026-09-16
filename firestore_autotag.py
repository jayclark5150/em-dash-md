#!/usr/bin/env python3
"""
Auto-tag Firestore documents by title pattern.

Rules are defined in RULES below — each is a (regex, tag) pair.
Existing tags on a document are preserved; new tags are merged in.

Usage:
  python3 firestore_autotag.py [--dry-run] [project_id]
"""

import re
import sys
import json
import subprocess
import urllib.request
import urllib.error

PROJECT_ID = "em-dash-md"
DRY_RUN = False

# ── Tag rules ────────────────────────────────────────────────────────────────
# Each entry: (compiled regex to match against the title, tag string to apply)
RULES = [
    (re.compile(r'daily diary', re.IGNORECASE), 'daily diary'),
    (re.compile(r'work instructions?', re.IGNORECASE), 'work instructions'),
]
# ─────────────────────────────────────────────────────────────────────────────


def get_token():
    try:
        r = subprocess.run(
            ["gcloud", "auth", "application-default", "print-access-token"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    print("ERROR: run `gcloud auth application-default login` first")
    sys.exit(1)


def all_docs(token):
    query = {
        "structuredQuery": {
            "from": [{"collectionId": "documents"}],
            "select": {"fields": [{"fieldPath": "title"}, {"fieldPath": "tags"}]},
        }
    }
    base = f"projects/{PROJECT_ID}/databases/(default)/documents"
    url = f"https://firestore.googleapis.com/v1/{base}:runQuery"
    body = json.dumps(query).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        items = json.loads(r.read())

    docs = []
    for item in items:
        doc = item.get("document")
        if not doc:
            continue
        fields = doc.get("fields", {})
        title = fields.get("title", {}).get("stringValue", "")
        raw_tags = fields.get("tags", {}).get("arrayValue", {}).get("values", [])
        tags = [v.get("stringValue", "") for v in raw_tags if v.get("stringValue")]
        docs.append({"name": doc["name"], "title": title, "tags": tags})
    return docs


def patch_tags(token, resource_name, tags):
    url = f"https://firestore.googleapis.com/v1/{resource_name}?updateMask.fieldPaths=tags"
    values = [{"stringValue": t} for t in tags]
    body = json.dumps({"fields": {"tags": {"arrayValue": {"values": values}}}}).encode()
    req = urllib.request.Request(url, data=body, method="PATCH",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")


def tags_for_title(title):
    return [tag for pattern, tag in RULES if pattern.search(title)]


def main():
    global PROJECT_ID, DRY_RUN

    args = sys.argv[1:]
    if "--dry-run" in args:
        DRY_RUN = True
        args.remove("--dry-run")
    if args:
        PROJECT_ID = args[0]

    print(f"Project : {PROJECT_ID}")
    print(f"Dry run : {DRY_RUN}\n")

    print("Authenticating...")
    token = get_token()
    print("OK\n")

    print("Fetching documents...")
    docs = all_docs(token)
    print(f"Found {len(docs)} documents\n")

    to_update = []
    for doc in docs:
        new_tags = tags_for_title(doc["title"])
        if not new_tags:
            continue
        merged = list(dict.fromkeys(doc["tags"] + [t for t in new_tags if t not in doc["tags"]]))
        if merged != doc["tags"]:
            to_update.append((doc, merged))

    print(f"{len(to_update)} document(s) will have tags added\n")

    if not to_update:
        print("Nothing to do.")
        return

    updated = errors = 0
    for doc, merged in to_update:
        added = [t for t in merged if t not in doc["tags"]]
        prefix = "[DRY RUN] " if DRY_RUN else ""
        print(f'  {prefix}"{doc["title"]}"')
        print(f'    tags: {doc["tags"]} → {merged}  (+{added})')
        if not DRY_RUN:
            try:
                patch_tags(token, doc["name"], merged)
                updated += 1
            except RuntimeError as e:
                print(f"    ERROR: {e}")
                errors += 1

    print()
    if DRY_RUN:
        print(f"Dry run complete. {len(to_update)} document(s) would be updated.")
    else:
        print(f"Done. Updated {updated}, errors {errors}.")


if __name__ == "__main__":
    main()
