## 2026-02-25T14:21:27.394Z
- mode: dry-run
- windowMin: 20
- diagProxy: debug.last=100, pm2OutLines=3, pm2ErrLines=0
- rejectTop: momentum:95, routeAvailable:5
- safetySignals: attemptsNearZero=true, attemptSignals=0, swapError=0, rateLimit=0, rateLimitShare=0.00
- decision: escalate (step 0 -> 1) — attempt signals near-zero; push aggressiveness (momentumShare=0.95)
- changes: LIVE_PARALLEL_QUOTE_FANOUT_N: 2 -> 3; NO_PAIR_RETRY_ATTEMPTS: 4 -> 5; NO_PAIR_RETRY_BASE_MS: 275 -> 240; PAPER_ENTRY_COOLDOWN_MS: 180000 -> 150000; PAPER_ENTRY_RET_15M_PCT: 0.03 -> 0.025; PAPER_ENTRY_RET_5M_PCT: 0.01 -> 0.008; LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 2 -> 3; LIVE_REJECT_RECHECK_BURST_DELAY_MS: 140 -> 120

Telegram summary template:
```
[aggressive-autotune] DRY-RUN escalate step 0->1
window=20m rejects=100 attemptsNearZero=true swapErr=0 rateLimit=0
topRejects=momentum:95, routeAvailable:5
changes=LIVE_PARALLEL_QUOTE_FANOUT_N: 2 -> 3 | NO_PAIR_RETRY_ATTEMPTS: 4 -> 5 | NO_PAIR_RETRY_BASE_MS: 275 -> 240 | PAPER_ENTRY_COOLDOWN_MS: 180000 -> 150000 | PAPER_ENTRY_RET_15M_PCT: 0.03 -> 0.025 | PAPER_ENTRY_RET_5M_PCT: 0.01 -> 0.008 | LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 2 -> 3 | LIVE_REJECT_RECHECK_BURST_DELAY_MS: 140 -> 120
```

## 2026-02-25T14:32:31.312Z (apply)

- window: last 15m
- level: 0 -> 1
- candidates: 541 (rejects=84)
- heuristics: attemptsNearZero=true rateLimitBad=false swapErrorBad=false
- counts: rateLimited=0 swapError=0 momentumRejects=180

Top reject buckets (state.debug.last + candidates tail best-effort):
- momentum: 96
- routeAvailable: 4

Planned knob changes:
- PAPER_ENTRY_RET_15M_PCT: 0.03 -> 0.028
- PAPER_ENTRY_RET_5M_PCT: 0.01 -> 0.009
- PAPER_ENTRY_COOLDOWN_MS: 180000 -> 150000

## 2026-02-25T14:32:37.921Z (apply)

- window: last 15m
- level: 1 -> 2
- candidates: 541 (rejects=84)
- heuristics: attemptsNearZero=true rateLimitBad=false swapErrorBad=false
- counts: rateLimited=0 swapError=0 momentumRejects=180

Top reject buckets (state.debug.last + candidates tail best-effort):
- momentum: 96
- routeAvailable: 4

Planned knob changes:
- LIVE_PARALLEL_QUOTE_FANOUT_N: 2 -> 3
- LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 2 -> 3
- LIVE_REJECT_RECHECK_BURST_DELAY_MS: 140 -> 120
- NO_PAIR_RETRY_ATTEMPTS: 4 -> 5
- NO_PAIR_RETRY_BASE_MS: 275 -> 250
- NO_PAIR_TEMP_TTL_MS: 60000 -> 45000
- PAPER_ENTRY_RET_15M_PCT: 0.028 -> 0.025
- PAPER_ENTRY_RET_5M_PCT: 0.009 -> 0.008
- PAPER_ENTRY_COOLDOWN_MS: 150000 -> 120000

## 2026-02-25T14:47:38.139Z (apply)

- window: last 15m
- level: 2 -> 3
- candidates: 535 (rejects=84)
- heuristics: attemptsNearZero=true rateLimitBad=false swapErrorBad=false
- counts: rateLimited=0 swapError=0 momentumRejects=181

Top reject buckets (state.debug.last + candidates tail best-effort):
- momentum: 97
- routeAvailable: 3

Planned knob changes:
- LIVE_PARALLEL_QUOTE_FANOUT_N: 3 -> 4
- LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 3 -> 4
- LIVE_REJECT_RECHECK_BURST_DELAY_MS: 120 -> 110
- NO_PAIR_RETRY_ATTEMPTS: 5 -> 6
- NO_PAIR_RETRY_BASE_MS: 250 -> 225
- NO_PAIR_TEMP_TTL_MS: 45000 -> 35000
- PAPER_ENTRY_RET_15M_PCT: 0.025 -> 0.022
- PAPER_ENTRY_RET_5M_PCT: 0.008 -> 0.007
- PAPER_ENTRY_COOLDOWN_MS: 120000 -> 90000
