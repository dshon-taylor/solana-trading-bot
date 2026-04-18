2026-04-18T14:01Z Autonomous run: Candle Carl optimization cycle
- Action: Implemented low-risk retry/backoff for tgSetMyCommands in src/telegram/index.mjs to reduce transient `fetch failed` errors observed in logs.
- Commits: 22eac43e71dc0495618b836861b684432e07d56c (pushed to main)
- PM2: restarted solana-momentum-bot with --update-env; process online (pid updated) and HEALTH_PORT present in env.
- Reasoning: frequent transient fetch failures were producing noisy logs but not crashing the bot. Adding small retries with abort timeouts reduces noise and improves resilience without changing runtime architecture.
- Tests: verified PM2 status, tail of logs; no crash observed after restart (short window).
2026-04-18T21:31Z Autonomous run: Candle Carl optimization cycle
- Action: Increased PRECHECK_REPEAT_FAIL_COOLDOWN_SEC from 90 → 180 (low-risk env override) to reduce momentumRepeatFail counts.
- Commits: env change committed locally in trading-bot (may be unpushed). See diagnostics/autotune_snapshot_2026-04-18T09-31-00Z.txt for details.
- PM2: restarted solana-momentum-bot with --update-env; process online and stable.
- Tests: quick smoke checks passed (PM2 online, no crashes); unit test suite skipped in cron (long-running).
- Next: monitor momentumRepeatFail for 2 runs; if metrics worsen for 2 consecutive runs, auto-revert.
