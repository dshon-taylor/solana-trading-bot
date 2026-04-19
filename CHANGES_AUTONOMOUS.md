2026-04-18 — lowered TOP_N_HOT 4→3 and HOT_LIMIT_PER_MIN 24→18 (low-risk):
- Reason: reduce parallel hot checks and rate pressure seen as momentumRepeatFail and provider strain in logs.
- Deployed: edited config/defaults.js, restarted pm2 solana-momentum-bot with --update-env.
- Monitoring: watch next two Autonomous runs for regressions; will auto-revert if metrics worsen twice in a row.

2026-04-19T11:09:58Z CT note: lowered MOMENTUM_SCORE_PASS_THRESHOLD 48->46 and MOMENTUM_SCORE_PRE_RUNNER_THRESHOLD 45->43 (run-id d2feac6d)
