## 2026-03-17 — Momentum scoring upgrade notes

- Replaced prior simple "positives>=N" soft-pass logic with a deterministic weighted `momentumScore` and derived `finalScore` after penalties.
- Hard safety guards remain unchanged and continue to short-circuit evaluation (liquidity floor, extreme spread, tx minima, mc/liquidity ratio, rapid liquidity drop, buy-dominance, etc.). These are still hard rejects and prevent any momentum pass.
- New scoring components (participation, price behavior, market quality) are deterministic and env-configurable via sensible defaults. This enables tuning without architecture changes and preserves confirm/execution rule behavior.
- Diagnostics now include componentScores, penalties, momentumScore, finalScore, bands, topContributors and topPenalties to improve triage and A/B experiments.
- Early-ret/acceleration combo is retained for diagnostics but no longer auto-passes candidates; instead it boosts related component scores through ret1/ret5/acceleration contributions.

Sane default thresholds and weights are embedded in code but can be tuned via environment variables:
- PRE_RUNNER_SCORE_THRESHOLD (default 35)
- MOMENTUM_PASS_SCORE_THRESHOLD (default 60)
- STRONG_MOMENTUM_SCORE_THRESHOLD (default 80)

Weights (defaults): walletExpansion 20, txAccel 18, buySell 15, ret1 15, ret5 12, accel 5, volume5m 8, tx1h 5, liqQuality 2, mcapLiq 3.

Notes:
- Confirm stage and execution remain rule-based and unchanged.
- Do not adjust hard guard env vars here; they remain the authoritative safety controls.

## 2026-03-17 — Scoring config normalization follow-up

- Normalized score threshold env flags used by runtime:
  - `MOMENTUM_SCORE_PRE_RUNNER_THRESHOLD` (default 45)
  - `MOMENTUM_SCORE_PASS_THRESHOLD` (default 60)
  - `MOMENTUM_SCORE_STRONG_THRESHOLD` (default 75)
- Weight env flags used by runtime scorer:
  - `W_WALLET_EXPANSION`, `W_TX_ACCEL`, `W_BUY_SELL`, `W_RET1`, `W_RET5`, `W_ACCEL`, `W_V5M`, `W_TX1H`, `W_LIQ`, `W_MCLIQ`.
- Kept deterministic score behavior and hard-guard-first pass semantics unchanged.

## 2026-03-18 — Momentum unblocking tune (safety preserved)

- Raised mcap/liquidity hard reject ceiling from `>4.5` to `>8.0`.
- Added stretched-structure penalty for `mcap/liquidity > 6.0` (`mcapLiquidityStretched`) without immediate rejection.
- Lowered momentum pass threshold from `60` to `58`.
- Softened weak-volume penalty from `12` to `8` via `MOMENTUM_SCORE_PENALTY_WEAK_VOLUME`.
- Kept liquidity hard floor and other core hard guards intact; confirm and execution logic unchanged.

## 2026-03-18 — Upstream burst-promotion tuning for tx/wallet quality

- Added burst-promotion path in watchlist/HOT to prioritize candidates with improving:
  - `txAccelRatio`,
  - `walletExpansionRatio`,
  - `buySellRatio` trend,
  - and neutral-or-better volume expansion.
- Added burst-scoped fast sampling window for tagged mints only (no watchlist-wide cadence increase).
- Added diagnostics counters for burst promotion quality and downstream reach:
  - `burstTagged`, `burstReachedMomentum`, `burstReachedConfirm`, `burstReachedAttempt`, `burstFilled`, `burstExpired`,
  - averages: `burstAvgTxAccel`, `burstAvgWalletExpansion`, `burstAvgBuySellRatio`,
  - `burstRejectedByReason`, plus `burst.last10` detail rows.
- Momentum score threshold/confirm/execution logic not changed in this step.

## 2026-03-18 — Momentum liquidity guard converted to tiered reject + penalties

- Momentum-stage liquidity hard guard changed from binary `<35k reject` to:
  - hard reject below `20k`,
  - tiered penalties for `20k–35k`,
  - no liquidity penalty at `>=35k`.
- Penalty schedule:
  - `20k–25k`: `8` points
  - `25k–30k`: `5` points
  - `30k–35k`: `2` points
- This preserves liquidity awareness while allowing strong participation-led early runners to compete through scoring.
- Confirm/execution logic unchanged.

## 2026-03-18 — Minimum activity integrated without new stage

- Added minimum absolute activity influence in HOT as a **priority boost only** (not hard reject):
  - tx1h healthy boost,
  - volume5m healthy boost,
  - extra boost when both are healthy.
- Added low absolute activity treatment in momentum scoring as **modest penalties** (not binary gate):
  - low absolute tx1h activity penalty,
  - low absolute volume5m activity penalty.
- No new pipeline stage introduced; architecture remains scanner → watchlist → snapshot → hot → momentum → confirm → attempt → position manager.

## 2026-03-18 — Daily learning log

- What worked:
  - Recent scoring relaxations (momentum threshold lowered to 58 and weaker weak-volume penalty) increased upstream candidate throughput and produced more burst-tagged candidates reaching momentum/confirm stages (see burst counters).
  - Diagnostics improvements (componentScores / topContributors / penalties) remain useful for triage — they made it faster to identify which component (txAccel, walletExpansion, retX) moved a candidate across the pass boundary.

