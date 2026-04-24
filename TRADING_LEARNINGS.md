2026-04-24 — Candle Carl autotune notes
- Root cause: intermittent startup fatals caused by mismatched environment toggles (BIRDEYE_LITE_ENABLED true without API key) and validation rule (SCAN_BACKOFF_MAX_MS < SCAN_EVERY_MS).
- Fix applied: enforce conservative defaults in ecosystem.config.cjs to avoid requiring external keys and to keep SCAN_BACKOFF >= SCAN_EVERY.
- Rationale: low-risk runtime defaults reduce crash-looping and prevent accidental external fetch attempts. Preserve staging architecture and avoid changing runtime behaviour beyond safety defaults.
- Monitoring: watch pm2 restarts and fatal/error logs for recurrence; consider adding runtime validation with clearer logging if issue returns.

Autotune 2026-04-24 actions:
- Increased node --max-old-space-size to 2048 and max_memory_restart to 700M (low-risk) in ecosystem.config.cjs.
- Restarted process with pm2 restart --update-env and verified process is online.
- Commit created locally; no remote push configured.
