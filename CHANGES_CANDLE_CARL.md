2026-04-27 — run_id 7150a6a6
- SOURCES_RPS increased from 1 -> 2 to attempt to mitigate snapshot fetch backpressure.
- HOT_MONITOR_MS_MIN/MAX adjusted from 30000-45000 -> 60000-90000 to reduce hot-monitor frequency and WS churn.
Applied as low-risk runtime .env changes. PM2 restarted solana-momentum-bot; bot is online. Observability still reports snapshotFailures high — follow-up investigation required.
