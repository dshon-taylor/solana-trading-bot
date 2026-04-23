2026-04-21T20:06Z UTC - Candle Carl autonomous run
- Collected diagnostics (pm2 status, logs, config) showing repeated errors: Node trying to import .sh and /bin/bash receiving node flags ("--max-old-space-size") leading to "invalid option" and TypeError ERR_UNKNOWN_FILE_EXTENSION for start_with_mock.sh.
- Reasoning: PM2 process configuration was passing node flags incorrectly to bash; process sometimes started under node directly which attempted to load .sh; root cause: pm2 ecosystem had interpreter set to node with .sh script. 
- Action: Updated trading-bot/ecosystem.config.cjs to run the start script under /bin/bash and move node flags into NODE_OPTIONS env; committed as b09f5e6. Restarted solana-momentum-bot via pm2. Process shows online/waiting but some logs still include legacy errors; further verification needed.
- Git push unavailable (no remote). Manual push required if desired.
- Follow-ups: verify PM2 applied new config correctly and eliminate earlier errors; if TypeError persists, investigate other PM2 definitions or systemd wrappers that may start process with node. If metrics worsen for two runs, revert commit b09f5e6.
