# Live Entry Conversion Reliability Audit — 2026-02-26

## Scope covered
End-to-end pass across:
- candidate ingest
- pair fetch + routeAvailable/no-pair handling
- watchlist ingest/eval + momentum + confirm
- attempt + executeSwap
- post-trade/watchlist tracking counters
- aggressive/watchlist/route-cache/force-attempt/canary interaction review

## Bugs found

1. **Route-cache confirm path dropped expectedOutAmount (silent degrade guard bypass)**  
   - **Severity:** High (conversion quality / slippage safety)  
   - **Location:** `src/index.mjs` (`evaluateWatchlistRows`)  
   - **Issue:** In the `routeMeta.fromCache` path, `expectedOutAmount` remained `null`, so `executeSwap()` skipped quote-degrade validation (`maxQuoteDegradePct`) for route-cached attempts.  
   - **Impact:** Route-cache attempts could execute without the intended final outAmount floor check.

2. **Forced-attempt watchlist fill accounting checked wrong field (`entryTx` vs `signature`)**  
   - **Severity:** Medium (observability/state consistency)  
   - **Location:** `src/index.mjs` forced-attempt block  
   - **Issue:** `openPosition()` returns swap result with `signature`, but code checked `entryRes?.entryTx`; condition never true.  
   - **Impact:** `watchlist.lastFillAtMs` / `totalFills` not updated for successful forced attempts, causing stale watchlist stats and misleading funnel/ops visibility.

## Fixes applied

- **Fix 1:** In watchlist route-cache path, now sets:
  - `expectedOutAmount = Number(routeMeta?.quote?.outAmount || 0) || null`
- **Fix 2:** Added `didEntryFill()` helper in `src/entry_reliability.mjs` and switched forced-attempt fill detection to use it (`signature` or legacy `entryTx`).
- **Tests added:** `test/entry_reliability.test.mjs`
  - validates modern `signature`
  - validates legacy `entryTx`
  - validates false for empty/null

## Validation

- `npm run -s typecheck` ✅
- `npm test --silent` ✅ (18 files, 54 tests)
- PM2 restart: `solana-momentum-bot` ✅
- Health endpoint: `http://127.0.0.1:8787/healthz` ✅ (`ok:true`, process online)

## Remaining risks

- Watchlist blocked-reason keys are dynamically stage-prefixed (e.g. `forcePolicy.forcePolicyMintCooldown`), while static reason baselines in metrics are unprefixed. Not breaking, but can fragment dashboards/alert thresholds.
- Large `src/index.mjs` still centralizes many gates; regression surface remains high unless more gate logic is modularized + unit tested.

## Recommended next monitoring checks

1. **Route-cache conversion quality check (next 2–6h):**
   - Compare watchlist attempts using route cache vs non-cache (`attemptFromRouteCache`) and verify no abnormal swapError or poor fill outcomes.
2. **Forced-attempt fill accounting sanity:**
   - Confirm `watchlist.totalFills` and `lastFillAtMs` move on real forced fills.
3. **Funnel consistency:**
   - Ensure confirm→attempt→fill ratios in watchlist minute/cumulative funnels align with trade ledger entries.
4. **Optional follow-up hardening:**
   - Normalize blocked-reason key taxonomy (stage prefixes vs static keys) for cleaner alerting.

## Commits

- `36b35d5` — Fix route-cache expectedOut propagation + forced-attempt fill detection; add regression tests.
