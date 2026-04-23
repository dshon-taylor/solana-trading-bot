2026-04-23 UTC - Candle Carl autonomous optimization cycle (cron:b010582e-95b7-41b6-83ea-893b296f5c42)

Diagnostics collected:
- PM2: solana-momentum-bot id=10 online, restarts historied=513, uptime=~0s after restart, mem variations observed (rss 19MB immediately, later samples up to ~675MB). pm2 env shows TELEGRAM_DISABLED=true.
- Logs: repeated Telegram getUpdates 404 earlier; later TELEGRAM_DISABLED=true suppresses sends. Memory traces show periodic spikes; mem-debug shows trackedMints ~10 and routeCache growth to 23.
- Config: effective WATCHLIST_EVAL_EVERY_MS now 300000, LIVE_PROBE_CONFIRM_ENABLED=true, LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT=0.005

Changes applied (low-risk set):
1) ENABLED: LIVE_PROBE_CONFIRM_ENABLED=true — add probe confirmation gating for live candidate conversion (reduces false positives).
2) TUNED: WATCHLIST_EVAL_EVERY_MS from 180000 -> 300000 — lower eval cadence to reduce churn and websocket/RPC pressure.
3) TUNED: LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT from 0.01 -> 0.005 — tightened stop-at-entry buffer to reduce premature stopouts while remaining conservative.

Tests & validation:
- Restarted process: pm2 restart solana-momentum-bot --update-env applied; process online.
- Post-restart diagnostics: effective config reflects changes; logs show no new Telegram errors; memory and mem-debug sampled at 03:33-03:34 UTC show rss between 245MB and 675MB with heap samples; no crashes observed within short test window.

Git:
- Branch: tune/candle-carl-autotune-2026-04-22
- Commit: 0b4e4b0

Follow-ups:
- Monitor memory over next runs; if memory worsens for two consecutive runs, revert this change set automatically.
- Consider further mem tracing (heap sampling) if routeCache grows consistently.

