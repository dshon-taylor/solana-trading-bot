2026-04-23: Disabled Birdeye WS subscriptions to reduce memory and websocket pressure during autonomous tuning run.
- Branch: tune/candle-carl-2026-04-23
- Commit: 154ecc2
- Env changes: BIRDEYE_WS_ENABLED=false, BIRDEYE_WS_MAX_SUBS=0 added to .env.candle_carl
- Rationale: observed memory RSS spikes up to ~900MB and frequent WS activity; disabling reduces connections and memory overhead.
- Next: monitor memory and routeCache; if memory increases on two consecutive runs, revert.

2026-04-23 07:01 UTC — Autonomous run summary: collected diagnostics (pm2 show, logs, env); observed RSS up to 751MB and heap usage spikes. PM2 env shows max_memory_restart=4294967296 (4GB). TELEGRAM_DISABLED=true — Telegram 404s are suppressed. Committed diagnostics to memory/2026-04-23-candle-carl-run.txt. No runtime config changes applied in this run; recommended follow-up: monitor, consider raising restart threshold or capture heapdump if memory trend continues.
