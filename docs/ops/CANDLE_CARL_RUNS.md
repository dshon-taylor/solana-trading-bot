Candle Carl runs - notes

2026-04-24: Conservative runtime defaults applied to reduce WS and watchlist pressure:
- BIRDEYE_WS_ENABLED=false
- BIRDEYE_WS_MAX_SUBS=1
- WATCHLIST_EVAL_EVERY_MS=1200000 (20 minutes)
- BIRDEYE_WS_HOT_CAP=4
- max_memory_restart=768M
- LOG_LEVEL=error

These are low-risk, staged architecture-preserving changes. Monitor memory RSS and restart counts; if performance degrades for two consecutive runs, revert the latest commit.
