#!/usr/bin/env bash
set -euo pipefail

# Hardens permissions for local runtime state artifacts.
# Safe to run repeatedly.
#
# Goal:
# - prevent other local users on the box from reading bot state/logs/ledgers
# - keep everything accessible to the bot user (this user)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/state"

if [[ ! -d "$STATE_DIR" ]]; then
  echo "state dir not found: $STATE_DIR" >&2
  exit 2
fi

# Directories: only user can read/list.
chmod 700 "$STATE_DIR" || true
find "$STATE_DIR" -type d -exec chmod 700 {} +

# Files: only user can read/write.
find "$STATE_DIR" -type f -exec chmod 600 {} +

echo "ok: hardened perms under $STATE_DIR"