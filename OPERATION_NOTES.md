2026-04-26 - Candle Carl run summary
- PM2-managed solana-momentum-bot restarted to apply current env.
- Historical errors seen: BIRDEYE_LITE_ENABLED without BIRDEYE_API_KEY and SCAN_BACKOFF_MAX_MS < SCAN_EVERY_MS causing fatal exits (logs from 2026-04-24). Current env sets BIRDEYE_LITE_ENABLED=false and SCAN_BACKOFF_MAX_MS >= SCAN_EVERY_MS.
- No code changes made. Monitor restart count and fatal errors; if restarts continue to spike, consider investigating unstable restarts and increasing min_uptime or adjusting restart policy.

2026-04-26 21:17Z - Autonomous run: applied PM2 env update (TELEGRAM_DISABLED=true, placeholder token) and restarted solana-momentum-bot with ecosystem config. Observed reduced CPU; continue monitoring for Telegram 404s.

2026-04-27 02:18 UTC - Autotune
- Applied low-risk tuning changes: reduced logging verbosity, increased websocket stale threshold (BIRDEYE_WS_STALE_MS=1500), set LOG_LEVEL=warn; committed diagnostics and docs.
- Restarted via pm2 restart solana-momentum-bot --update-env and verified process online. Monitor event-loop p95 and restart count for regressions.
2026-04-27T04:09Z - Autonomous Candle Carl run: diagnostics collected; reasoning: dominant bottleneck likely WS subscription bursts and memory/RSS spikes causing repeated restarts and snapshotFailures. Actions: (low-risk) set max_memory_restart=700M, increased WATCHLIST_EVAL_EVERY_MS to 600000 (10m), set BIRDEYE_WS_MAX_SUBS=1 and BIRDEYE_WS_HOT_CAP=1, set TELEGRAM_DISABLED=true placeholder; committed local branch. Restarted pm2 solana-momentum-bot --update-env; process online and env verified (max_memory_restart=734003200, WATCHLIST_EVAL_EVERY_MS=600000, BIRDEYE_WS_MAX_SUBS=1). Next: monitor for regressions; revert if metrics worsen for 2 consecutive runs.
