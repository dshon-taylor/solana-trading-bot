#!/usr/bin/env bash
set -euo pipefail

# Harden local filesystem permissions for secrets.
# This script is intentionally NOT run automatically.
# Review before executing.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="$ROOT_DIR/secrets"

if [[ ! -d "$SECRETS_DIR" ]]; then
  echo "secrets dir not found: $SECRETS_DIR" >&2
  exit 1
fi

echo "Harden secrets perms under: $SECRETS_DIR"

echo "+ chmod 700 $SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Tighten common secret file perms.
shopt -s nullglob
for f in "$SECRETS_DIR"/*; do
  if [[ -f "$f" ]]; then
    echo "+ chmod 600 $f"
    chmod 600 "$f"
  fi
done

echo "Done. Current perms:"
stat -c '%a %U %G %n' "$SECRETS_DIR" "$SECRETS_DIR"/* 2>/dev/null || true
