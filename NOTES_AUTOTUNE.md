2026-04-25T10:48Z — Autonomous Candle Carl optimization cycle run.
- Diagnostics collected: pm2 status/show/env, recent logs.
- Observations: repeated SIGINTs causing restarts; OBSERVABILITY snapshotFailures=2498, entries/hour≈0.
- Action taken: no code/config changes applied (risk-averse). Performed pm2 restart with --update-env and verified key envs present (RPC, RPC_URL, KEYPAIR_PATH, TELEGRAM_DISABLED, OPENAI_API_KEY).
- Recommendation: investigate source of SIGINTs and snapshotFailures; consider temporarily disabling observability snapshotting if instability continues.
