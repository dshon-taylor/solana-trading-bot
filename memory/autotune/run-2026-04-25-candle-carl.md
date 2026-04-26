2026-04-25T23:19:30Z - Candle Carl autonomous optimization cycle
- Actions:
  - Collected diagnostics: pm2 status, pm2 logs, pm2 env, trading-bot analysis files
  - Reasoned dominant bottleneck: high snapshotFailures (2498) and entries/hour≈0; activeRunners=0. Likely snapshot provider delays or snapshot age/timeouts causing zero new entries.
  - Applied low-risk changes (3 total limit):
    1) Edited trading-bot/.env.candle_carl: added ROUTE_CACHE_TTL_MS=120000, ROUTE_CACHE_MAX_SIZE=512, CONFIRM_MAX_SNAPSHOT_AGE_MS=8000 (autotune overrides)
    2) Appended same adjustments to trading-bot/.env so pm2 env loader picks them up; committed changes on branch tune/candle-carl-autotune-2026-04-23.
  - Git: committed two commits: 
    - af97652: "candle_carl: low-risk tuning — increase route cache TTL & size; relax confirm snapshot age to reduce snapshotFailures (autonomous run 2026-04-25)" (modified .env.candle_carl)
    - 17cfb54: "autotune(2026-04-25): apply Candle Carl low-risk route cache + confirm snapshot age adjustments" (modified .env)
  - Restart: ran `pm2 restart solana-momentum-bot --update-env` (fallback to restart); restart succeeded and process is online.
- Verification:
  - Process status: online (pm2 id 10). PID updated.
  - Environment present: KEYPAIR, RPC endpoints, TELEGRAM_DISABLED=true confirmed via `pm2 env 10`.
  - Post-change metrics (immediate): snapshotFailures still ≈2498, entries/hour≈0. No immediate improvement yet.
- Next steps / notes:
  - Monitor entries/hour and snapshotFailures for 2 cycles (scanEveryMs intervals). If metrics worsen for 2 consecutive runs after change set, auto-revert will be triggered (not scheduled yet).
  - Likely further steps: investigate snapshot provider connectivity (Helius / RPC), inspect canary_trace.jsonl for snapshot failures, consider increasing provider RPS or enabling alternate RPC endpoints if failures persist (medium risk).
