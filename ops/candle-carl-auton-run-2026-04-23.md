Candle Carl autonomous run — 2026-04-23 UTC

Summary:
- Applied conservative throttles to reduce CPU and FD pressure:
  - WATCHLIST_EVAL_EVERY_MS: 300000 -> 600000
  - BIRDEYE_WS_MAX_SUBS: 2 -> 1
- Committed under branch: tune/candle-carl-2026-04-23
- PM2 restart performed and verified; process online.

Diagnostics (short):
- pm2 id: 10, pid: 3603279, mem: ~130MB, cpu: variable (up to ~76%), Event Loop p95 previously ~388ms.
- Key envs present: KEYPAIR_PATH, RPC/RPC_URL, TELEGRAM_DISABLED=true

Recommended next steps:
- If event-loop p95 remains >300ms over next 2 runs, enable CPU profiling (km:cpu:profiling:start) for 30s and collect heap samples.
- If RSS spikes >600MB reoccur, consider increasing max_memory_restart guard or profiling heap snapshots.
