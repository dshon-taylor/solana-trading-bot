Run: Candle Carl autonomous autotune
Time: 2026-04-21T19:31:00Z
Branch: main
Commit: 635e2c0
Changes:
- WATCHLIST_EVAL_EVERY_MS: 12000 -> 30000 (reduce eval frequency)
- WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE: 2 -> 3 (allow slightly more immediate routing per cycle)
- MAX_ACTIVE_RUNNERS: 2 -> 1 (reduce concurrency)
Rationale: Dominant operational bottlenecks observed in prior runs: websocket disconnects and memory pressure. Applied low-risk tuning to reduce concurrency and spread work to lower resource pressure while allowing slightly larger immediate routing to avoid backlog.
Risk: low. Preserves staged architecture.
Verification: pm2 restart executed; process id updated and status=online. Environment file present and env vars reflect new values.
Revert scheduled: none. Will monitor metrics; per policy will revert if 2 consecutive runs worsen.
