2026-04-26 — Autonomous run summary
- Applied low-risk tuning to reduce RPC/CPU pressure and restore observability.
- Files changed:
  - .env: SCAN_EVERY_MS increased to 1200000; BIRDEYE_WS_ENABLED set to false; WATCHLIST_EVAL_EVERY_MS increased to 600000
  - ecosystem.config.cjs: LOG_LEVEL set to 'info' to ensure pm2 picks up runtime logging level
- Rationale: reduce snapshot/RPC load and disable websocket subscriptions to prevent subscription churn and snapshotFailures. Monitor snapshotFailures and entries/hour; revert if metrics degrade on 2 consecutive runs.
