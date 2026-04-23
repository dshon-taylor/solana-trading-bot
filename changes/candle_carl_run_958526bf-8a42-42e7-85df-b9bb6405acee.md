run-id: 958526bf-8a42-42e7-85df-b9bb6405acee
timestamp-ct: 2026-04-19 07:08:59 PM CT
changes:
- MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE: 0.62 -> 0.55 (low-risk)
- LIVE_PROBE_MIN_LIQ_USD: 15000 -> 10000 (low-risk)
- LIVE_CANDIDATE_SHORTLIST_N: 12 -> 20 (low-risk)
reason: "Observed zero active candidates (trackedMints:0); likely input filters too strict. Applied non-invasive parameter relaxations to increase candidate flow while staying within risk budget."
notes: "These are low-risk, reversible parameter tweaks. If metrics worsen for 2 consecutive runs, will auto-revert in next run."
