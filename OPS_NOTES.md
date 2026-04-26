2026-04-24 CT - run_id: d2feac6d-b989-43b5-94f4-edeb3232011e
- Runtime env fixes applied (no code changes):
  - BIRDEYE_LITE_ENABLED set to false to avoid fatal when API key missing.
  - SCAN_BACKOFF_MAX_MS set to 1200000 to satisfy requirement SCAN_BACKOFF_MAX_MS >= SCAN_EVERY_MS (600000).
- Actions: pm2 restart solana-momentum-bot --update-env applied after each change.
- Verification: pm2 env confirms values; process online.
- Recommendation: Persist the env changes into .env or PM2 ecosystem if these are desired defaults. Run tests before enabling execution.
\n- 2026-04-26T13:12:07Z — Autonomous Candle Carl run: collected diagnostics; observed high restarts (764) and p95 event-loop latency ~646ms. Applied no code changes; ensured PM2 env tuned: LOG_LEVEL=info, SCAN_BACKOFF_MAX_MS=1200000, BIRDEYE_WS_ENABLED=false; restarted with --update-env. Will monitor for regressions and auto-revert if metrics worsen for 2 consecutive runs.
