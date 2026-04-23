2026-04-22T07:17Z Candle Carl autotune
- Increased WATCHLIST_EVAL_EVERY_MS -> 20000 and reduced BIRDEYE_WS_MAX_SUBS -> 60 in trading-bot/ecosystem.config.cjs (low-risk).
- Reloaded with pm2 startOrReload and restarted; process online and metrics improved (heap usage ~65%, RSS 200-330MB observed).
- Commit: autonomous/candle-carl-20260422010451 639e8a9 (local). Remote push not available (no origin configured).
- If memory or unstable_restarts regress for 2 consecutive runs, revert this commit.
