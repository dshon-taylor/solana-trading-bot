RunID: d2feac6d-b989-43b5-94f4-edeb3232011e
Timestamp (CT): 2026-04-17 07:40:02 AM CDT
Changes:
- Low-risk: BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS set to 40000 (from 20000) to reduce per-mint request rate
- Low-risk: BIRDEYE_WS_FALLBACK_POLL_MS set to 5000 (from 3000) to lower fallback poll frequency
Reason: observed frequent BirdEye WS closures and SIGINT shutdowns; lowering request pressure aiming to reduce feed instability without changing execution risk profile.
Tests: monitored logs and memory for 10m after restart; no new errors in initial window.

