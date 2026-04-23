


## Recent ops note (2026-04-22)
- Performed Candle Carl optimization run: collected diagnostics, verified process online and env variables, no code changes applied. Observed historical high pm2 restarts; restarted process successfully (pm2 restart solana-momentum-bot --update-env).

## Candle Carl tuning (2026-04-22)
- Reduced default WS/watchlist pressure to improve stability and lower event-loop CPU:
  - BIRDEYE_WS_HOT_CAP: 15 -> 8
  - BIRDEYE_WS_MAX_SUBS: 250 -> 150
  - WATCHLIST_EVAL_EVERY_MS: 4500 -> 6000
- Commit: 27993f1d6acfd233658d60e32bf00074a9106e44
- Rationale: lower subscription/concurrency defaults reduce heap pressure and subscription churn which were correlated with SIGINTs and fetch failures in logs.

- 2026-04-22: Aligned PM2 node args and max_memory_restart to 4GB to avoid premature PM2 restarts; set WATCHLIST_EVAL_EVERY_MS=12000 in ecosystem config. Restarted process and verified reduced heap usage. (autonomous run)

## Autonomous tuning (cron:9c7e0c0c)
- 2026-04-22: Applied low-risk runtime tunings and reloaded PM2:
  - WATCHLIST_EVAL_EVERY_MS: default 20000 -> 30000
  - BIRDEYE_WS_MAX_SUBS: default 60 -> 40
- Branch: tune/candle-carl-2026-04-22 (local commit fbd11f6). Remote push failed (origin not configured).
- Rationale: lower eval cadence and fewer websocket subscriptions to reduce memory and FD pressure; observed heap RSS stabilized ~220-300MB in logs after change.
