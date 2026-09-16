#!/usr/bin/env python3
"""
Strip the trailing 32-char hex hash from document titles in Firestore.

Before: "2025-02-04 3be6e158c38481d398a9fbbac1176bbc.md"
After:  "2025-02-04.md"

Before: "20260814 Daily Diary 3bd6e158c3848101bda1d6fc3f552687.md"
After:  "20260814 Daily Diary.md"

Usage:
  python3 firestore_strip_hash.py [--dry-run] [project_id]
"""

import re
import sys
import json
import subprocess
import urllib.request
import urllib.error

PROJECT_ID = "em-dash-md"
DRY_RUN = False

HASH_RE = re.compile(r'\s+[0-9a-fA-F]{32}(\.md)$', re.IGNORECASE)


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


def firestore_get(token, path):
    url = f"https://firestore.googleapis.com/v1/{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def firestore_patch(token, resource_name, fields):
    field_mask = ",".join(fields.keys())
    url = f"https://firestore.googleapis.com/v1/{resource_name}?updateMask.fieldPaths={field_mask}"
    body = json.dumps({"fields": {k: {"stringValue": v} for k, v in fields.items()}}).encode()
    req = urllib.request.Request(url, data=body, method="PATCH",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")


def all_docs(token):
    query = {
        "structuredQuery": {
            "from": [{"collectionId": "documents"}],
            "select": {"fields": [{"fieldPath": "title"}]},
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
        title = doc.get("fields", {}).get("title", {}).get("stringValue", "")
        docs.append({"name": doc["name"], "title": title})
    return docs


def strip_hash(title):
    return HASH_RE.sub(r'\1', title)


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

    print("Fetching titles...")
    docs = all_docs(token)
    print(f"Found {len(docs)} documents\n")

    to_update = [(d, strip_hash(d["title"])) for d in docs if strip_hash(d["title"]) != d["title"]]
    print(f"{len(to_update)} title(s) contain a hash to strip\n")

    if not to_update:
        print("Nothing to do.")
        return

    updated = 0
    errors = 0
    for doc, new_title in to_update:
        old = doc["title"]
        doc_id = doc["name"].split("/")[-1]
        print(f'  {"[DRY RUN] " if DRY_RUN else ""}  {old!r}')
        print(f'        →  {new_title!r}')
        if not DRY_RUN:
            try:
                firestore_patch(token, doc["name"], {"title": new_title})
                updated += 1
            except RuntimeError as e:
                print(f"    ERROR: {e}")
                errors += 1
        print()

    if DRY_RUN:
        print(f"Dry run complete. {len(to_update)} title(s) would be updated.")
    else:
        print(f"Done. Updated {updated}, errors {errors}.")


if __name__ == "__main__":
    main()
