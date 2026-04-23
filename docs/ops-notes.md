Ops notes (autotune) — Candle Carl 2026-04-23

- Observed frequent Telegram getUpdates 404 errors flooding logs. Telegram is currently disabled via TELEGRAM_DISABLED=true and TELEGRAM_POLL_ENABLED=false in .env, but bot had prior polling attempts (likely before env update/restart).
- Low-risk change applied: reduced pm2 max_restarts from 20 to 5 in ecosystem.config.cjs to reduce crash-loop flapping and surface persistent faults instead of continuous restarts.
- PM2 restart performed with --update-env; boot logs confirm TELEGRAM disabled and bot online.
- Recommend code audit: ensure any Telegram client startup is gated by TELEGRAM_DISABLED/TELEGRAM_POLL_ENABLED checks before making HTTP calls, so removed/placeholder tokens don't generate network errors.
- Note: git push not performed due to missing 'origin' remote on this machine.
