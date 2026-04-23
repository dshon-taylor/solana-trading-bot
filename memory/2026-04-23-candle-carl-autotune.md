2026-04-23 14:01 UTC — Autonomous Candle Carl run
- Diagnostics: high RSS/heap spikes observed (peak RSS ~1118MB, heap usage high, event-loop p95 up to 311ms). Frequent historical restarts recorded (restats>500).
- Actions: reduced Node.js max-old-space-size from 4096 -> 2048 in ecosystem.config.cjs (low-risk cap to limit memory pressure). Committed and pushed to branch tune/candle-carl-autotune-2026-04-22 (commit dccb65b495f0).
- PM2: restarted process with --update-env and reloaded ecosystem; new Node flags applied. Post-change metrics improved: heap usage down (Used Heap Size ~50MiB, Heap Usage ~66%), event-loop p95 lowered to ~7ms.
- Notes: TELEGRAM_DISABLED confirmed=true (prevents repeated Telegram 404 errors). No functional changes to staged architecture.
- Next: monitor metrics for 24-48h; if metrics worsen for 2 consecutive runs revert change set.

Commit: https://github.com/dshon-taylor/solana-trading-bot/commit/dccb65b495f044f004dbc2b7e8ef5f85350c4dd0
PM2 logs: /home/dshontaylor/.pm2/logs/solana-momentum-bot-*.log
