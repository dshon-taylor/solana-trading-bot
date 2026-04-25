2026-04-25T05:13:52Z - Candle Carl autonomous run
Changes applied (low-risk):
- LOG_LEVEL set to error (from warn)
- MAX_NEW_ENTRIES_PER_HOUR reduced from 6 to 3
- ROUTE_CACHE_MAX_SIZE set to 256 (from default 512)
Reason: observed sustained high CPU and frequent restarts; aim to reduce processing and memory pressure.
Initial metrics (pre-change):
- PM2 reported solana-momentum-bot CPU up to 100% (top showed PID 3877980 at ~81% earlier)
- RSS observed up to 655 MB; heap up to ~369 MB
- Event loop latency p95: 757.76 ms
- Restarts: 700
Post-change immediate status: restarted via pm2; new PID 3878316; cpu reported 0%, rss ~40MB on fresh start; restarts incremented to 701.
Notes: changes are conservative and reversible. A baseline snapshot of recent metrics recorded in diagnostics/ for automated comparison.
Next: monitor for 2 tuning cycles; if metrics worsen for two consecutive runs, revert this commit automatically (watchdog/state.json updated).
