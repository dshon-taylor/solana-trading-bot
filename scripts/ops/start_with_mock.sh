#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/dshontaylor/.openclaw/workspace/trading-bot"
LOG="$ROOT/state/mock_startup.log"

cd "$ROOT"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] startup mock check begin" >> "$LOG"
if node scripts/maintenance/mock_lifecycle_check.mjs >> "$LOG" 2>&1; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] startup mock check PASS" >> "$LOG"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] startup mock check FAIL (continuing bot startup fail-open)" >> "$LOG"
fi

NODE_MAX_OLD_SPACE_MB="${NODE_MAX_OLD_SPACE_MB:-4096}"
exec node --max-old-space-size="$NODE_MAX_OLD_SPACE_MB" --no-warnings src/index.mjs
