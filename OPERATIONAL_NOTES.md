2026-04-24 - Candle Carl run summary

Findings:
- Process 'solana-momentum-bot' is online but has high restart count (606). Logs show repeated SIGINT signals triggering restarts.
- Event-loop p95 latency spikes (~550ms) observed intermittently; memory usage steady around 480-550MB.
- Key env vars present: RPC endpoints and KEYPAIR_PATH set.

Proposals (low-risk):
1) Investigate and stop external SIGINT source (cron/systemd/watchdog). Important — prevent unintended restarts.
2) Temporarily increase pm2 min_uptime and max_restarts to reduce churn while debugging.
3) Add graceful SIGINT handler in code to differentiate intended restarts from external interrupts.

No code changes applied in this run to preserve staged architecture.
