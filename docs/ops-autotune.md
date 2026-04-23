Candle Carl autotune notes (2026-04-23)

- Performed autonomous tuning run: increased SOURCES_RPS from 6 to 8 and BIRDEYE_LITE_MAX_RPS from 1 to 2 to raise source sampling throughput (low-risk).
- Commit/branch: tune/candle-carl-autotune-2026-04-22 (commit caacf195d70c2289ffa86fc53aa41b26b9015486).
- Restarted service via pm2; process online. Effective runtime config logged sources.rps=2 — env or runtime overrides may exist (check config loader precedence and any runtime flag overrides).
- Monitoring: watch entries/hour and queueSize over next 2 cycles. If metrics worsen for 2 consecutive runs, revert latest change set.
