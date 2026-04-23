autotune run 2026-04-23 (Candle Carl)

Summary:
- Applied low-risk tunings to reduce memory and event-loop pressure:
  - ROUTE_CACHE_MAX_SIZE: 256 -> 64
  - WATCHLIST_EVAL_EVERY_MS: 300000 -> 600000
  - BIRDEYE_WS_MAX_SUBS: 2 -> 1

Rationale:
- Logs showed elevated heap usage and periodic event-loop p95 spikes (~248ms). routeCache and frequent watchlist evals contribute to memory and IO pressure; reducing cache size and eval frequency should lower memory footprint and RPC/processing load.

Actions taken:
- Updated trading-bot/.env with the above values.
- Committed changes locally (commit dd7928d94f7fffb7092f1d4ccee2d6828fce19c4).
- Restarted process via: pm2 restart solana-momentum-bot --update-env (restart applied).

Notes/Next steps:
- pm2 did not reflect updated WATCHLIST_EVAL and ROUTE_CACHE vars after restart; follow-up recommended: perform pm2 stop solana-momentum-bot && pm2 start trading-bot/ecosystem.config.js --update-env (or start with explicit env) during a maintenance window to ensure new .env is loaded.
- Monitor memory and event-loop latency over next 24h; if metrics worsen for 2 consecutive runs, revert this commit.
- If you want, I can schedule an isolated restart that guarantees env reload (requires brief downtime) — confirm before proceeding.
