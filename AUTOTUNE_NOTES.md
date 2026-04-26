2026-04-26 - Candle Carl run (cron f449c836-d1cd-4ad4-89e7-2a3e8da3efe2)
- Changes committed (branch: tune/candle-carl-2026-04-23, commit b48f93f):
  - TRENDING_REFRESH_MS=900000
  - BIRDEYE_WS_MAX_SUBS=1
  - MAX_NEW_ENTRIES_PER_HOUR=1
- Rationale: lower websocket concurrency, reduce periodic refresh frequency, and cap new entries to lower CPU and event-loop load.
- Action: pm2 restart solana-momentum-bot --update-env
- Monitor: watch event-loop p95 and CPU usage for the next two autonomous runs; auto-revert if metrics worsen consecutively.
