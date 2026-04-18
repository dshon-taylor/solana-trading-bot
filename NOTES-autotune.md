2026-04-17 12:09 CDT - run d2feac6d-b989-43b5-94f4-edeb3232011e
- Observed repeated birdeye WebSocket ('wss://public-api.birdeye.so/socket/solana') closures and Telegram fetch errors ('TypeError: fetch failed').
- No immediate code changes applied. Restarted process via pm2 to restore fresh environment.
- Recommendations for next run (low-risk):
  * Increase BIRDEYE_WATCHLIST_SUB_TTL_MS / BIRDEYE_SUB_TTL_MS from 120000 -> 180000
  * Increase BIRDEYE_WS_FALLBACK_POLL_MS from 3000 -> 5000
  * Harden fetch calls around Telegram (retry-on-fail with backoff) — medium-risk code change, schedule if issues persist.
- If WS closures continue and lead to missed signals, consider exploring alternate market data provider or local caching fallback (medium/high risk).
