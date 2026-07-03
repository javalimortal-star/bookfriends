#!/bin/bash
# Build bookfriends-update.zip: code only, never data/ or .env.
# Usage: bash scripts/make-update-zip.sh
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp -r server.js package.json package-lock.json src views public "$STAGE"/
python3 -c "import shutil,sys; print(shutil.make_archive('bookfriends-update','zip','$STAGE'))"
echo "Copy bookfriends-update.zip into C:\\bookfriends on the mini PC,"
echo "then right-click update-bookfriends.cmd there -> Run as administrator."
