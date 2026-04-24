2026-04-24 — Candle Carl autonomous tuning
- Increased HOT_MONITOR_MS_MIN to 12000 and HOT_MONITOR_MS_MAX to 20000 to reduce CPU and I/O.
- Reduced MAX_WS_CONNECTIONS to 2 to lower websocket load.
- Set LOG_LEVEL=warn to reduce log noise.
- Disabled BIRDEYE_LITE_ENABLED by default when API key absent to prevent startup fatal errors.
Notes: These are low-risk changes; monitor behavior for two runs and revert on degradation.
autotune: applied low-risk reliability fixes (disable BIRDEYE_LITE if missing key; lower WS subs; increase cadence; cap new entries). See memory/2026-04-24_candle_carl_autotune_run.md
