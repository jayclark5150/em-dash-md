#!/usr/bin/env python3
"""
Firestore De-duplication Script
Finds and removes duplicate documents (same title + same content) from the
'documents' collection, keeping the oldest copy of each group.

Usage:
  python3 firestore_dedup.py [--dry-run] [project_id]

Options:
  --dry-run    Print what would be deleted without actually deleting.
  project_id   Defaults to "em-dash-md".
"""

import sys
import json
import hashlib
import subprocess
import urllib.request
import urllib.error
from datetime import datetime


PROJECT_ID = "em-dash-md"
DRY_RUN = False


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
    print("ERROR: could not get a gcloud token. Run:")
    print("  gcloud auth application-default login")
    sys.exit(1)


def api(token, path, method="GET", body=None):
    base = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")


def all_docs(token):
    """Page through the entire 'documents' collection via runQuery."""
    query = {
        "structuredQuery": {
            "from": [{"collectionId": "documents"}],
            "orderBy": [{"field": {"fieldPath": "createdAt"}, "direction": "ASCENDING"}],
        }
    }
    url = f":runQuery"
    resp = api(token, url, "POST", query)

    docs = []
    for item in resp:
        doc = item.get("document")
        if not doc:
            continue
        fields = doc.get("fields", {})

        def sv(f):
            v = fields.get(f, {})
            return (
                v.get("stringValue")
                or v.get("integerValue")
                or v.get("timestampValue")
                or ""
            )

        docs.append({
            "name": doc["name"],  # full resource path
            "userId": sv("userId"),
            "title": sv("title"),
            "content": sv("content"),
            "createdAt": sv("createdAt"),
        })
    return docs


def content_hash(text):
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def delete_doc(token, resource_name):
    url = f"https://firestore.googleapis.com/v1/{resource_name}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="DELETE",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")


def main():
    global PROJECT_ID, DRY_RUN

    args = sys.argv[1:]
    if "--dry-run" in args:
        DRY_RUN = True
        args.remove("--dry-run")
    if args:
        PROJECT_ID = args[0]

    print(f"Project : {PROJECT_ID}")
    print(f"Dry run : {DRY_RUN}")
    print()

    print("Authenticating...")
    token = get_token()
    print("OK\n")

    print("Fetching all documents...")
    docs = all_docs(token)
    print(f"Found {len(docs)} total documents\n")

    # Group by (userId, title, content_hash)
    groups: dict[tuple, list] = {}
    for doc in docs:
        key = (doc["userId"], doc["title"], content_hash(doc["content"]))
        groups.setdefault(key, []).append(doc)

    duplicates = {k: v for k, v in groups.items() if len(v) > 1}

    if not duplicates:
        print("No duplicates found.")
        return

    total_to_delete = sum(len(v) - 1 for v in duplicates.values())
    print(f"Found {len(duplicates)} duplicate group(s) — {total_to_delete} document(s) to delete.\n")

    deleted = 0
    for (user_id, title, _), group in duplicates.items():
        # Sort ascending by createdAt; keep index 0 (oldest), delete the rest
        group.sort(key=lambda d: d["createdAt"])
        keeper = group[0]
        to_delete = group[1:]

        short_id = keeper["name"].split("/")[-1]
        print(f'  Title : "{title}"  (userId: {user_id[:8]}...)')
        print(f'  Keep  : {short_id}  (createdAt: {keeper["createdAt"]})')
        for dup in to_delete:
            dup_id = dup["name"].split("/")[-1]
            print(f'  {"[DRY RUN] " if DRY_RUN else ""}Delete: {dup_id}  (createdAt: {dup["createdAt"]})')
            if not DRY_RUN:
                try:
                    delete_doc(token, dup["name"])
                    deleted += 1
                except RuntimeError as e:
                    print(f'    ERROR: {e}')
        print()

    if DRY_RUN:
        print(f"Dry run complete. {total_to_delete} document(s) would be deleted.")
    else:
        print(f"Done. Deleted {deleted} duplicate document(s).")


if __name__ == "__main__":
    main()
