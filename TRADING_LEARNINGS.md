2026-04-24 — Candle Carl autotune notes
- Root cause: intermittent startup fatals caused by mismatched environment toggles (BIRDEYE_LITE_ENABLED true without API key) and validation rule (SCAN_BACKOFF_MAX_MS < SCAN_EVERY_MS).
- Fix applied: enforce conservative defaults in ecosystem.config.cjs to avoid requiring external keys and to keep SCAN_BACKOFF >= SCAN_EVERY.
- Rationale: low-risk runtime defaults reduce crash-looping and prevent accidental external fetch attempts. Preserve staging architecture and avoid changing runtime behaviour beyond safety defaults.
- Monitoring: watch pm2 restarts and fatal/error logs for recurrence; consider adding runtime validation with clearer logging if issue returns.

Autotune 2026-04-24 actions:
- Increased node --max-old-space-size to 2048 and max_memory_restart to 700M (low-risk) in ecosystem.config.cjs.
- Restarted process with pm2 restart --update-env and verified process is online.
- Commit created locally; no remote push configured.

2026-04-25 — Daily learning-log upkeep
What worked:
- Runtime-autotune from 2026-04-24 remained stable; process restarts and memory defaults prevented crash-looping during observed window.

What failed / gaps:
- No live execution activity observed in the last available state logs: paper_live_attempts.jsonl shows repeated entries with reason "skip:tracker_live_execution_disabled" (many signals reached decision stage but were not attempted). This indicates tracker/live execution gating is preventing live trades and reducing signal-to-action feedback.
- Historical tracker summaries (state/track/results.jsonl) show many exits by stopLoss (≈ -18% exits common) and fewer trailing-stop wins — trailing activation appears selective and less frequent than stopLoss hits.

Parameter observations:
- LIVE execution gating: liveEnabled/executionEnabled/tradingEnabled flags are true for candidates but an external gate (tracker_live_execution_disabled) prevented attempts — investigate source of that gate.
- Stop-loss magnitude and trailing parameters: the recorded pnlPct patterns (many ~-0.18 losses vs some larger positive horizon/trail wins) imply current stopLoss threshold is a dominant exit path and may be clipping potential recoveries before trailing stops can activate.

Proposed tweaks (do NOT change live trading params automatically):
1) Alert and root-cause check for tracker_live_execution_disabled (confidence: high) — add an automated alert when this gate persists >1h so we regain signal→execution feedback quicker.
2) Investigate reducing stop-loss magnitude or make it adaptive (confidence: medium-low) — consider testing 12–15% stop in paper mode to see if trailing stops capture more recoveries before stopLoss triggers.
3) Log/tracking improvement (confidence: high) — add a per-signal lifecycle metric that records which gate blocked execution (watchlist/exposure/tracker_live flag) so we can quantify lost opportunities.

Notes:
- No live trading params were changed as requested.
- This update used available state files; most recent state entries are from March/Feb in the workspace logs. If you want strict last-24h analysis, enable/confirm daily state writes and ensure tracker runtime emits an execution-gate heartbeat to state/paper_live_attempts.jsonl.

— Candle Carl learning log (automated entry)

2026-04-26 — Daily learning-log upkeep
What worked:
- The process remained online and stable after recent autotune efforts (no crash-looping observed in PM2 snapshots). State files are present and readable.
- Track results continue to show that when trailingStop activates it produces the largest positive PnL wins (examples in state/track/results.jsonl show >0.3–1.7x wins when trailActivated=true).

What failed / gaps:
- There were no new state entries within the last 24h to analyze; the most recent entries in paper_live_attempts.jsonl and track/results.jsonl date from March–February. Daily upkeep therefore relied on historical data rather than strict last-24h signals.
- Persistent execution gating remains the dominant operational gap: paper_live_attempts.jsonl contains many "skip:tracker_live_execution_disabled" records (repeated across signals), preventing live/paper attempts and starving us of execution-feedback.

Parameter observations:
- Stop-loss is a hard exit and frequently produces ~-18% outcomes in tracked results — it is the most common exit path when trail activation doesn't occur.
- Trailing stops, when activated, capture larger wins (pnlPct frequently 0.15–1.78 in examples) but appear to activate less often than stopLoss triggers. This suggests either trail activation conditions are too conservative or stopLoss is too tight relative to volatility.
- Execution gates and environment toggles (e.g., tracker_live flag) are not being surfaced clearly in per-signal metrics; this reduces the team's ability to quantify blocked opportunities.

Proposed tweaks (do NOT change live trading params automatically):
1) Immediate: Add an automated alert + diagnostic snapshot when tracker_live_execution_disabled appears for >1h (confidence: high). This is low-risk and speeds investigation.
2) Experiment: In paper mode, run a controlled A/B test lowering stopLoss to 12–15% (confidence: medium). Monitor change in trailing activation rate and overall PnL; rollback if drawdown increases materially.
3) Observability: Add per-signal 'blockedBy' field in paper_live_attempts.jsonl and in monitoring dashboards (confidence: high). Track counts and duration per gate (watchlist, exposure, tracker_live) to quantify lost opportunities.

Notes & next steps:
- Did not change any live trading parameter. These updates are observational and propose paper-mode experiments/alerts only.
- If you want strict last-24h analysis, enable the tracker runtime to emit daily state snapshots and ensure paper_live_attempts is being written in the last-24h window.

— Candle Carl learning log (automated entry)
