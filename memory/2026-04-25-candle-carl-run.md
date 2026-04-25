2026-04-25T04:18Z Candle Carl autonomous run
- Diagnostics: snapshotFailures=~2354, entries/hour≈0, activeRunners=0, execution disabled (modes), restarts historically high (≈697), event-loop p95 spikes observed
- Changes applied (low-risk): SOURCE_RPS increased 1→2, SCAN_EVERY_MS bumped to 900000, LIVE_PROBE_MAX_CANDIDATES set 0 (reduce probe fanout)
- Rationale: reduce snapshot failures and memory/event-loop spikes by small concurrency and polling adjustments; lower probe fanout to reduce memory
- Actions: committed and pushed branch tune/candle-carl-autotune-2026-04-23 (commit 38fc571e)
- PM2 restart executed: pm2 restart solana-momentum-bot --update-env; process online
- Verification: env SOURCE_RPS=2, LOG_LEVEL=warn present; pm2 showing process online; event-loop p95 spike during restart (transient)
- Next: monitor snapshotFailures & activeRunners over next cycles; if metrics worsen for 2 consecutive runs, will auto-revert latest change set
