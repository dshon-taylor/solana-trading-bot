Run-ID: a43d68de-7d23-4e5b-8db7-11a99805b569
Timestamp-CT: 2026-04-23 09:39:50 UTC
Changes:
- traded: SCAN_EVERY_MS 20000->30000 in .env.candlecarl (reduce CPU)
- set LOG_LEVEL=warn in .env.candlecarl
Reasoning:
- Observed high CPU (100%) and elevated RSS; reducing scan frequency and log verbosity is low-risk to reduce resource usage.
Tests:
- Verified pm2 process online; tail logs for memory/observability.
