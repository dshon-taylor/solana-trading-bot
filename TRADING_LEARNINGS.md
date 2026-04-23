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
- Recommend fixing execution confirmations before changing risk parameters. If you approve, I can (A) extract recent failing confirmation lines and open a diagnostic issue, or (B) spin a short paper A/B experiment with alternate stop levels and report back with results.

---

2026-04-17 — Daily upkeep

What I checked
- Reviewed TRADING_LEARNINGS.md and the last 24h of available data under state/candidates, state/track/results.jsonl, state/trades.jsonl, and state/paper_live_attempts.jsonl.
- Confirmed there are no new records in the last 24 hours; most telemetry in these files stops in Feb–Mar 2026.

Summary
- No fresh trading activity in the past 24h. This note consolidates the continuing patterns observed in the historical logs.

What worked
- Trailing-stop behavior remains a clear positive: when trailActivated=true, winners frequently produce large pnlPct gains (examples >0.3 in historical runs).
- The pipeline surfaces high-momentum candidates and attempts swaps for them in paper mode (many ok:swap_submitted entries historically).

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
   - Run paper experiments comparing current stop (~18%) vs 22–25% (and/or require a minimum liquidity/volatility threshold at entry). Measure stop-hit rate and net pnl over a fixed N-window.
3) Preserve trailing stops; small trail-tuning in paper (confidence: low)
   - Keep trailing stops enabled. In paper mode, test small changes to trail activation and step size in paper mode to see if runup capture improves without increasing drawdown.

Notes / next actions
- No live parameters were changed by this update.
- I can extract failing confirmation lines and open an issue, or run the paper A/B test if you want.

---

2026-04-18 — Daily upkeep

What I checked
- Reviewed TRADING_LEARNINGS.md and the last 24h of available data under state/candidates, state/track/results.jsonl, state/trades.jsonl, and state/paper_live_attempts.jsonl.
- Confirmed there are NO new records in the last 24 hours; the most recent telemetry in these files remains from Feb–Mar 2026.

Summary
- No fresh trading or execution telemetry in the past 24h. This entry consolidates continuing patterns from the historical logs and previous daily notes.

What worked
- Trailing-stop logic consistently captured the largest winners in historical runs (multiple examples with pnlPct >> 0.3 when trailActivated=true).
- The candidate pipeline still surfaces high-ret candidates and issues swap attempts in paper mode (paper_live_attempts contains many ok:swap_submitted lines historically).

What failed / problems observed
- Execution confirmations still appear as the largest operational failure mode in historical data (websocket_err, http_timeout, http_status_err). Consequence: many attempted swaps lack signatures and no fills are recorded in trades.jsonl.
- Stop-loss exits continue clustering around ~-18% pnlPct across many samples, indicating that stop sizing or entry signal noise is a persistent drawdown driver.

Parameter observations
- Trailing stops: positive effect on winners' realized returns when activated; preserve during experiments.
- Stop-loss level: the recurring -18% exits suggest current stop sizing is systematically removing many runs before they can recover.
- Execution path: multiple distinct failure classes point to the confirmation/bridge layer (network/RPC/timeouts) as the operational bottleneck rather than signal generation.

Proposed tweaks (do NOT change live trading params automatically)
1) Repair execution confirmation pipeline (confidence: high)
   - Add better retry/backoff, capture full error payloads in logs, and add failover RPC endpoints. If confirmation timeouts persist, temporarily route confirmations through an alternative RPC provider for diagnostics.
2) Paper A/B test: stop sizing (confidence: medium)
   - Run a controlled paper experiment comparing current stop (~18%) vs wider stops (22–25%) and/or require a minimum liquidity/volatility threshold at entry. Track stop-hit rate and net pnl over a fixed sample size.
3) Preserve trailing stops; small trail tuning in paper (confidence: low)
   - Keep trailing stops enabled; in paper mode test small changes to trail activation threshold and step size to try capturing more runups while limiting early tightening.

Notes / next actions
- No live parameters were changed by this update.
- Recommendation order: fix execution confirmations first (highest impact), then run the paper A/B on stop sizing. I can extract the recent failing confirmation lines and open an issue, or I can schedule and run the paper A/B experiment and report back with results.

(End of 2026-04-18 entry)

---

2026-04-19 — Daily upkeep

What I checked
- Reviewed state/track/results.jsonl, state/paper_live_attempts.jsonl, state/trades.jsonl, and the state/candidates directory for the last 24 hours.

Summary
- No new trading or execution telemetry in the last 24 hours; the latest actionable entries in the workspace logs remain from Feb–Mar 2026. Because there is no fresh 24h data, this update reconfirms the persistent patterns visible in the historical logs.

What worked
- Trailing-stop behavior continues to be the strongest positive: historical runs with trailActivated=true show several large winners (pnlPct > 0.3).
- Candidate pipeline reliably surfaces high-ret candidates and issues swap attempts in paper mode (many ok:swap_submitted lines in paper_live_attempts historically).

