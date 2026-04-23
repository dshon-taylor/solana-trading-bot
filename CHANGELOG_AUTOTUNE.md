2026-04-23 - Candle Carl autonomous autotune
- Reduced node --max-old-space-size from 2048 -> 1536 (low-risk)
- Lowered PM2 max_memory_restart from 1024M -> 800M (low-risk)
- Increased BIRDEYE_SUB_POLL_MS from 15s -> 30s to reduce poll frequency (low-risk)
- Commit: c86e57a
- Notes: pm2 startOrReload applied changes; push failed (no remote). Monitor for regressions.
