# Trading Learnings

(automated learning log for Candle Carl)

---

2026-04-15 — Daily upkeep

What I checked
- Reviewed state/track/results.jsonl, state/paper_live_attempts.jsonl, and state/trades.jsonl in the trading-bot workspace.
- Looked for data from the last 24 hours.

Summary
- No new activity in the last 24 hours (latest entries in these files are from Feb–Mar 2026). Because there were no fresh 24h records, this entry summarizes recent operational patterns visible in the available logs.

What worked
- Trailing-stop exits produced clear winners when price ran up (multiple entries show positive pnlPct after trailActivated=true and trailStop exits).
- The decision pipeline correctly flagged and attempted swaps for high-ret candidates (paper_live_attempts shows many "ok:swap_submitted" attempts).

What failed / problems observed
- Frequent swap/transaction confirmation failures in paper_live_attempts (many entries with fail:swapError — websocket_err / http_timeout / http_status_err). These caused attempted trades to not finalize (signature=null) or to require retries.
- Many completed runs ended at stopLoss with pnlPct ≈ -18% (consistent stop-loss hits across multiple entries), suggesting either aggressive stop sizing, noisy entries, or poor signal quality for certain assets.
- trades.jsonl appears empty (no recorded filled trades in workspace), which may indicate execution failures or a separate storage issue.

Parameter observations
- Trailing stops: when trailActivated=true the log shows several >0.3+ pnlPct winners — trailing stops are helpful for letting winners run.
- Stop-loss clustering: a large group of entries exitReason="stopLoss" with pnlPct around -0.18 to -0.18x suggests a configured stop loss near ~18% is being hit often. This is systematic across many samples.
- Execution reliability: numerous different error modes (websocket_err, http_timeout, http_status_err) point to network/confirm path instability rather than strategy logic.

Proposed tweaks (do NOT change live trading params automatically)
1) Fix execution reliability (confidence: high)
   - Investigate swap confirmation pipeline and RPC/websocket timeouts. Add improved retry logic with exponential backoff and clearer logging of final failure reason. If confirmation consistently times out, route through alternative RPC endpoints or increase confirmation timeout thresholds.
2) Reduce failed stop-loss frequency (confidence: medium)
   - Experiment in paper mode with slightly wider stop losses (e.g., from ~18% → 22–25%) or add a volatility filter at entry so low-liquidity/noisy assets are excluded. Run a short A/B test on paper to measure change in stop-loss hit rate.
3) Preserve winners while limiting exposure (confidence: low)
   - Keep trailing stops but evaluate lowering the activation threshold or tightening trail step to capture more runup. Alternatively, require a minimum sample count or liquidity metric before enabling live execution for a signal.

Notes / next actions
- No live parameter changes made. Recommend prioritizing fix #1 (execution confirmations) before adjusting risk parameters.
- If you want, I can: (a) open an issue with the lines of failing confirmations and suggested RPC endpoints; (b) run a short simulated A/B paper test with adjusted stop-loss values and report results after N trades.

---

2026-04-16 — Daily upkeep

What I checked
- Reviewed TRADING_LEARNINGS.md, state/track/results.jsonl, state/paper_live_attempts.jsonl, and state/trades.jsonl for the last 24 hours.

Summary
- No new records in the last 24 hours (workspace logs' most recent entries are from Feb–Mar 2026). Observations below are a short update based on the available logs.

What worked
- Trailing-stop logic continues to capture large winners when activated (multiple examples with pnlPct > 0.3 after trailActivated=true).

What failed / problems observed
- Execution confirmations remain the dominant failure mode: paper_live_attempts shows many attempted swaps with failure reasons like websocket_err, http_timeout, and http_status_err, leaving signature=null and trades unrecorded.
- Stop-loss exits cluster heavily around ~-18% pnlPct, indicating stop sizing is a systemic driver of losses.

Parameter observations
- Trail-enabled winners: trailing stops produce outsized winners when market runs — a clear positive signal for letting winners run.
- Stop-loss level: consistent -18% exits imply the configured stop is frequently too tight for many sampled assets.
- Execution path instability: multiple distinct error classes suggest the problem is in the confirmation/bridge layer (network, RPC endpoints, or node-side rejections), not in the strategy signals themselves.

Proposed tweaks (do NOT change live trading params automatically)
1) Prioritize execution pipeline fixes (confidence: high)
   - Add robust retry/backoff for confirmations, better logging of final error payloads, and failover RPC endpoints. This will recover the majority of currently-unrecorded fills.
2) Run a controlled paper A/B test for stop sizing (confidence: medium)
   - Compare current stop (~18%) vs wider stops (22–25%) and/or an entry volatility filter to reduce noisy assets. Measure stop-loss hit rate and net pnl over a sample of N paper trades.
3) Keep trailing stops, tweak activation/step in paper (confidence: low)
   - Test lowering the activation threshold or adjusting the trail step to balance capturing runups vs early tightening.

Notes / next actions
- No live parameter changes made by this update.
- Recommend fixing execution confirmations before changing risk parameters. If you approve, I can (A) extract recent failing confirmation lines and open an issue, or (B) spin a short paper A/B with alternate stop levels and report back.

---

2026-04-17 — Daily upkeep

What I checked
- Reviewed TRADING_LEARNINGS.md and the last 24h of available data under state/candidates, state/track/results.jsonl, state/trades.jsonl, and state/paper_live_attempts.jsonl.
- Confirmed there are no new records in the last 24 hours; most telemetry in these files stops in Feb–Mar 2026.

Summary
- No fresh trading activity in the past 24h. This note consolidates the continuing patterns observed in the historical logs.

What worked
- Trailing-stop behavior remains a clear positive: when trailActivated=true, winners frequently produce large pnlPct gains (examples >0.3 in historical runs).
- The pipeline surfaces high-momentum candidates and attempts swaps consistently in paper mode (many ok:swap_submitted entries).

What failed / problems observed
- Execution confirmations continue to fail frequently (websocket_err / http_timeout / http_status_err), resulting in attempted swaps with signature=null and no recorded fills.
- Stop-loss exits cluster near -18% pnlPct, indicating stop sizing or noisy-entry selection as recurring loss drivers.

Parameter observations
- Trailing stop is effective for letting winners run; it should be preserved in experiments.
- The ~18% stop-loss level is being hit repeatedly across assets — consider this a systemic setting to test.
- Execution reliability is the primary operational bottleneck (not strategy signal quality alone).

Proposed tweaks (do NOT change live trading params automatically)
1) Execution reliability first (confidence: high)
   - Add exponential-backoff retries for confirmations, capture full error payloads in logs, and add failover RPC endpoints. Consider temporarily routing confirmations through a different RPC cluster for diagnostics.
2) Paper A/B test on stop sizing (confidence: medium)
   - Run paper experiments comparing current ~18% stop vs 22–25% (and/or an entry volatility filter). Measure stop-hit rate and net pnl over a fixed N-window.
3) Preserve trailing stops, tweak activation/step in paper (confidence: low)
   - Test small changes to trail activation and step size in paper mode to see if runup capture improves without increasing drawdown.

Notes / next actions
- No live parameters changed by this update.
- Recommend resolving execution confirmations before changing risk parameters. I can extract failing confirmation lines and open an issue, or run the paper A/B test if you want.

(End of 2026-04-17 entry)
