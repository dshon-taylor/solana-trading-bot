2026-04-24: Post-optimization note
- Performed automated diagnostic collection and restarted solana-momentum-bot via pm2.
- Observed elevated heap usage (~243 MiB) and p95 event loop latency (~3s). Investigate blocking operations and GC (possible heavy synchronous work).
- Suggest adding lightweight instrumentation (performance.now timers, async boundaries) and setting PM2 max_memory_restart to protect from runaway memory.
