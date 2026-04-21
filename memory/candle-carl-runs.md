Run-id: d2feac6d-b989-43b5-94f4-edeb3232011e
Timestamp (CT): 2026-04-19 03:08 PM CT
Changes:
- LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT: 0.0075 -> 0.01 (widen stop-at-entry buffer to 1%) [low-risk]
- LIVE_STOP_ARM_DELAY_MS: 75000 -> 120000 (increase stop-arm delay to 120s) [low-risk]
Reasoning:
- Observation: many exits in paper_trades.jsonl show repeated small stopLoss exits at ~-0.75% (pnlPct -0.0075) causing frequent small losses and churn.
- Also providerHealth logs show intermittent "miss" outcomes from external providers (birdeye/jupiter) causing potential signal gaps; added logging and will monitor.
Validation:
- Restarted pm2 process with updated env (pm2 restart solana-momentum-bot --update-env).
- Confirmed effective config shows bufferPct=0.01 and stopArmDelayMs=120000.
Notes:
- This is a conservative, low-risk tuning: widening immediate stop buffer to 1% should reduce small stopouts while preserving overall risk controls (prearm catastrophic stop still 7%).
- If metrics (trade success rate, recent profit per trade) worsen for 2 consecutive runs after this change set, auto-revert rule applies and we will roll back.
Next steps:
- Monitor providerHealth misses and trade outcomes for next 3 cycles (~4.5h). If provider misses persist, propose medium-risk change to provider fallback ordering or increase per-mint cache TTL.
- Collect next run diagnostics and compare trade success rate / slippage / capital at risk.
