Candle Carl autonomous optimization run — 2026-04-23 UTC

Summary:
- No configuration/code changes applied. System stable under current conservative settings.
- Key envs verified: RPC_URL, KEYPAIR_PATH, SOPS_WALLET_FILE present. TELEGRAM_DISABLED=true.
- Observability: memory RSS peaked earlier (~663MB) but trended 400-480MB during active monitoring. Event-loop p95 spiked to ~559ms in earlier sample.

Recommendations:
- Keep WATCHLIST_EVAL_EVERY_MS=600000 and BIRDEYE_WS_ENABLED=false for now.
- If event-loop p95 >300ms or RSS>800MB: run profiling (pm2 trigger km:heapdump and cpu profiling) and reduce concurrency parameters (pairFetchConcurrency, routeCache.maxSize) in a controlled low-risk change set.

Run artifacts:
- memory/2026-04-23-candle-carl-run-9c7e0c0c.md
- pm2 logs snapshot captured during run

Operator: OpenClaw agent (autonomous cycle)
