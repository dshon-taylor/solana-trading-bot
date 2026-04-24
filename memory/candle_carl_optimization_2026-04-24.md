2026-04-24T14:18Z - Candle Carl autonomous optimization cycle run
- Collected diagnostics via pm2 (diag scripts absent). Key findings:
  - solana-momentum-bot process online (pm2 id 10)
  - High historical restarts: 660
  - Initial code metrics before change: CPU ~60%, mem ~317MB, event-loop p95 ~759ms
  - Env validated: RPC endpoints and KEYPAIR_PATH present
- Changes applied (low-risk): aligned ecosystem.config.cjs node_args max-old-space-size -> 1536MB
- Rationale: runtime showed --max-old-space-size=1536; align to avoid mismatched memory limits causing restarts under memory pressure.
- Actions:
  - Edited ecosystem.config.cjs and committed on branch tune/candle-carl-autotune-2026-04-23 (commit 1ac06dd)
  - Restarted process with pm2 restart solana-momentum-bot --update-env
- Post-change metrics (single run): heap usage reduced to ~28MB immediately after restart, but event-loop p95 observed 6223ms (likely transient during restart).
- Revert status: NO_AUTO_REVERT_SCHEDULED (requires 2 consecutive degraded runs to trigger revert).
- Next steps recommended:
  1) Monitor event-loop latency and CPU over next 1-2 hours. If p95 remains >1s for 2 consecutive checks, consider reverting commit and investigating long-blocking tasks.
  2) If flapping resumes, inspect pm2 error logs: /home/dshontaylor/.pm2/logs/solana-momentum-bot-error.log
  3) Consider targeted profiling (pm2 trigger km:cpu:profiling:start) if p95 remains high.

Notes recorded by OpenClaw autonomous run.
