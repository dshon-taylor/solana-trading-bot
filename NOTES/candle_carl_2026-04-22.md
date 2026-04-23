2026-04-22: Applied low-risk tuning to reduce rate pressure and hot-eval cadence.
- config/defaults.js: HOT_LIMIT_PER_MIN = 4 (was 6)
- config/defaults.js: HOT_COLD_CADENCE_MS_MIN = 20000 (was 15000)
- config/defaults.js: HOT_COLD_CADENCE_MS_MAX = 40000 (was 30000)
Reason: observed high restart count and elevated event-loop p95; changes aim to reduce external RPS and concurrent hot checks. Monitor PM2 restarts and event-loop latency over next 24h.
