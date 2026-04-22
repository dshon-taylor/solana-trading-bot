2026-04-22 UTC - Candle Carl autonomous optimization cycle (cron:9c7e0c0c-bf4f-4a7a-a4b4-54a4ec7748b6)

Actions taken:
- Collected diagnostics: PM2 process checks, pm2 show, logs, mem-debug output.
- Dominant bottlenecks: intermittent RSS spikes (~400+MB), high restart count historically (462->463), and potential FD/WS subscription pressure from BirdEye WS and frequent watchlist eval cadence.
- Applied low-risk changes (2):
  1) ecosystem.config.cjs: WATCHLIST_EVAL_EVERY_MS 60000 -> 120000 (reduce eval frequency)
  2) ecosystem.config.cjs: BIRDEYE_WS_MAX_SUBS 12 -> 8 (reduce max websocket subscriptions)
- Committed and pushed changes: branch main, commit adbb8bb (autotune: lower watchlist eval frequency and reduce WS subs (low-risk)).
- Restarted process via PM2 with --update-env; restart succeeded and process is online (restarts incremented).

Notes/observations:
- Bot logs show earlier startup validation errors for missing HELIUS_API_KEY and KEYPAIR_PATH; current .env contains HELIUS_API_KEY and KEYPAIR_PATH. PM2 is configured to load env_file; after restart process started cleanly (no new missing-env fatal errors observed in recent logs).
- Health endpoint on configured HEALTH_PORT (8787) did not respond to local curl during this run (connection refused). The process exposes code-metrics via pm2 and logs show boot/config output; further investigation recommended if health endpoint is required.

Next steps/recommendations:
- Monitor RSS over next 24-48h for improvement. If resource pressure persists, consider further conservative tuning: increase WATCHLIST_EVAL_EVERY_MS more, reduce WATCHLIST_MAX_SIZE, or move BirdEye WS to a separate worker (medium-risk; requires architecture change).
- If health endpoint remains unreachable, run targeted diagnostic for the health server binding and firewall (or check process' internal health server config).

Revert scheduled: no revert scheduled. Will auto-revert if metrics worsen for 2 consecutive runs as per policy.
