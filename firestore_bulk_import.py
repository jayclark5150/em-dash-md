#!/usr/bin/env python3
"""
Firestore Bulk Import Script
Imports all files from a directory into Firestore with metadata and deduplication
"""

import os
import sys
import json
import hashlib
import glob
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Set
import subprocess

def get_firebase_token():
    """Get Firebase token using gcloud"""
    try:
        result = subprocess.run(
            ['gcloud', 'auth', 'application-default', 'print-access-token'],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception as e:
        pass

    print("⚠️  gcloud not found or not configured")
    print("\nTo set up authentication:")
    print("1. Install Google Cloud SDK:")
    print("   macOS: brew install google-cloud-sdk")
    print("   Linux: curl https://sdk.cloud.google.com | bash")
    print("\n2. Authenticate:")
    print("   gcloud auth application-default login")
    print("\n3. Then run this script again")
    sys.exit(1)

def hash_file(filepath: str) -> str:
    """Calculate SHA256 hash of file"""
    try:
        sha256_hash = hashlib.sha256()
        with open(filepath, 'rb') as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception as e:
        print(f"   ⚠️  Could not hash {filepath}: {e}")
        return None

def read_file_content(filepath: str, max_size: int = 1048576) -> str:
    """Read file content with size limit"""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read(max_size)
            if len(content) == max_size:
                content += f"\n\n[Content truncated - original size: {os.path.getsize(filepath)} bytes]"
            return content
    except Exception:
        try:
            size = os.path.getsize(filepath)
            return f"[Binary file - {size} bytes]"
        except:
            return "[Could not read file]"

def scan_directory(directory: str) -> List[Dict]:
    """Recursively scan directory for all files"""
    files = []
    try:
        for root, dirs, filenames in os.walk(directory):
            # Skip hidden directories
            dirs[:] = [d for d in dirs if not d.startswith('.')]

            for filename in filenames:
                if filename.startswith('.'):
                    continue

                filepath = os.path.join(root, filename)
                try:
                    stat = os.stat(filepath)
                    files.append({
                        'path': filepath,
                        'name': filename,
                        'size': stat.st_size,
                        'created': datetime.fromtimestamp(stat.st_birthtime if hasattr(stat, 'st_birthtime') else stat.st_ctime),
                        'modified': datetime.fromtimestamp(stat.st_mtime)
                    })
                except Exception as e:
                    print(f"   ⚠️  Error accessing {filepath}: {e}")
    except Exception as e:
        print(f"   ⚠️  Error scanning directory: {e}")

    return files

def make_firestore_request(token: str, project_id: str, document: Dict) -> bool:
    """Make REST API call to Firestore"""
    import urllib.request
    import urllib.error

    url = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents/files"

    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}'
    }

    data = json.dumps({
        'fields': {
            'filename': {'stringValue': document['filename']},
            'originalPath': {'stringValue': document['originalPath']},
            'size': {'integerValue': str(document['size'])},
            'contentHash': {'stringValue': document['contentHash']},
            'content': {'stringValue': document['content']},
            'contentLength': {'integerValue': str(len(document['content']))},
            'fileExtension': {'stringValue': document['fileExtension']},
            'createdAt': {'timestampValue': document['createdAt'].isoformat() + 'Z'},
            'modifiedAt': {'timestampValue': document['modifiedAt'].isoformat() + 'Z'},
            'importedAt': {'timestampValue': datetime.utcnow().isoformat() + 'Z'}
        }
    }).encode('utf-8')

    req = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        response = urllib.request.urlopen(req, timeout=30)
        return response.status == 200
    except urllib.error.HTTPError as e:
        print(f"   ❌ HTTP Error {e.code}: {e.read().decode()}")
        return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 firestore_bulk_import.py <directory> [project_id]")
        print("Example: python3 firestore_bulk_import.py /Volumes/MUSIC em-dash-md")
        sys.exit(1)

    music_folder = sys.argv[1]
    project_id = sys.argv[2] if len(sys.argv) > 2 else "em-dash-md"

    if not os.path.isdir(music_folder):
        print(f"❌ Directory not found: {music_folder}")
        sys.exit(1)

    print("📁 Firestore Bulk Import Script")
    print("=" * 50)
    print(f"Source: {music_folder}")
    print(f"Project: {project_id}")
    print()

    # Get auth token
    print("🔐 Getting authentication token...")
    token = get_firebase_token()
    print("✓ Authenticated\n")

    # Scan directory
    print("📂 Scanning directory...")
    all_files = scan_directory(music_folder)
    print(f"✓ Found {len(all_files)} files\n")

    # Process files and detect duplicates
    print("🔍 Processing files and detecting duplicates...")
    file_hashes: Dict[str, str] = {}
    documents_to_import = []
    duplicate_count = 0
    error_count = 0

    for i, file_info in enumerate(all_files):
        file_hash = hash_file(file_info['path'])

        if not file_hash:
            error_count += 1
            continue

        if file_hash in file_hashes:
            duplicate_count += 1
            continue

        file_hashes[file_hash] = file_info['name']
        content = read_file_content(file_info['path'])

        documents_to_import.append({
            'filename': file_info['name'],
            'originalPath': file_info['path'],
            'size': file_info['size'],
            'contentHash': file_hash,
            'content': content,
            'fileExtension': Path(file_info['name']).suffix.lower(),
            'createdAt': file_info['created'],
            'modifiedAt': file_info['modified']
        })

        if (i + 1) % 500 == 0:
            print(f"   Processed {i + 1}/{len(all_files)} files...")

    print(f"\n✓ Unique files to import: {len(documents_to_import)}")
    print(f"✓ Duplicates found: {duplicate_count}")
    if error_count > 0:
        print(f"✓ Errors: {error_count}")
    print()

    # Upload to Firestore
    print("📤 Uploading to Firestore...")
    success_count = 0

    for i, doc in enumerate(documents_to_import):
        if make_firestore_request(token, project_id, doc):
            success_count += 1
            if (i + 1) % 50 == 0 or i == len(documents_to_import) - 1:
                print(f"   ✓ Uploaded {success_count}/{len(documents_to_import)}")
        else:
            if (i + 1) % 50 == 0:
                print(f"   ✓ Attempted {i + 1}/{len(documents_to_import)}")

    print(f"\n✅ Import complete!")
    print(f"   Total imported: {success_count}")
    print(f"   Duplicates skipped: {duplicate_count}")
    print(f"   Total scanned: {len(all_files)}")

if __name__ == '__main__':
    main()
