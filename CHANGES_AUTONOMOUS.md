2026-04-18 — lowered TOP_N_HOT 4→3 and HOT_LIMIT_PER_MIN 24→18 (low-risk):
- Reason: reduce parallel hot checks and rate pressure seen as momentumRepeatFail and provider strain in logs.
- Deployed: edited config/defaults.js, restarted pm2 solana-momentum-bot with --update-env.
- Monitoring: watch next two Autonomous runs for regressions; will auto-revert if metrics worsen twice in a row.
