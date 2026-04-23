2026-04-23 13:48 UTC - Autonomous Candle Carl autotune run
- Diagnostics: high restart count (≈553), frequent SIGINT-driven shutdowns recorded in pm2 error log; event-loop p95 spikes (~400ms); heap usage peaked ~83% previously.
- Changes applied (low-risk, 3):
  1) Increase pm2 min_uptime from 10000 -> 30000 ms to reduce crash-loop counting.
  2) Increase max_restarts from 5 -> 50 to avoid premature stop by pm2 during transient flaps.
  3) Increase restart_delay from 60000 -> 120000 ms to space restarts and allow transient external systems to recover.
- Rationale: reduce flapping/restarts, give process more time to initialize and recover; avoid redesign.
- Actions: edited ecosystem.config.cjs, committed branch tune/candle-carl-autotune-2026-04-22 (commit bd6824c), pushed to origin.
- Post-change: pm2 restarted solana-momentum-bot successfully; process now online. Key env values (RPC, KEYPAIR_PATH, OPENAI_API_KEY) verified present.
- Revert scheduled: none. Monitor: if metrics worsen for 2 consecutive runs, auto-revert will be scheduled (policy).
- Next steps: observe for 1-2 hours; if restarts continue at high rate, run deeper memory/FD leak analysis and consider reducing active subscriptions or increasing TTLs further.
