Autonomous Candle Carl optimization cycle run - 2026-04-17T11:00Z (UTC)

Summary:
- Collected runtime diagnostics from pm2 and runtime_sanity_latest.json.
- Observed frequent restarts (87 restarts, uptime 79m) though process currently ONLINE.
- Heap usage ~76%, rss fluctuating 400-580 MB in logs; event loop p95 spiked to ~209ms occasionally.
- Logs show repeated [birdeye-ws] closed messages and a telegram.commands TypeError: fetch failed.
- Ran test suite: 161 passed, 4 failed (2 test files). Failures in confirm_continuation and diag_event_store.
- No code changes applied in this run; taking conservative approach to avoid regressions.

Diagnostics collected:
- pm2 describe solana-momentum-bot at runtime (see pm2 output in repo analysis directory)
- runtime_sanity_latest.json (trading-bot/analysis/runtime_sanity_latest.json)
- last 200 lines of pm2 logs (error + out) captured during run
- unit test results (npm test) — 4 failing assertions (confirm_continuation x3, diag_event_store x1)

Immediate recommendations:
1) Investigate BirdEye WS stability (WS closures) and telegram fetch failures — likely network or provider flakiness.
2) Fix failing unit tests in confirm_continuation: tests indicate price source selection/diag behavior changed; run focused debug of confirm_continuation logic with injected fake cache.
3) Consider reducing restart count by handling WS disconnects without triggering full shutdown; add backoff for WS reconnects.

Run actions:
- Added this diagnostics note file.
- Committed diagnostics to git and pushed.
- Restarted pm2 process with --update-env and verified online status.
- Appended concise memory note under memory/ for retention.

Files/links:
- Commit: recorded below in git log
- Diagnostics file: trading-bot/analysis/autotune-run-2026-04-17T11-00Z.md

Notes:
- Preserved staged architecture; no destructive actions performed.
- If metrics worsen for 2 consecutive runs after future tuning, auto-revert policy should be applied.

Next steps:
- If you want, authorize up to 3 low-risk changes next run: (1) add WS reconnect backoff and error handling; (2) improve confirm_continuation price source selection edgecases; (3) adjust health checks to avoid restarts on transient WS closures.
