2026-04-22 - Autotune
- Added TELEGRAM_DISABLED default=true in ecosystem.config.cjs to reduce Telegram fetch errors when bot is run in environments without active Telegram connectivity.
- PM2 config retains max_memory_restart=1500M and increased WATCHLIST_EVAL_EVERY_MS to 4500ms to lower memory/CPU pressure.
- Commit: d922c64 on branch autonomous/candle-carl-20260422010451 (local). Remote push not configured.
- PM2 restart performed; process online. Monitor restarts and telegram errors for regression.
