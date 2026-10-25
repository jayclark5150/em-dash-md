"""Flow test for firestore_autotag.py against a fake Firestore (no network, no credentials).
Run: python3 tests/autotag.test.py"""
import importlib.util, io, json, os, sys, tempfile, contextlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
spec = importlib.util.spec_from_file_location("autotag", os.path.join(ROOT, "firestore_autotag.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

passed = failed = 0
def ok(name, cond):
    global passed, failed
    if cond: passed += 1; print("  ok   " + name)
    else: failed += 1; print("  FAIL " + name)

def fv(s): return {"stringValue": s}
def mkdoc(i, title, tags=(), typ=None, deleted=False, t="2026-10-12T00:00:00Z"):
    f = {"title": fv(title), "tags": {"arrayValue": {"values": [fv(x) for x in tags]}}}
    if typ: f["type"] = fv(typ)
    if deleted: f["isDeleted"] = {"booleanValue": True}
    return {"document": {"name": "projects/p/databases/(default)/documents/documents/" + i, "fields": f, "updateTime": t}}

class Fake:
    def __init__(self):
        self.store = {
            "d1": mkdoc("d1", "Daily Diary 2026-10-01"),
            "d2": mkdoc("d2", "Daily Diary 2026-10-02", ["keep"]),
            "d3": mkdoc("d3", "Work Instructions VPN"),
            "d4": mkdoc("d4", "Daily Diary", typ="folder"),
            "d5": mkdoc("d5", "Daily Diary old", deleted=True),
            "d6": mkdoc("d6", "Shopping", ["x"]),
        }
        self.writes = []
        self.stale = set()          # ids whose precondition fails
    def req(self, url, token, body=None, method="GET"):
        if method == "POST":
            return list(self.store.values())
        if method == "PATCH":
            did = url.split("/documents/documents/")[1].split("?")[0]
            if did in self.stale: raise RuntimeError("HTTP 400: FAILED_PRECONDITION")
            vals = body["fields"]["tags"]["arrayValue"]["values"]
            self.writes.append((did, [v["stringValue"] for v in vals], "currentDocument.updateTime" in url, "updateMask.fieldPaths=tags" in url))
            self.store[did]["document"]["fields"]["tags"] = {"arrayValue": {"values": vals}}
            return {}

def run(fake, *argv):
    m._req = fake.req; m.get_token = lambda: "tok"
    sys.argv = ["x"] + list(argv)
    buf = io.StringIO(); code = 0
    with contextlib.redirect_stdout(buf):
        try: m.main()
        except SystemExit as e: code = e.code or 0
    return code, buf.getvalue()

with tempfile.TemporaryDirectory() as tmp:
    m.OUT_DIR = tmp
    f = Fake()
    c, out = run(f, "--list")
    ok("list is read only", c == 0 and f.writes == [] and "Shopping" in out and "Daily Diary old" not in out)
    c, out = run(f)
    ok("default is preview and writes nothing", f.writes == [] and "Preview only" in out)
    ok("preview lists the 3 documents that gain tags", "3 document(s) would gain tags" in out)
    c, out = run(f, "--apply")
    ok("apply writes only tags, with the updateTime precondition", c == 0 and len(f.writes) == 3 and all(w[2] and w[3] for w in f.writes))
    ok("apply wrote the expected tags", sorted((w[0], w[1]) for w in f.writes) == [("d1", ["daily diary"]), ("d2", ["keep", "daily diary"]), ("d3", ["work instructions"])])
    ok("folder, trashed and unrelated documents untouched", {w[0] for w in f.writes} == {"d1", "d2", "d3"})
    bk = [x for x in os.listdir(tmp) if x.endswith("tags-backup.json")]
    ok("a backup file was written to the output folder, not the repo", len(bk) == 1)
    n = len(f.writes)
    c, out = run(f, "--apply")
    ok("second apply finds nothing to do", len(f.writes) == n and "Nothing to do" in out)
    c, out = run(f, "--restore", os.path.join(tmp, bk[0]))
    ok("restore puts the old tags back", c == 0 and f.store["d1"]["document"]["fields"]["tags"]["arrayValue"]["values"] == [] )
    f2 = Fake(); f2.stale.add("d1")
    c, out = run(f2, "--apply")
    ok("a document changed meanwhile is skipped, not overwritten", "SKIPPED" in out and [w[0] for w in f2.writes] == ["d2", "d3"] and c == 0)
    # gate: a broken rule must stop everything before any network call
    g = Fake(); real = m.RULES
    m.RULES = [(real[0][0], "Daily Diary")]   # not lower case -> self-test must fail
    c, out = run(g, "--apply")
    m.RULES = real
    ok("failed self-test halts before any network call", c == 1 and "SELF-TEST FAILED" in out and g.writes == [])
print("\n%d passed%s" % (passed, ", %d FAILED" % failed if failed else ""))
sys.exit(1 if failed else 0)
