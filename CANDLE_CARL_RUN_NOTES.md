2026-04-26: Tuned env to fix scan backoff timing mismatch.
- SCAN_BACKOFF_MAX_MS set to 1200000 (previously 600000) to be >= SCAN_EVERY_MS (900000).
- Reason: startup fatal validation 'SCAN_BACKOFF_MAX_MS must be >= SCAN_EVERY_MS' observed in logs (2026-04-24).
- Restarted pm2 solana-momentum-bot; verified online and stable logs.
- Commit: e4a38c8 (local)

2026-04-26 (autonomous Candle Carl run - cron:237be506-4155-45f4-9f38-b32630d6d887): low-risk tunings applied
- WATCHLIST_EVAL_EVERY_MS -> 600000 (10m)
- BIRDEYE_WS_MAX_SUBS -> 1
- BIRDEYE_WS_HOT_CAP -> 1
- Committed to branch tune/candle-carl-autotune-2026-04-23 (commit 43e1f22)
- PM2 restarted with --update-env and ecosystem reload; `solana-momentum-bot` reported online; verified env values via `pm2 env`.
- Follow-up: monitor for 2 consecutive degraded runs to auto-revert if needed.
