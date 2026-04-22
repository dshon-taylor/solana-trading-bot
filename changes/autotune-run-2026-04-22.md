2026-04-22 Candle Carl autonomous autotune run
Branch: tune/candle-carl-autotune-2026-04-22
Changes:
- BIRDEYE_WS_MAX_SUBS: 12 -> 8
- WATCHLIST_EVAL_EVERY_MS: 120000 -> 180000
- LIVE_CANDIDATE_SHORTLIST_N: 6 -> 4
Rationale: Conservative low-risk tunings to reduce file descriptor / websocket and CPU/memory pressure observed in recent runs (high restart count, RSS spikes to ~400-500MB). Preserve staged architecture.
Actions:
- Edited .env and committed on branch tune/candle-carl-autotune-2026-04-22
- Restarted pm2 solana-momentum-bot with --update-env
Status:
- Process online after restart. PM2 env shows BIRDEYE_WS_MAX_SUBS=8 and LIVE_CANDIDATE_SHORTLIST_N=4; WATCHLIST_EVAL_EVERY_MS still reported as 120000 by pm2 env (possible env duplication or pm2 caching) though .env contains 180000.
- Monitoring required: revert scheduled? No (will auto-revert if metrics worsen for 2 consecutive runs after change set).
Notes:
- If WATCHLIST_EVAL_EVERY_MS does not apply, we may need to ensure no duplicate variable is exported in pm2 ecosystem or systemd service; consider pm2 delete & start to force env reload if needed.
