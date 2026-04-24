Notes (2026-04-23):
- Autonomous optimization cycle run for Candle Carl (D'Shon). Diagnostics show process online under PM2.
- TELEGRAM_DISABLED=true is set intentionally; Telegram errors (404) in logs are due to this setting.
- PM2 reported historical restarts count high (557) — monitor for recurrence. Event loop p95 spiked to ~403ms during sampling; keep an eye on latency.
- No code changes applied during this run. If future optimization makes changes, follow staged architecture and risk budget rules.

Notes (2026-04-24):
- Run: cron:9c7e0c0c-bf4f-4a7a-a4b4-54a4ec7748b6 (Candle Carl autonomous optimization cycle)
- Findings: PM2 env shows conservative defaults already set (BIRDEYE_WS_ENABLED=false, WATCHLIST_EVAL_EVERY_MS=1200000). Runtime RSS fluctuated 450-628MB; heap_used 149-326MB.
- Actions: No config/code edits performed. Restarted process with `pm2 restart solana-momentum-bot --update-env` and verified environment variables (RPC, KEYPAIR_PATH, SOPS_WALLET_FILE) are present.
- Recommendation: monitor RSS over next 24h; if memory/restarts regress, consider staged low-risk edits (limit routeCache, lower wsSubTtlMs, further increase WATCHLIST_EVAL_EVERY_MS) and enable PM2 heap sampling for post-mortem.
