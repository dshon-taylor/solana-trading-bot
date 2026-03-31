import { ensureWatchlistState } from './stage_watchlist_state_cache.mjs';
import { watchlistHotQueueMax, watchlistEntriesSorted } from './stage_hot_queue_prioritization.mjs';

export function normalizeEpochMsGlobal(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(String(v || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export function resolvePairCreatedAtGlobal(...vals) {
  for (const v of vals) {
    const n = normalizeEpochMsGlobal(v);
    if (n) return n;
  }
  return null;
}

export function getWatchlistMintAgeHours(row, nowMs) {
  const createdAtMs = resolvePairCreatedAtGlobal(row?.latest?.pairCreatedAt, row?.pair?.pairCreatedAt);
  if (!createdAtMs || createdAtMs > nowMs) return null;
  return (nowMs - createdAtMs) / 3_600_000;
}

export function evictWatchlist({ state, cfg, nowMs, counters }) {
  const wl = ensureWatchlistState(state);
  let evicted = 0;
  let ageEvicted = 0;
  let staleEvicted = 0;
  let ttlEvicted = 0;

  for (const [mint, row] of Object.entries(wl.mints)) {
    const mintAgeHours = getWatchlistMintAgeHours(row, nowMs);
    if (mintAgeHours != null && mintAgeHours >= cfg.WATCHLIST_EVICT_MAX_AGE_HOURS) {
      delete wl.mints[mint];
      evicted += 1;
      ageEvicted += 1;
      continue;
    }
    if (Number(row?.staleCycles || 0) >= cfg.WATCHLIST_EVICT_STALE_CYCLES) {
      delete wl.mints[mint];
      evicted += 1;
      staleEvicted += 1;
      continue;
    }
    if (Number(row?.evictAtMs || 0) <= nowMs) {
      delete wl.mints[mint];
      evicted += 1;
      ttlEvicted += 1;
    }
  }

  const size = Object.keys(wl.mints).length;
  if (size > cfg.WATCHLIST_MAX_SIZE) {
    const extra = size - cfg.WATCHLIST_MAX_SIZE;
    const victims = watchlistEntriesSorted(state).slice(0, extra);
    for (const [mint] of victims) {
      delete wl.mints[mint];
      evicted += 1;
      ttlEvicted += 1;
    }
  }

  const aliveMints = new Set(Object.keys(wl.mints || {}));
  wl.hotQueue = (wl.hotQueue || []).filter(item => aliveMints.has(item?.mint)).slice(0, watchlistHotQueueMax(cfg));

  if (evicted > 0) {
    wl.stats.evicted = Number(wl.stats.evicted || 0) + evicted;
    wl.stats.ageEvicted = Number(wl.stats.ageEvicted || 0) + ageEvicted;
    wl.stats.staleEvicted = Number(wl.stats.staleEvicted || 0) + staleEvicted;
    wl.stats.ttlEvicted = Number(wl.stats.ttlEvicted || 0) + ttlEvicted;
    counters.watchlist.evicted += evicted;
    counters.watchlist.ageEvicted += ageEvicted;
    counters.watchlist.staleEvicted += staleEvicted;
    counters.watchlist.ttlEvicted += ttlEvicted;
  }
  return evicted;
}
