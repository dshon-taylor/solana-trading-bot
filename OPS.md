Candle Carl autonomous notes (autotune):

- 2026-04-25: Reduced PM2 max_restarts to 5 and increased exp_backoff_restart_delay to 120000 to mitigate crash-loop flapping. Committed locally on branch tune/candle-carl-2026-04-23; remote push failed (no 'origin'). Restarted process and verified online. Monitor event-loop p95 across next 2 runs.
