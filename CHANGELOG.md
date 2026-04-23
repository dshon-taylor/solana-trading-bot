2026-04-23 - Candle Carl autonomous autotune
- Lowered LIVE_CANDIDATE_SHORTLIST_N from 4 -> 2
- Lowered LIVE_PROBE_MAX_CANDIDATES from 4 -> 2
Rationale: reduce concurrent probe and shortlist work to lower memory and event-loop pressure observed in logs. Low-risk tuning step. Committed on branch tune/candle-carl-autotune-2026-04-23 (commit ca5c828).
