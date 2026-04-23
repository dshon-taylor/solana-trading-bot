Autonomy run 2026-04-22 — Candle Carl

Summary:
- Increased ROUTE_CACHE_TTL_MS to 30000ms to reduce route cache churn.
- Increased WATCHLIST_EVAL_EVERY_MS to 120000ms to lower CPU/memory pressure from frequent evaluations.

Rationale: Recent diagnostics showed oscillating routeCache entries and elevated mem usage during hot evaluations. These low-risk tuning parameters aim to stabilize cache hits and reduce evaluation frequency without changing architecture.

Testing: PM2 restart applied with --update-env; bot reported online and effective config shows routeCache.ttlMs=30000 and watchlist.evalEveryMs=120000.

If regressions (worse reliability metrics) for 2 consecutive runs, rollback will be performed.