What failed / problems observed
- Execution confirmations are still the primary operational failure: paper_live_attempts contains many attempted swaps that later record fail:swapError with websocket_err, http_timeout, or http_status_err and signature=null.
- trades.jsonl remains effectively empty (no recorded filled trades), pointing to execution/confirmation failures or downstream recording problems.
- Stop-loss exits keep clustering around ~-18% pnlPct across many samples, suggesting the stop sizing is frequently causing losses.

Parameter observations
- Trailing stops produce outsized winners when activated; preserve in experiments.
- The ~18% stop-loss level is repeatedly hit in historical exits — a candidate for controlled testing.
- Multiple failure modes for confirmations (websocket_err, http_timeout, http_status_err) make the execution path the highest-priority operational fix.

Proposed tweaks (do NOT change live trading params automatically)
1) Execution/confirmation hardening (confidence: high)
   - Implement exponential-backoff retries, capture full confirmation error payloads to logs, and add failover RPC endpoints. If necessary, temporarily route confirmations through an alternative provider for diagnostics.
2) Controlled paper A/B on stop sizing (confidence: medium)
   - Compare current ~18% stop vs wider stops (22–25%) and/or add an entry volatility/liquidity filter. Measure stop-hit rate and net pnl over a fixed sample of paper trades.
3) Trail tuning in paper (confidence: low)
   - Keep trailing stops enabled; in paper mode test small changes to trail activation threshold and trail step size to try capturing more runups without excessive tightening.

Notes / next actions
- No live parameters were changed by this update.
- Recommendation: fix confirmation reliability first, then run a paper A/B for stop sizing.
- Next: if you want I can (A) extract the failing confirmation lines and open a diagnostic issue, or (B) schedule and run the paper A/B experiment and report back. 

(End of 2026-04-19 entry)
Sun Apr 19 17:10:06 UTC 2026 CT: Sun Apr 19 12:10:06 CDT 2026 - run d2feac6d: restarted pm2 with --update-env to ensure HELIUS_API_KEY loaded; monitoring for recurrence.

---

2026-04-20 — Daily upkeep

What I checked
- Reviewed the recent state files: state/track/results.jsonl and state/paper_live_attempts.jsonl (historical data present through Feb–Mar 2026) and state/trades.jsonl (empty). There were no new records in the last 24 hours.

Summary
- No fresh trading/execution telemetry in the last 24h. Historical logs reinforce two persistent observations: (1) trailing stops capture the largest winners when activated, and (2) execution confirmations are failing frequently, leaving many attempted swaps without signatures or recorded fills.

What worked
- Trailing-stop exits reliably produced strong winners in historical runs (multiple pnlPct > 0.3 examples when trailActivated=true).
- Candidate pipeline and decision logic issue swap attempts consistently in paper mode (many ok:swap_submitted lines in paper_live_attempts).

What failed / problems observed
- Execution/confirmation failures dominate (websocket_err, http_timeout, http_status_err). Many attempted swaps show signature=null and fail:swapError entries in paper_live_attempts.
- trades.jsonl is empty — suggests fills aren't being recorded (likely due to confirmations failing or a downstream recording/DB issue).
- Stop-loss exits keep clustering around ~-18% pnlPct in results.jsonl, indicating stop sizing may be too tight for many assets.

Parameter observations
- Trailing stops: effective at locking in outsized winners when activated — keep enabled while testing other changes.
- Stop-loss: repeated -18% exits imply the configured stop is often the limiting factor; consider testing wider stops or additional entry filters in paper mode.
- Execution reliability: multiple distinct error types point to network/confirmation pipeline issues rather than strategy signal failures.

Proposed tweaks (do NOT change live trading params automatically)
1) Execution confirmations (confidence: high)
   - Priority: add exponential-backoff retries, capture full error payloads in logs, and add failover RPC/websocket endpoints. Consider temporarily increasing confirmation timeouts while diagnosing.
2) Paper A/B: stop sizing (confidence: medium)
   - Run a short paper A/B comparing current ~18% stop vs 22–25% stops and/or require minimum liquidity/volatility at entry. Measure stop-hit rate and net pnl over a fixed sample (e.g., 100 paper attempts).
3) Trail tuning (confidence: low)
   - Preserve trailing stops; in paper mode test small changes to trail activation threshold and step size to try capturing more runups without excessive tightening.

Notes / next actions
- No live parameters were changed by this update.
- I can (A) extract recent failing confirmation lines and open a diagnostic issue, or (B) schedule and run the paper A/B test and report back. Recommend fixing confirmations first.

(End of 2026-04-20 entry)

---

2026-04-21 — Daily upkeep

What I checked
- Reviewed state/paper_live_attempts.jsonl (historical entries visible through Mar 2026), state/track/results.jsonl, state/trades.jsonl, and state/candidates for the last 24 hours.
- Pulled a sample of paper_live_attempts lines from the historical window; many show attempted swaps with signature=null and explicit fail reasons (websocket_err, http_timeout, http_status_err).

Summary
- No new trading or execution telemetry in the past 24 hours. Historical and sampled lines confirm the same persistent patterns: trailing stops produce large winners when activated, while execution confirmations fail frequently and many exits cluster at the configured stop (~-18%).

