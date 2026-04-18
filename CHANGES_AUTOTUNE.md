2026-04-18 UTC - cron:e6e6c7e7 run
- Applied low-risk tunings to reduce runtime load and candidate throughput:
  - PAIR_FETCH_CONCURRENCY: 3 -> 1 (env override)
  - LIVE_CANDIDATE_SHORTLIST_N: 18 -> 12 (env override)
- Reason: diagnostics showed momentumRepeatFail ~9 and RSS spikes up to ~550MB; reduced fetch concurrency and shortlist size to lower CPU/memory and external request fanout.
- Files changed: trading-bot/.env (env overrides; file is .gitignored)
- Risk level: low (config/ops only, reversible)
- Notes: .env is in .gitignore so change isn't committed; recorded here and in memory.

