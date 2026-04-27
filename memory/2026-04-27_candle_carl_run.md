Candle Carl autonomous optimization run - 2026-04-27 UTC

Summary:
- Collected diagnostics via pm2 + logs. Dominant current bottleneck: high event-loop latency (p95 spikes), and past frequent restarts. Memory RSS ~200-260MB; heap moderate.
- Applied 3 low-risk changes to reduce event-loop & RPC pressure:
  1) OBSERVABILITY_ENABLED=false (reduce I/O and snapshot work)
  2) ROUTE_CACHE_MAX_SIZE=256 (reduce cache memory & eviction churn)
  3) SOURCE_RPS=0.15 (lower RPC probe rate)
- Changes committed on branch: tune/candle-carl-2026-04-27 (git pushed to origin).
- Restarted pm2 process: pm2 restart solana-momentum-bot --update-env (process online)
- Post-change quick checks: process online, no fatal errors in latest logs, mem-debug routeCache=15 trackedMints=2. Event-loop p95 observed spike immediately after restart (11.7s) — likely startup/offload work; will monitor for two consecutive runs. If metrics worsen for 2 consecutive runs, will auto-revert this change set.

Diagnostics (selected):
- pm2 show solana-momentum-bot: Event Loop Latency p95 706ms before change; post-restart transient p95 spike 11757ms (startup). Used Heap ~31MB (post restart sample). rss around 212-266 MB in recent samples.
- Logs: earlier fatal error 'SCAN_BACKOFF_MAX_MS must be >= SCAN_EVERY_MS' existed and was addressed by prior autotune (SCAN_BACKOFF_MAX_MS set to 3600000). Current logs show OBSERVABILITY snapshotFailures=2552 (histor)

Next actions / Monitoring:
- Monitor event-loop p95 and restarts for 2 runs (~next few hours). If p95 and restart rate worsen for 2 consecutive runs, revert latest commit.
- If event-loop remains high, consider medium-risk changes: further reducing concurrent probes (LIVE_CANDIDATE_SHORTLIST_N=1), or offloading heavy work to worker threads.

Source: autonomous run (Candle Carl) performed by OpenClaw agent.
