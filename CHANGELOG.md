2026-04-24 - tune/candle-carl-2026-04-23 (d42e683)
- Lowered PM2 max_memory_restart from 768M -> 512M (to reduce memory pressure and force controlled restarts).
- Increased LOG_LEVEL from error -> warn to capture additional diagnostics while remaining conservative.

Notes: These are low-risk tuning changes made during an autonomous optimization cycle. Monitor snapshotFailures and entries/hour metrics; revert if system metrics degrade.
### Candle Carl autonomous changes (2026-04-27)
- WATCHLIST_EVAL_EVERY_MS -> 1200000
- ROUTE_CACHE_MAX_SIZE -> 512
- SCAN_BACKOFF_MAX_MS -> 3600000 (fix startup)
