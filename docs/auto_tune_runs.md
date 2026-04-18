# Autonomous optimization runs (Candle Carl)

2026-04-17T17:00 UTC — run notes
- Collected PM2 status and last 300 lines of logs; saw frequent Birdeye WS closures and telegram fetch failures.
- No code changes applied. Performed pm2 restart --update-env to refresh environment and clear transient state.
- Dominant issues to address in future runs: Birdeye websocket resiliency (reconnect/backoff/fallback), fetch retry hardening, monitor/limit heap growth.
- Recommendation for next run: apply up to 3 low-risk changes: increase BIRDEYE_WS_FALLBACK_POLL_MS, tune reconnect/backoff, add retry wrapper to telegram fetch calls.
