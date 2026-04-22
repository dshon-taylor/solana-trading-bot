


## Recent ops note (2026-04-22)
- Performed Candle Carl optimization run: collected diagnostics, verified process online and env variables, no code changes applied. Observed historical high pm2 restarts; restarted process successfully (pm2 restart solana-momentum-bot --update-env).

## Candle Carl tuning (2026-04-22)
- Reduced default WS/watchlist pressure to improve stability and lower event-loop CPU:
  - BIRDEYE_WS_HOT_CAP: 15 -> 8
  - BIRDEYE_WS_MAX_SUBS: 250 -> 150
  - WATCHLIST_EVAL_EVERY_MS: 4500 -> 6000
- Commit: 27993f1d6acfd233658d60e32bf00074a9106e44
- Rationale: lower subscription/concurrency defaults reduce heap pressure and subscription churn which were correlated with SIGINTs and fetch failures in logs.
