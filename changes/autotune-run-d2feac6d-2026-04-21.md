run_id: d2feac6d-b989-43b5-94f4-edeb3232011e
timestamp_ct: 2026-04-21T00:08:00-05:00
changes:
  - WATCHLIST_EVAL_EVERY_MS: 3000 -> 4000 (low-risk)  # reduce eval frequency to lower provider pressure
  - WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE: 8 -> 6 (low-risk)  # lower immediate routing concurrency
  - BIRDEYE_WS_FALLBACK_POLL_MS: 5000 -> 10000 (low-risk)  # slow fallback polling to reduce RPC calls
reason: Reduce provider/RPC and websocket fallback pressure after repeated birdeye-ws closures and fetch failures observed in logs. Applied within low-risk tuning budget.
validation: Restarted process and confirmed online state; monitored logs for immediate errors.
notes: .env is gitignored; changes applied to runtime .env file. If you want these tracked in VCS, move to a tracked env template or document in CHANGES_AUTOTUNE.md
