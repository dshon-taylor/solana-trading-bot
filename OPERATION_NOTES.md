2026-04-26 - Candle Carl run summary
- PM2-managed solana-momentum-bot restarted to apply current env.
- Historical errors seen: BIRDEYE_LITE_ENABLED without BIRDEYE_API_KEY and SCAN_BACKOFF_MAX_MS < SCAN_EVERY_MS causing fatal exits (logs from 2026-04-24). Current env sets BIRDEYE_LITE_ENABLED=false and SCAN_BACKOFF_MAX_MS >= SCAN_EVERY_MS.
- No code changes made. Monitor restart count and fatal errors; if restarts continue to spike, consider investigating unstable restarts and increasing min_uptime or adjusting restart policy.