What worked
- Trailing-stop behavior remains beneficial: examples in historical runs where trailActivated=true show winners with pnlPct > 0.3.
- Candidate pipeline reliably surfaces high-ret candidates and issues swap submissions in paper mode (many ok:swap_submitted lines in the sampled logs).

What failed / problems observed
- Execution confirmations are still the dominant failure mode. Sampled paper_live_attempts lines from the logs show repeated Transaction confirmation failures (websocket_err / http_timeout / http_status_err) leaving signature=null and no fills recorded.
- Stop-loss exits continue clustering around ~-18% pnlPct in the tracker results sample, indicating stop sizing or noisy-entry selection persist as drawdown drivers.

Parameter observations
- Trailing stops: effective at letting winners run; historically produce outsized returns when activated.
- Stop-loss: -18% is repeatedly hit across assets — a systematic candidate for controlled testing in paper mode.
- Execution path instability: the variety of failure reasons (websocket_err, http_timeout, http_status_err) point to confirmation/RPC layer instability rather than core strategy logic.

Proposed tweaks (do NOT change live trading params automatically)
1) Execution confirmation hardening (confidence: high)
   - Action: add exponential-backoff retries for confirmations, record full error payloads and latencies in logs, and configure failover RPC/websocket endpoints. Temporarily increase confirmation timeouts for diagnostics and consider routing a small percentage of confirmations through an alternate RPC provider to measure delta.
2) Paper A/B on stop sizing + entry filter (confidence: medium)
   - Action: run a controlled paper experiment comparing current ~18% stop vs wider stops (22–25%) and introduce a minimum-liquidity or volatility filter at entry. Track stop-hit rate, win rate, and net pnl over a fixed sample (e.g., 100 paper attempts).
3) Preserve trailing stops; small trail tuning in paper (confidence: low)
   - Action: keep trailing stops enabled. In paper mode, test reducing activation threshold slightly or tightening trail step to capture more runups while limiting premature tightening.

Notes / next actions
- No live parameter changes were made.
- Prioritize fix #1 (execution confirmations) before risk-parameter experiments.
- If you want, I can (A) extract and open an issue with the sampled failing confirmation lines and suggested alternate RPC endpoints, or (B) schedule and run the paper A/B experiment and report results after the sample completes.

(End of 2026-04-21 entry)

---

2026-04-22 — Daily upkeep

What I checked
- Reviewed the following files for the last 24 hours: state/candidates, state/track/results.jsonl, state/trades.jsonl, and state/paper_live_attempts.jsonl. Pulled recent samples where available.

Summary
- No new trading or execution telemetry in the last 24 hours; the workspace logs' latest actionable entries remain from Feb–Mar 2026. Sampled lines from paper_live_attempts (most recent at 2026-03-23) and results.jsonl (latest entries through Feb–Mar 2026) show the same recurring patterns documented in previous entries.

What worked
- Trailing stops continue to be the clearest positive: historical runs with trailActivated=true produce outsized winners (examples showing pnlPct > 0.3).
- Candidate selection and decision pipeline consistently surface high-return candidates and issue swap attempts in paper mode when live execution is enabled.

What failed / problems observed
- Execution confirmations remain the dominant operational failure. Many paper_live_attempts lines show attempted swaps with signature=null and explicit fail reasons (websocket_err, http_timeout, http_status_err), indicating confirmation/RPC path instability.
- trades.jsonl is empty (no recorded fills), consistent with confirmation failures or downstream recording issues.
- Stop-loss exits continue to cluster around ~-18% pnlPct in results.jsonl — the configured stop level is repeatedly removing positions before they can recover or realize longer runups.

Parameter observations
- Trailing stops: effective for letting winners run; keep enabled during experiments.
- Stop-loss near ~18%: repeatedly hit across many samples — candidate for controlled paper testing with wider stops or entry filters.
- Execution/confirmation path: multiple distinct failure modes point to network/RPC or bridge-layer instability rather than core signal generation issues.

Proposed tweaks (do NOT change live trading params automatically)
1) Execution confirmations (confidence: high)
   - Priority action: add exponential-backoff retries for confirmations, log full error payloads and latencies, and configure failover RPC/websocket endpoints. Temporarily increase confirmation timeouts for diagnostics; route a small percentage of confirmations through an alternate provider to measure difference.
2) Paper A/B: stop sizing + entry filter (confidence: medium)
   - Run a controlled paper experiment comparing current ~18% stop vs wider stops (22–25%) and/or add a minimum-liquidity or volatility filter at entry. Track stop-hit rate, win rate, and net pnl over a fixed sample (e.g., 100 paper attempts).
3) Preserve trailing stops; small trail tuning in paper (confidence: low)
   - Keep trailing stops enabled. In paper mode, test small changes to the trail activation threshold or step size to capture more runups while limiting premature tightening.

Notes / next actions
- No live parameters were changed by this update.
- Top-priority: fix execution confirmation reliability (highest expected impact on recorded fills and PnL visibility).
- Next: run the paper A/B for stop sizing once confirmations are stable.

(End of 2026-04-22 entry)
