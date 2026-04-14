#!/usr/bin/env bash
set -euo pipefail

# Archive plaintext key material AFTER the bot has been stable for >=24h.
# This script is intentionally conservative and does NOT delete anything.
# It moves keys/bot-keypair.json -> keys/offline/bot-keypair.<timestamp>.json
#
# Requirements:
# - pm2 available
# - process name: solana-momentum-bot

PROC_NAME="solana-momentum-bot"
KEY_PATH="keys/bot-keypair.json"
OFFLINE_DIR="keys/offline"

if [[ ! -f "$KEY_PATH" ]]; then
  echo "[ok] no plaintext key at $KEY_PATH (nothing to do)"
  exit 0
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[error] pm2 not found; refusing to proceed"
  exit 2
fi

# Pull a small status blob from pm2.
STATUS_JSON="$(
  PROC_NAME="$PROC_NAME" node <<'NODE'
const { execSync } = require('node:child_process');
const name = process.env.PROC_NAME;
const raw = execSync('pm2 jlist', { encoding: 'utf8' });
const j = JSON.parse(raw);
const p = j.find(x => x.name === name);
if (!p) {
  console.log(JSON.stringify({ ok:false, reason:'process_not_found', name }, null, 2));
  process.exit(3);
}
const uptimeMs = Date.now() - p.pm2_env.pm_uptime;
console.log(JSON.stringify({
  ok:true,
  name,
  status:p.pm2_env.status,
  uptimeMs,
  unstableRestarts:p.pm2_env.unstable_restarts,
  restartTime:p.pm2_env.restart_time,
  createdAt:new Date(p.pm2_env.created_at).toISOString(),
}, null, 2));
NODE
)"

echo "[info] pm2 status: $STATUS_JSON"

UPTIME_MS="$(echo "$STATUS_JSON" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).uptimeMs")"
UNSTABLE_RESTARTS="$(echo "$STATUS_JSON" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).unstableRestarts")"
STATUS="$(echo "$STATUS_JSON" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status")"

MIN_UPTIME_MS=$((24 * 60 * 60 * 1000))

if [[ "$STATUS" != "online" ]]; then
  echo "[error] bot status is '$STATUS' (expected 'online'); refusing to move key"
  exit 4
fi

if [[ "$UNSTABLE_RESTARTS" != "0" ]]; then
  echo "[error] unstable_restarts=$UNSTABLE_RESTARTS (expected 0); refusing to move key"
  exit 5
fi

if (( UPTIME_MS < MIN_UPTIME_MS )); then
  echo "[error] uptime ${UPTIME_MS}ms < ${MIN_UPTIME_MS}ms (24h); refusing to move key"
  exit 6
fi

mkdir -p "$OFFLINE_DIR"
chmod 700 "$OFFLINE_DIR" || true
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="$OFFLINE_DIR/bot-keypair.$TS.json"

# Move (no delete). Keep perms strict.
chmod 600 "$KEY_PATH" || true
mv "$KEY_PATH" "$DEST"
chmod 600 "$DEST" || true

echo "[ok] archived plaintext key -> $DEST"

echo "[note] If you want secure deletion, consider using a filesystem-specific approach;\n       this script intentionally does not shred/delete."