PM2 runtime note (added 2026-04-21 UTC):

Observed pm2 process for solana-momentum-bot started with a shell wrapper script which caused interpreter arg collisions when global node args (--no-warnings) were present. To avoid bash interpreting node flags, prefer starting the main script with node as the pm2 interpreter:

pm2 start src/index.mjs --name solana-momentum-bot --interpreter /usr/bin/node --node-args "--no-warnings --max-old-space-size=4096" --cwd /home/<user>/.openclaw/workspace/trading-bot --update-env

If you need a wrapper for pre-start checks, ensure pm2 exec_interpreter is node and call the wrapper from within Node or make wrapper not inherit node-specific args.
