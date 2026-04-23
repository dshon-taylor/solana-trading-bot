# Ops tuning notes

## 2026-04-23 Candle Carl autonomous tuning
- Enabled LIVE_PROBE_CONFIRM_ENABLED=true to add probe confirmation gating and reduce false-positive live entries.
- Increased WATCHLIST_EVAL_EVERY_MS to 300000 to reduce watchlist churn and runtime resource pressure.
- Reduced LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT to 0.005 to tighten stop-at-entry behavior.
- Commit: 0b4e4b0 (branch: tune/candle-carl-autotune-2026-04-22)

