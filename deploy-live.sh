#!/usr/bin/env bash
set -euo pipefail

echo "==> Deploying Carl from GitHub main..."
cd /home/dshontaylor/.openclaw/workspace/trading-bot

echo "==> Fetch + checkout main"
git fetch origin
git checkout main

echo "==> Pull latest main"
git pull --ff-only origin main

echo "==> Restart PM2 app"
pm2 restart solana-momentum-bot --update-env

echo "==> Status"
pm2 status solana-momentum-bot

echo "✅ Live deploy complete."
