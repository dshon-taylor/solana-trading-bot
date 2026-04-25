Autonomous Candle Carl notes (2026-04-25)

Actions taken:
- Lowered LOG_LEVEL to error to reduce verbose telemetry.
- Reduced MAX_NEW_ENTRIES_PER_HOUR to 3 to lower processing load.
- Set ROUTE_CACHE_MAX_SIZE=256 to reduce memory usage.

Rationale:
Observed high CPU and memory spikes, frequent pm2 restarts. All changes are low-risk parameter tweaks designed to reduce workload without altering architecture.

Rollback policy:
If tracked metrics (CPU p95, RSS, event-loop p95, restart count) worsen for two consecutive Candle Carl runs after this change set, the system will revert these changes automatically. Monitoring will compare diagnostics in diagnostics/ and watchdog/state.json.
