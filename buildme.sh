#!/usr/bin/env bash
# Deploy em-dash-md to Firebase Hosting.
# Usage: ./buildme.sh

set -euo pipefail

cd "$(dirname "$0")"

# Refuse to deploy without a real firebase-config.js
if [ ! -f firebase-config.js ]; then
  echo "Error: firebase-config.js not found. Copy firebase-config.example.js and fill in your values." >&2
  exit 1
fi

echo "Deploying to Firebase Hosting..."
firebase deploy --only hosting

echo "Done."
