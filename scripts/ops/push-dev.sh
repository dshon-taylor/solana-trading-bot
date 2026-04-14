#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MSG="${1:-dev update}"
cd "${REPO_DIR}"

echo "==> Switching to dev"
git checkout dev

echo "==> Syncing latest dev"
git fetch origin
git pull --rebase origin dev || true

echo "==> Commit + push"
git add -A
if git diff --cached --quiet; then
echo "No changes to commit."
else
git commit -m "$MSG"
fi
git push origin dev

echo "✅ Dev push complete."
echo "Next: open PR dev -> main on GitHub when ready."
