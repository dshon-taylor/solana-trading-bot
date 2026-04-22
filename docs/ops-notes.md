2026-04-22 - Autotune: lowered websocket pressure
- Disabled BIRDEYE_WS_ENABLED (false)
- Increased WATCHLIST_EVAL_EVERY_MS to 600000 (10m)
- Reduced BIRDEYE_WS_MAX_SUBS to 2
Rationale: observed high RSS and many restarts linked to websocket subscriptions and frequent watchlist evaluation. These are temporary low-risk mitigations.
