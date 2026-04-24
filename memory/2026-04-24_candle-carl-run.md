2026-04-24 15:17 UTC - Candle Carl autonomous optimization cycle
- Diagnostics: PM2 reports solana-momentum-bot online (pid 3789458), restarts=661, uptime=29m. Heap usage ~61.9%, event-loop p95=437.99ms.
- Recent fatal errors (historical): BIRDEYE_LITE_ENABLED=true without API key (older runs); SCAN_BACKOFF_MAX_MS < SCAN_EVERY_MS errors earlier in the day. Current .env shows BIRDEYE_LITE_ENABLED=false and SCAN_BACKOFF_MAX_MS=1200000, SCAN_EVERY_MS=600000.
- Memory: RSS fluctuating ~450-686 MB; occasional spikes to ~686 MB observed around 15:08.
- Observability: entries/hour≈0, snapshotFailures~1790, activeRunners=0.
Actions taken:
- No code changes applied. Performed safe operational cycle: collected diagnostics, validated env, committed run notes, restarted process with pm2 restart --update-env, and verified online state.
- No revert scheduled.
Notes/Recommendations:
- Investigate snapshotFailures and why activeRunners=0 (possible feature flags disabled or upstream data sources quiet).
- Keep BIRDEYE_LITE disabled unless API key present to avoid startup assertion.
- Consider adding lightweight heap sampling on schedule to track memory growth if RSS spikes recur.
