# BirdEye WS

This runbook documents new env vars and subscription behavior for the BirdEye WebSocket migration.

Env vars added:
- BIRDEYE_WS_URL: WebSocket endpoint used for live updates (default in .env.example)
- BIRDEYE_MAX_WS_CONNECTIONS: Max concurrent WS subscriptions (default 200)
- BIRDEYE_LITE_CACHE_TTL_MS: TTL for lite snapshot cache updates (default 45000)
- BIRDEYE_PER_MINT_MIN_INTERVAL_MS: Minimum interval between updates per mint (default 25000)

Subscription model:
- The WS manager subscribes only to mints in HOT queue, TOP_N_HOT candidates, and active positions.
- When WS is available it is preferred; REST is used as fallback for cache misses or confirmation stages.
- The manager exposes subscribe(mint), unsubscribe(mint), getStatus(), and emits 'event' for incoming data.
