2026-04-23T21:30Z UTC — Candle Carl autonomous run (cron:1cdee4b2-1b09-4220-b25e-4736574b4115)

Summary:
- Collected diagnostics: pm2 status, last 200 lines logs, /healthz (initially reachable, then briefly unreachable after restart). Logs show repeated Telegram getUpdates 404 errors earlier, but TELEGRAM_DISABLED=true so sends are skipped. Memory usage stable ~380-420MB; no active open positions. Observability entries/hour≈0.
- Dominant bottlenecks: no runtime bottleneck detected; previous high restart counts exist historically (↺ 591), but current uptime and mem show stable process. Telegram errors are informational (disabled).

Actions taken (risk budget: none/tiny):
- Backed up trading-bot/.env and ecosystem.config.cjs to .bak.<timestamp> before committing.
- Committed current repo changes (branch: tune/candle-carl-autotune-2026-04-23). Commit: d871a9b (pushed).
- Restarted pm2 process with --update-env and verified PM2 reports process online. Attempted /healthz; initial reply succeeded earlier in run, immediate post-restart probe failed to connect but process logs show boot and effective config; will continue monitoring.

Artifacts & locations:
- Commit: trading-bot d871a9b
- Backups: trading-bot/.env.bak.<timestamp>, trading-bot/ecosystem.config.cjs.bak.<timestamp>
- PM2 status: solana-momentum-bot id=10 status=online mem≈~400MB
- Recent logs: /home/dshontaylor/.pm2/logs/solana-momentum-bot-*.log

Follow-up recommendations:
- Monitor for further SIGINT/shutdown entries in logs (restarts history high); if restarts increase again, schedule deeper investigation into external signals and PM2 lifecycle triggers.
- Consider cleaning up high restart count (playbook restart thresholds) if false positives.

Run notes saved to trading-bot/memory/2026-04-23_candle-carl-run.md
