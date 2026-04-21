2026-04-21: Applied PM2 runtime restart with explicit node-args and max-memory-restart.

Command used:
pm2 restart solana-momentum-bot --update-env --node-args="--no-warnings --max-old-space-size=4096" --max-memory-restart 400M

Why: pm2 error logs indicated `--no-warnings` being passed to /bin/bash (invalid option) causing shutdown noise. Restart forces node interpreter usage and adds a memory restart safety.

Monitor: watch heap usage and event-loop p95 for next 2 runs. Auto-revert if metrics worsen on two consecutive runs.
