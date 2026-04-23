2026-04-23 - Candle Carl autonomous tuning
- Low-risk tunings applied by autonomous agent (commit 7d7cff0):
  - SCAN_EVERY_MS=25000
  - SOURCES_RPS=2
  - WORKER_IDLE_SLEEP_MS=120
- Reason: lower CPU/event-loop contention, reduce RPS to external providers, reduce restart pressure observed previously.
- Post-restart: process online via pm2 (id 10). No immediate errors observed. Continue monitoring.
