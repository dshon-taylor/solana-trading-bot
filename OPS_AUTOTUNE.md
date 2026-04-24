Candle Carl autonomous autotune notes

2026-04-24 - Added safe restart helper script: scripts/restart_bot.sh
Purpose: provide a repeatable, low-risk restart path for solana-momentum-bot that prefers pm2 restart --update-env and falls back to pm2 restart when unsupported by pm2 version or environment.

Autotune policy: this run applied no code changes to runtime logic. Only ops helper + memory/docs appended. No revert scheduled.
