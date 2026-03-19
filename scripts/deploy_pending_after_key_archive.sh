#!/usr/bin/env bash
set -euo pipefail

# Deploy pending code/config changes safely AFTER plaintext key material has been archived.
# This script is intended to be run manually (or by a one-shot cron) once the 24h stability window is satisfied.

APP_NAME="solana-momentum-bot"
ECOSYSTEM="$(cd "$(dirname "$0")/.." && pwd)/ecosystem.config.cjs"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT_DIR"

if [[ -f "keys/bot-keypair.json" ]]; then
  echo "[deploy] BLOCKED: keys/bot-keypair.json still present. Archive it first (or wait for the 24h window and run ./scripts/archive_plaintext_key_if_stable.sh)." >&2
  exit 20
fi

if [[ ! -d "keys/offline" ]]; then
  echo "[deploy] WARN: keys/offline/ does not exist (expected if you never created it)." >&2
fi

echo "[deploy] running local quality gates (npm run check)…"
npm run check

echo "[deploy] reloading PM2 app ($APP_NAME) with updated env (safe reload)…"
pm2 reload "$ECOSYSTEM" --only "$APP_NAME" --update-env

echo "[deploy] done. You can verify with: pm2 status && curl -fsS http://127.0.0.1:8787/healthz | jq ."
