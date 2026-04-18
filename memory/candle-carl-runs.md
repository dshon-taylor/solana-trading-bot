2026-04-18T14:01Z Autonomous run: Candle Carl optimization cycle
- Action: Implemented low-risk retry/backoff for tgSetMyCommands in src/telegram/index.mjs to reduce transient `fetch failed` errors observed in logs.
- Commits: 22eac43e71dc0495618b836861b684432e07d56c (pushed to main)
- PM2: restarted solana-momentum-bot with --update-env; process online (pid updated) and HEALTH_PORT present in env.
- Reasoning: frequent transient fetch failures were producing noisy logs but not crashing the bot. Adding small retries with abort timeouts reduces noise and improves resilience without changing runtime architecture.
- Tests: verified PM2 status, tail of logs; no crash observed after restart (short window).
