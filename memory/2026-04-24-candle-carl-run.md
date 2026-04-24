2026-04-24 19:20 UTC — Candle Carl autonomous optimization run

Diagnostics:
- PM2: solana-momentum-bot (id 10) online; recent restarts high (673 total restarts historically), uptime after restart 22s; current mem reported 44MB immediately after restart.
- Logs: periodic memory telemetry showing RSS ~400MB with transient spikes to ~700MB around 19:09 UTC; routeCache=20-21 consistently; observability entries/hour≈0, snapshotFailures ~1964.

Reasoning / Bottlenecks:
- Dominant issue: intermittent memory spikes (to ~700MB) causing elevated RSS and many restarts historically. Likely due to transient fanout (WS subscriptions, routeCache growth, or external libs memory usage).
- Event loop p95 latency sporadically high in code metrics.

Changes applied (risk: low):
1) Lowered Node max-old-space-size (node_args) from 2048 -> 1536 in ecosystem.config.cjs to reduce process memory headroom and encourage controlled restarts before OOM.
2) Lowered PM2 max_memory_restart from 1G -> 600M to force earlier soft restarts on sustained high RSS.

Actions:
- Committed changes on branch tune/candle-carl-2026-04-23. Remote push failed (no origin configured) — commit is local.
- Restarted process with pm2 restart solana-momentum-bot --update-env; restart succeeded and process reported low memory immediately.

Tests / Verification:
- Observed pm2 show and logs after restart; no crash on restart. Will monitor for 2 consecutive runs; revert scheduled if metrics worsen twice after this change set.

Notes:
- Kept architecture/staging intact; no destructive actions.
- If spikes continue, next low-risk actions: reduce BIRDEYE_WS_HOT_CAP, further lower LIVE_CANDIDATE_SHORTLIST_N, or increase WATCHLIST_EVAL_EVERY_MS. Medium-risk would be code patches to route cache eviction.

Sources: pm2 show, pm2 logs tail (state/pm2-out.log), ecosystem.config.cjs
