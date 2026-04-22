2026-04-22 UTC - Candle Carl autonomous optimization

Diagnostics collected:
- pm2 jlist / pm2 show / pm2 logs captured. solana-momentum-bot status: online (pm2 id 10) but high event-loop p95 observed (≈4.8s) and repeated `telegram.commands` fetch failures in error log.
- PM2 env shows KEYPAIR_PATH and TELEGRAM_DISABLED=true.

Reasoning / bottlenecks:
- High event-loop p95 indicates periodic blocking work (watchlist evaluation / birdeye WS handling) causing latency spikes and CPU bursts.
- Repeated `fetch failed` from telegram likely from disabled/unhandled commands; TELEGRAM_DISABLED already true but leaving safer to ensure no outbound fetches.

Changes applied (risk budget: 2 low-risk changes):
1) Increased WATCHLIST_EVAL_EVERY_MS from 6000 -> 12000 to reduce eval frequency and event-loop pressure.
2) Reduced BIRDEYE_WS_MAX_SUBS default from 150 -> 100 to limit WS fanout.
- Committed: 97476c2
- Pushed to origin/main

Actions performed:
- Edited trading-bot/ecosystem.config.cjs and committed with message: "ops: lower runtime watchlist eval frequency and reduce birdeye ws subs to lower event-loop pressure (autotune)"
- Restarted process: pm2 restart solana-momentum-bot --update-env (fell back to restart if unsupported).
- Verified process online and environment (KEYPAIR_PATH, TELEGRAM_DISABLED) present.

Follow-ups / monitoring:
- Monitor event-loop p95 and CPU over next 2 runs. If metrics worsen for 2 consecutive runs after this change set, auto-revert latest change set (not scheduled automatically in this run).
- If fetch errors persist, investigate remaining telegram command handlers.

Notes: non-destructive, preserves staged architecture.