- What failed / observed issues:
  - Execution confirmation noise remains a problem: a nontrivial fraction of attempted swaps in the recent logs are failing with transaction-confirmation/websocket timeouts or websocket_err/custom errors (seen in paper_live_attempts and paper_trades history). This inflates attempted-but-failed counts and skews downstream metrics.
  - Increased upstream candidate volume is exposing false positives where short-lived volume spikes produce good componentScores but poor execution outcomes (slippage, liquidity microstructure). Confirm-stage rejects still catch many but some slip through to attempted swaps and then fail or hit stopLoss quickly.

- Parameter observations:
  - MOMENTUM_PASS lowered to 58 → higher recall but lower precision; many additional candidates are marginal (scores in low 58–65 band).
  - Weak-volume penalty reduced → more low-volume candidates enter the pipeline; this correlates with higher failed swap / small-fill rates.
  - Burst-promotion increases short-term sampling for tagged mints and surfaces improving tx/wallet signals, but also amplifies the above precision issue when market microstructure is thin.

- Proposed tweaks (1–3) — do NOT change live params automatically; record for A/B or manual rollout:
  1) Short-term (confidence: high): Add an execution health gate before submit — require a minimal confirmed liquidity and recent successful-swap rate for the token (or deny if recent websocket confirm error rate > X%). This reduces attempted-but-failed swaps. (Confidence: 0.80)
  2) Medium-term (confidence: medium): Raise MOMENTUM_PASS by +2 or add a small debounce band for newly burst-tagged candidates (e.g., require score>60 OR sustained ret5>Y for next 2 samples) to improve precision while preserving burst sensitivity. (Confidence: 0.65)
  3) Monitoring (confidence: high): Add a dedicated metric/alert for "swap-confirmation-failure-rate" and an automated backoff that pauses execution for N minutes if rate exceeds threshold. This is observability + safety. (Confidence: 0.85)

- Action items:
  - Do not auto-change live trading params from this note. Recommend implementing #1 and #3 as configuration toggles behind feature flags for rapid rollback.
  - Review recent burst.last10 rows and topRejectedByReason to pick candidate-specific cases for post-mortem (I can produce a short list if you want).

## 2026-03-19 — Daily learning log

- What worked:
  - Pipeline produced a steady stream of paper entries and executions; several longer-duration trades exited to trailingStop with meaningful positive pnl (some >20–100% in paper mode), showing the trailing-stop path captures winners when liquidity holds.
  - Diagnostics + burst-promotion continue to surface improving tx/wallet signals, enabling entry on strong short-term momentum pockets.

- What failed / observed issues:
  - High frequency of very short stopLoss exits at the configured small stop (many exits at -0.05%) — suggests either stop level is too tight for current microstructure or entries often occur before reliable liquidity forms.
  - Many entries are short-lived with repeated stopLoss hits; these produce a lot of noise and hide the trailing-stop winners in aggregated metrics.
  - Earlier logs show many "skip:tracker_live_execution_disabled" events (execution off for tracker) which affects live attempt counts and may bias manual/observational conclusions.

- Parameter / behavior observations:
  - StopLoss small fixed delta → numerous -0.0005 (≈-0.05%) exits; trailingStop captures larger winners but at lower hit-rate. Current balance favors many tiny losses and fewer large wins.
  - Lowered MOMENTUM_PASS and weakened weak-volume penalty continues to increase marginal candidates; observed clustering of marginal scores that immediately hit stopLoss.
  - Paper trades show trailingStop winners have much higher pnl than single stopLoss losses — improving entry precision would raise net PnL materially.

- Proposed tweaks (do NOT auto-change live params):
  1) Short-term (confidence: high, 0.80): Increase stopLoss proportionally or switch from a tiny fixed stop to a volatility-adaptive stop (e.g., X * recent spread or micro-ATR) to reduce noise from microstructure and avoid many -0.05% exits.
  2) Medium-term (confidence: medium-high, 0.70): Add an execution-health check before submit: require recent successful-swap rate > Y% OR minimal confirmed liquidity; reject submits when websocket-confirmation error rate is high. This should cut attempted-but-failed and tiny-stop noise.
  3) Monitoring (confidence: high, 0.85): Add two new metrics/alerts: "tiny-stop-rate" (fraction of exits that are the minimal stop) and "swap-confirm-failure-rate"; when either crosses thresholds, throttle burst-promotion and/or increase stopLoss temporarily (feature-flagged backoff).

- Quick actionables:
  - Run a short A/B test (48h) comparing current fixed stopLoss vs volatility-adaptive stopLoss on paper to measure change in win/loss ratio and average trade pnl.
  - Implement execution-health gate as a toggle behind feature flag and run in paper mode for 24–48h.

- Top insight: Many marginal candidates are being lost to extremely tight fixed stopLosses while a smaller subset of trades captured by trailingStop produce outsized returns — improving entry precision or using adaptive stops will likely increase net returns more than further lowering MOMENTUM_PASS.

- Notes: I did not change any live params.


