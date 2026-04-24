run_id: 060ed2a1-c95b-4634-b7d5-3c4fb2abd0dc
timestamp_ct: 2026-04-24 10:09:04 CDT
actions:
  - identified dominant bottlenecks: high snapshotFailures (~2000), entries/hour≈0, activeRunners=0, earlier fatal validation errors in logs (BIRDEYE_LITE_ENABLED and SCAN_BACKOFF mismatch) now resolved by env defaults.
  - low-risk changes applied:
    - lowered WATCHLIST_EVAL_EVERY_MS from 1200000 to 120000 (increase eval frequency)
    - set LOG_LEVEL from warn to info (increase observability)
  - files edited: trading-bot/.env, trading-bot/ecosystem.config.cjs
  - git: committed changes on branch tune/candle-carl-2026-04-23 (commit e6faf8afd3e80cb85a1c4cd67a11b85c068062d0)
  - pm2: restarted solana-momentum-bot with --update-env; verified pm2 env shows WATCHLIST_EVAL_EVERY_MS=120000 and LOG_LEVEL=info
notes:
  - attempted to fetch /diag endpoints on 127.0.0.1:8080 but connection refused; health endpoint on 8787 also unreachable
  - PM2 logs indicate snapshotFailures ~2000 and entries/hour≈0; memory usage ~400MB RSS; event-loop p95 ~537ms earlier
next_steps:
  - monitor metrics for next 2 runs; if metrics worsen for 2 consecutive runs, auto-revert latest change set
  - consider enabling health port in code or confirm which diagnostics endpoints are exposed; user approval required before more invasive changes
status: changes applied (low-risk).