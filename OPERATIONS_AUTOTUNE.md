Autotune run (2026-04-22)

Run ID: d2feac6d-b989-43b5-94f4-edeb3232011e-run-2026-04-22T12:10:00-05:00

Summary:
- Reduced maxNewEntriesPerHour from 60 -> 30 to limit new exposure and reduce rate pressure.
- Added debugCanary.enabled=true in config/autotune_overrides.json to increase diagnostic traces (verify precedence).
- Restarted process with pm2.

Why:
- Logs showed repeated startup assertions for missing HELIUS_API_KEY and missing keypair env vars earlier; while currently online, limiting new entries reduces risk if providers degrade.
- Enabling debugCanary aims to collect richer diagnostics for future autotune runs.

Notes:
- After restart effective config shows maxNewEntriesPerHour=30 (change applied) but debugCanary still prints as disabled; likely config precedence is env -> config file. Recommend setting via env or moving flag to effective defaults.
- If metrics (latency, trade success, slippage) worsen for 2 consecutive runs, revert this change set.
