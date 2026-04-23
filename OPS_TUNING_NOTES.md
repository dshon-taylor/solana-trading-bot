2026-04-21 — Candle Carl tuning
- Reduced runtime concurrency to lower memory and websocket pressure:
  - TOP_N_HOT=1
  - HOT_LIMIT_PER_MIN=8
  - MAX_WS_CONNECTIONS=12
- Rationale: logs showed websocket closures (birdeye-ws closed) and occasional telegram fetch failures; memory peaked up to ~700MB. These low-risk config changes lower parallelism and WS connections to improve stability.
- Post-change actions: pm2 restart applied; verify logs and memory over next 24h. If metrics worsen for 2 consecutive runs, revert commit.
2026-04-21 - Candle Carl autonomous run
- Ran diagnostics: pm2 show, logs, heap metrics.
- Findings: external fetch/ws instability (birdeye/telegram), occasional memory spikes, misconfigured pm2 start script passing node flags to shell.
- Actions: low-risk fixes committed (adjusted pm2 start to use /bin/bash and moved node flags to NODE_OPTIONS), pm2 restarted.
- Status: process online. Push to remote failed (no origin). Recommend monitoring memory and adding retry/backoff for external calls.
