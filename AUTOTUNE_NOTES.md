Autotune notes (Candle Carl) — 2026-04-26
- Applied low-risk reductions to scanning and source RPS to address high CPU:
  * SCAN_EVERY_MS=900000
  * POSITIONS_EVERY_MS=60000
  * SOURCES_RPS=1
- Rationale: reduce event-loop pressure and external request concurrency to improve stability and lower CPU/memory usage.
- If behavior regresses for 2 consecutive runs after this change set, revert commit d9fb1c7.
- Recommendation: run CPU profiling if CPU rises again to identify hotspots in momentum logic (momentum.js / index.mjs).
