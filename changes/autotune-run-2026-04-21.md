2026-04-21 UTC - Autonomous Candle Carl run

Diagnosis:
- PM2 process 'solana-momentum-bot' experienced bash errors due to node flags being interpreted by /bin/bash: 
  '/bin/bash: --max-old-space-size=1536: invalid option'
- Logs showed repeated bash usage and restart loop.

Actions (low/medium-risk mix):
1) Edited trading-bot/ecosystem.config.cjs to set interpreter:'/usr/bin/node' and interpreter_args:'--max-old-space-size=1536 --no-warnings' to ensure node flags are passed to node, not bash. (low-risk)
2) Committed change and reloaded PM2 process via pm2 startOrReload + pm2 restart. (low-risk)

Results:
- PM2 now shows interpreter=/usr/bin/node and interpreter_args present.
- Process is online and logging normally. Memory/heap metrics within expected range.

Notes:
- No code changes to runtime logic were made; preserved staged architecture.
- Will monitor for regressions; auto-revert policy active (revert if 2 consecutive degraded runs).

- Candle Carl (autonomous)
