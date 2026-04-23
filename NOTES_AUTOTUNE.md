2026-04-22 - Candle Carl autotune
- Low-risk env tuning applied to reduce upstream pressure and websocket churn:
  - BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS: 120000 -> 180000
  - WATCHLIST_EVAL_EVERY_MS: 4500 -> 9000
  - WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE: 3 -> 2
- Commit: b85ba12 on branch tune/candle-carl-2026-04-21
- Restart: pm2 restart solana-momentum-bot --update-env
Rationale: mitigate transient "fetch failed" errors and reduce restart frequency without changing architecture.
2026-04-22T02:00Z: Run collected diagnostics. Bottlenecks: external websocket/fetch instability, intermittent memory spikes, high historical restarts. No code changes applied. Recommended: add retry/backoff, websocket reconnect improvements, heap snapshotting on high RSS.
