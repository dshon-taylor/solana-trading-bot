2026-04-23 — Autonomous run by Candle Carl
- lowered SOURCES_RPS from 6 → 4
- set RPC_ENDPOINT to https://api.mainnet-beta.solana.com
Reason: reduce RPC load and ensure an RPC endpoint is present for stable operations. Low-risk change applied and PM2 restarted. Monitor for regressions.