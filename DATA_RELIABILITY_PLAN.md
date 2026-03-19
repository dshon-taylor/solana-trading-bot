# Candle Carl Data Reliability Plan

## Goal
Increase market-data reliability under upstream throttling (DexScreener 429s) and reduce restart-churn impact, while keeping trading-risk behavior unchanged.

---

## Phase 1 — Immediate Mitigations (implemented)

1. **Graceful fallback for pair fetches**
   - Cache last known good pair snapshots per mint in state.
   - If DexScreener pair fetch fails, use cached pair (bounded TTL) instead of hard-rejecting immediately.
   - Apply fallback in:
     - scanner candidate evaluation
     - open-position stop/exit monitoring loop

2. **Throttle pressure handling without hard-fail loops**
   - Keep existing Dex cooldown, but also adapt scan pacing based on recent 429 streak/cooldown pressure.
   - Add jitter to avoid synchronized request bursts.

3. **Churn avoidance defaults**
   - Continue operation with degraded mode (cached data) where safe.
   - Avoid crash/restart pathways for transient market-data failures.

---

## Phase 2 — Failover Architecture (implemented baseline)

1. **In-process data failover path**
   - Primary: live DexScreener token-pairs API.
   - Secondary: cached last-good pair snapshot (freshness bounded by `PAIR_CACHE_MAX_AGE_MS`).

2. **State-backed reliability memory**
   - Persist cache and pacing state in bot state so restart does not reset all reliability signals.

3. **Degradation semantics**
   - Continue scanning and position checks with cache fallback during temporary upstream instability.
   - Keep strategy rules unchanged; only data acquisition path degrades.

---

## Phase 3 — Adaptive Pacing/Backoff (next)

1. Add per-endpoint request budgets (boosted, pairs, SOL price) with token-bucket controls.
2. Use `Retry-After` hints globally and dynamically lower candidate breadth when pressure rises.
3. Introduce short half-open probes during cooldown to recover earlier when API normalizes.

---

## Phase 4 — Observability/Alerts (next)

1. Add reliability metrics counters:
   - live pair fetch success/fail
   - cache fallback hits
   - cache stale misses
   - effective scan delay
2. Add hourly Telegram reliability digest and `/reliability` command.
3. Extend `/healthz` with degradation state fields.

---

## Phase 5 — Rollback/Safety Controls (next)

1. Feature flags:
   - `PAIR_CACHE_FALLBACK_ENABLED`
   - `ADAPTIVE_SCAN_PACING_ENABLED`
2. Runtime toggles via Telegram controls to disable fallback/pacing if unexpected behavior appears.
3. One-command rollback runbook:
   - revert to fixed scan cadence
   - bypass cache fallback
   - keep circuit breaker intact.

---

## Config knobs added

- `PAIR_CACHE_MAX_AGE_MS` (default: 7 minutes)
- `SCAN_BACKOFF_MAX_MS` (default: 5 minutes)

These control degradation bounds only (not trading-risk rules).
