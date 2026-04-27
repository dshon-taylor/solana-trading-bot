2026-04-27 - candle-carl run (cron:1aa80c6e-ec2c-4269-8798-e6babf486a73)
- Added TELEGRAM_RETRY_MS=60000 and TELEGRAM_MAX_RETRIES=3 to .env.candle_carl to reduce tight retry loops when Telegram is misconfigured.
- Restarted solana-momentum-bot to apply env changes. Commit afa065f (local).
- No code changes to trading logic.

Metrics before:
- Duplicate pm2 process observed; EADDRINUSE on port 8787 previously reported.
- Event loop p95 observed up to ~3966ms in recent run logs.
- Telegram API returned 404s repeatedly (likely invalid token / endpoint).

Metrics after:
- Single pm2 process online (id 17), memory ~35-130MB after restarts, CPU transient spikes during restart only.
- TELEGRAM_DISABLED=true present; runtime skips sends.

Recommended human actions:
- Validate TELEGRAM_BOT_TOKEN and re-enable if desired.
- Run profiling during load to identify event-loop blockers.
