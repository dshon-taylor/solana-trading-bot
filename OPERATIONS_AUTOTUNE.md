Autonomous tuning applied 2026-04-23 by Candle Carl:
- ROUTE_CACHE_MAX_SIZE=256
- WATCHLIST_HOT_QUEUE_MAX=12
Rationale: reduce in-process memory usage and event-loop latency by limiting route cache size and capping hot-queue depth. Applied as low-risk tuning; no architectural changes.
Monitoring: check diagnostics/pm2_out_tail_fresh.log and diagnostics/pm2_show_fresh.log for memory and restart counts in next runs.

2026-04-23T23:11Z - addendum:
- Applied low-risk conversion concurrency overrides (pairFetchConcurrency=3, fanoutN=2, shortlistN=12) via config/autotune_overrides.json. Restarted solana-momentum-bot with --update-env; process online. Monitor for two runs; revert if metrics worsen for two consecutive runs.
