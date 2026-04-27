2026-04-27T01:13:30Z - Candle Carl autonomous run
- Low-risk changes applied to reduce event-loop load and websocket churn:
  - LOG_LEVEL set from warn -> error to reduce logging volume
  - BIRDEYE_WS_STALE_MS increased from 800 -> 5000 to reduce websocket reconnects/stale handling frequency
- Commit: f97d422
- Monitoring: track event-loop p95 and CPU; revert if metrics worsen for two consecutive runs.
