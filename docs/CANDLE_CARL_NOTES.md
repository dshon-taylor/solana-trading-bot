Candle Carl — autonomous optimization notes (2026-04-25)

Summary:
- Collected runtime diagnostics; found snapshotFailures high (2438), activeRunners=0, entries/hour≈0.
- Observed config/autotune_overrides.json present (rps=4, scanEveryMs=30000) but not reflected in effective runtime config (rps=1, scanEveryMs=900000).
- Likely cause: process not reloaded with updated env/config or runtime not loading autotune_overrides.json.

Action items:
- Confirm pm2 restart with --update-env to ensure .env.* is reloaded.
- If overrides still not applied, add explicit loading of config/autotune_overrides.json in boot path (low-risk patch: read and merge on startup).
- Monitor snapshotFailures and activeRunners; aim to reduce snapshotFailures below 100 within next 24h before enabling execution=true.

Notes:
- No high-risk changes applied during this run. Restart executed and notes committed.
