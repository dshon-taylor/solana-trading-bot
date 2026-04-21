2026-04-21 - Candle Carl autotune

Applied low-risk changes:
- Added fetchWithRetry helper in src/control_tower/runtime_helpers/index.mjs to help with transient network failures.
- Added startup env warning logging in server.js to surface missing critical environment variables.

Rationale: reduce transient fetch failures causing shutdowns and provide clearer startup diagnostics for missing keys. These are small, non-destructive changes; further refactors (replacing fetch calls, heap snapshotting) recommended as medium-risk work.
