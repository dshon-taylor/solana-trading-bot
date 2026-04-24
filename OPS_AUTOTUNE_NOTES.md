2026-04-23 - Candle Carl autotune summary

- Branch: tune/candle-carl-autotune-2026-04-23 (commit 64ab2ad) pushed to origin.
- Changes: reduced websocket concurrency and subscriptions, increased watchlist evaluation interval, reduced pair/RPC concurrency, increased scan interval, tightened PM2 restart/backoff and max_memory_restart.
- Rationale: reduce RSS/FD pressure and noisy restarts; prevent Telegram polling errors by disabling Telegram by default.
- Verification: PM2 restart completed; process online. Health endpoint connection refused — needs follow-up.
