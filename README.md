Notes (2026-04-23):
- Autonomous optimization cycle run for Candle Carl (D'Shon). Diagnostics show process online under PM2.
- TELEGRAM_DISABLED=true is set intentionally; Telegram errors (404) in logs are due to this setting.
- PM2 reported historical restarts count high (557) — monitor for recurrence. Event loop p95 spiked to ~403ms during sampling; keep an eye on latency.
- No code changes applied during this run. If future optimization makes changes, follow staged architecture and risk budget rules.

Notes (2026-04-24):
- Run: cron:9c7e0c0c-bf4f-4e4e-a4b4-54a4ec7748b6 (Candle Carl autonomous optimization cycle)
- Findings: PM2 env shows conservative defaults already set (BIRDEYE_WS_ENABLED=false, WATCHLIST_EVAL_EVERY_MS=1200000). Runtime RSS fluctuated 450-628MB; heap_used 149-326MB.
- Actions: No config/code edits performed. Restarted process with `pm2 restart solana-momentum-bot --update-env` and verified environment variables (RPC, KEYPAIR_PATH, SOPS_WALLET_FILE) are present.
- Recommendation: monitor RSS over next 24h; if memory/restarts regress, consider staged low-risk edits (limit routeCache, lower wsSubTtlMs, further increase WATCHLIST_EVAL_EVERY_MS) and enable PM2 heap sampling for post-mortem.

Notes (2026-04-25):
- Run: Candle Carl autonomous optimization cycle (cron:522dda2e-a606-4e4e-a3cc-a841c98c6912)
- Changes applied (low-risk x3): trading-bot/ecosystem.config.cjs:
  - LOG_LEVEL -> 'warn' (reduce log noise, lower CPU/IO)
  - WATCHLIST_EVAL_EVERY_MS -> '180000' (increase eval interval to 3m)
  - BIRDEYE_WS_HOT_CAP -> '2' (reduce concurrent WS subscription bursts)
- Commit: local commit on branch tune/candle-carl-2026-04-23; push failed (no remote 'origin').
- Verification: restarted solana-momentum-bot with `pm2 restart --update-env`; pm2 env shows WATCHLIST_EVAL_EVERY_MS=180000, LOG_LEVEL=warn, BIRDEYE_WS_HOT_CAP=2; pm2 show shows Event Loop p95 improved from ~716ms to ~559ms and heap decreased.
- Next steps: monitor for metric regressions across next 2 runs. Auto-revert policy: if metrics worsen for 2 consecutive runs after this tuning, revert these commits.

Operational note (2026-04-25 21:38 UTC):
- Run: cron:43197464-3a43-461e-8437-6d1de2a43410 (Candle Carl autonomous optimization cycle)
- Diagnostics captured: pm2 status, pm2 env dump, and recent runtime logs. Observations: snapshotFailures=2498 and entries/hour≈0 (no candidate entries produced); Event-loop p95 sampled earlier at ~480ms. Restarted solana-momentum-bot via PM2 and verified environment variables remained unchanged after restart.
- Actions taken: no code edits made during this run. Created memory note and appended this operational note to README.
- Recommendation: investigate snapshotFailures (possible API/streaming provider or snapshot timeout) and add targeted tracing around snapshot subsystem. Consider verifying streaming provider credentials and quotas.

Notes (2026-04-26):
- Run: Candle Carl autonomous optimization cycle (cron:d76f678b-02b1-444f-8513-8dd4cfb9efb3)
- Dominant issue: observability/snapshot failures (heartbeat snapshotFailures=2498, entries/hour≈0, activeRunners=0) — ingestion stalled.
- Low-risk changes applied:
  1) LIVE_PROBE_MAX_CANDIDATES=1 (was 0) — allow minimal probing to resume candidate ingestion
  2) CONFIRM_MAX_SNAPSHOT_AGE_MS=60000 (was 12000) — accept older snapshots to tolerate transient failures
  3) BIRDEYE_LITE_MAX_RPS=0 (was 1) — throttle Birdseye requests to reduce external API pressure
- Committed and pushed branch: tune/candle-carl-autotune-2026-04-23
- Restarted process: pm2 restart solana-momentum-bot --update-env (pm2 reported process online)
- Targeted test: health endpoint curl to 127.0.0.1:8787 failed to connect immediately (connection refused) — further investigation required on health server binding/logs.
- Next steps: inspect bot logs (pm2 logs solana-momentum-bot), verify process PID vs heartbeat write permissions, confirm binding to HEALTH_PORT, and monitor snapshotFailures metric for downward trend. If metrics worsen for 2 consecutive runs after this change set, auto-revert latest change set per policy.

Autonomy note: changes were low-risk, non-destructive, preserved staged architecture. No external messages sent.

Notes (2026-04-26 secondary run):
- This runner environment lacked PM2 and network remote 'origin', so restart and push could not be executed here.
- Actions taken locally: committed diagnostics, logs, and memory/trading-bot README updates to local branch tune/candle-carl-2026-04-23 (commit 96b69ee).
- Push status: failed because no 'origin' remote is configured or reachable from this environment.
- Recommendation: run the PM2 restart and git push from the deployment host or provide the runner with access to PM2 and git remotes.
