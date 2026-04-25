2026-04-25 06:27 UTC - Candle Carl autonomous optimization cycle run

Summary:
- Diagnostics: solana-momentum-bot was at 100% CPU and showing OBSERVABILITY entries/hour≈0 with snapshotFailures≈2426 and activeRunners=0. PM2 reported many restarts and high heap usage/event-loop latency p95 ≈ 777ms.
- Reasoning: dominant bottleneck appeared to be high snapshotFailures and heavy scan/processing pressure causing CPU and memory spikes and keeping active runners at 0 (no entries processed). Likely caused by external snapshot/source pressure + configuration drift (running process had older env values).

Actions taken (low-risk):
1) Collected runtime diagnostics (pm2 status, pm2 show, recent pm2 logs, pm2 env). Confirmed effective config shows sources.rps=1 and scan cadence large (scanEveryMs=900000).
2) Restarted solana-momentum-bot with --update-env to ensure .env changes from autonomous tuning are picked up by the running process.

Result:
- Process restarted successfully and returned to online state with CPU usage back to normal (~0-1%). Logs now show effective config: sources.rps=1, routeCache maxSize=512, scanEveryMs=900000, max_new_entries_per_hour=1, and activeRunners still 0 (expected until next scan cycle).

Follow-ups / recommendations:
- Monitor OBSERVABILITY (entries/hour) next 2 runs. If metrics worsen for 2 consecutive runs after this restart, revert the last change set (rollback .env to previous) and alert.
- Consider instrumenting snapshot failure reasons (HTTP 4xx/5xx vs timeouts) to determine whether external provider (helius/jupiter) is rate-limited or misconfigured.

No code changes were made. No git commit required.

Automated run metadata:
- cron job id: 993f7e48-fbff-4254-9de7-982e65299a22
- runner: Candle Carl autonomous cycle
- timestamp: 2026-04-25T06:27:00Z
