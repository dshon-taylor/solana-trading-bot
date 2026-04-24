2026-04-24T15:46Z UTC — Candle Carl autonomous optimization run

Actions taken:
- Collected diagnostics: pm2 status, pm2 show, recent logs (tail of pm2 out log).
- Observations: high restart count historically (↺=~666), p95 event-loop latency spikes (~663ms), snapshotFailures=1820 in logs, memory varying between ~400-700MB, activeRunners=0, entries/hour low, open_positions=0.
- Applied low-risk runtime changes to reduce flapping and memory pressure:
  - Increased node --max-old-space-size to 2048 (from 1536)
  - Increased PM2 max_memory_restart to 1G (from 768M)
  - Increased PM2 restart/backoff thresholds: max_restarts=10, restart_delay=120000ms, exp_backoff_restart_delay=60000ms
- Restarted/reloaded PM2 with updated ecosystem and verified process is online.
- Verified critical env values present: KEYPAIR_PATH, RPC_URL, RPC, OPENAI_API_KEY (presence only, secret values not exported here).

Reasoning summary:
- Dominant bottlenecks were memory pressure leading to restarts and frequent process restarts (flapping) contributing to snapshot failures and elevated event-loop p95. Conservative increases to memory limits and restart/backoff settings should reduce churn while preserving staged architecture.

Revert policy:
- This run made only low-risk changes. If metrics worsen for 2 consecutive runs, schedule to auto-revert the latest change set (manual monitoring required).

Files changed:
- ecosystem.config.cjs (PM2/node settings)

Git: committed locally (branch: tune/candle-carl-autotune-2026-04-23). Attempted push may be required by user.

Next suggested steps:
- Monitor logs and event-loop latency for 2-4 hours.
- If event-loop p95 remains high, investigate blocking I/O or expensive synchronous ops in src/ for hotspots (cpu profiler).
- Consider enabling playbook restart guard or reducing diagnostic retention if storage pressure appears.
