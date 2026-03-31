import { toBaseUnits, DECIMALS } from '../trader.mjs';
import { getRouteQuoteWithFallback } from './route_control.mjs';

export function ensureWatchlistState(state) {
  state.watchlist ||= {
    mints: {},
    hotQueue: [],
    routeCache: {},
    stats: { ingested: 0, refreshed: 0, evicted: 0, ageEvicted: 0, staleEvicted: 0, ttlEvicted: 0, lastEvalAtMs: 0 },
  };
  state.watchlist.mints ||= {};
  state.watchlist.hotQueue ||= [];
  state.watchlist.routeCache ||= {};
  state.watchlist.stats ||= { ingested: 0, refreshed: 0, evicted: 0, ageEvicted: 0, staleEvicted: 0, ttlEvicted: 0, lastEvalAtMs: 0 };
  return state.watchlist;
}

export function pruneRouteCache({ state, cfg, nowMs = Date.now() }) {
  const wl = ensureWatchlistState(state);
  const cache = wl.routeCache || {};
  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  for (const [mint, entry] of Object.entries(cache)) {
    const atMs = Number(entry?.atMs || 0);
    if (!atMs || (nowMs - atMs) > ttlMs) {
      delete cache[mint];
    }
  }
  const maxSize = Math.max(8, Number(cfg.ROUTE_CACHE_MAX_SIZE || 0));
  const entries = Object.entries(cache);
  if (entries.length > maxSize) {
    entries
      .sort((a, b) => Number(a?.[1]?.atMs || 0) - Number(b?.[1]?.atMs || 0))
      .slice(0, entries.length - maxSize)
      .forEach(([mint]) => {
        delete cache[mint];
      });
  }
}

export function getFreshRouteCacheEntry({ state, cfg, mint, nowMs = Date.now() }) {
  if (!cfg.ROUTE_CACHE_ENABLED) return null;
  const wl = ensureWatchlistState(state);
  const entry = wl.routeCache?.[mint] || null;
  if (!entry) return null;
  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  const ageMs = Math.max(0, nowMs - Number(entry?.atMs || 0));
  if (ageMs > ttlMs) return null;
  const pi = Number(entry?.priceImpactPct || 0);
  if (pi > 0 && pi > Number(cfg.MAX_PRICE_IMPACT_PCT || 0)) return null;
  return entry;
}

export function cacheRouteReadyMint({ state, cfg, mint, quote, nowMs = Date.now(), source = null }) {
  if (!cfg.ROUTE_CACHE_ENABLED) return;
  const wl = ensureWatchlistState(state);
  if (!mint || !quote?.routePlan?.length) return;
  wl.routeCache[mint] = {
    mint,
    atMs: nowMs,
    source,
    slippageBps: Number(cfg.DEFAULT_SLIPPAGE_BPS || 0),
    amountUsd: Number(cfg.JUP_PREFILTER_AMOUNT_USD || 0),
    priceImpactPct: Number(quote?.priceImpactPct || 0),
    outAmount: quote?.outAmount ?? null,
    routeLabel: quote?.routePlan?.[0]?.swapInfo?.label || null,
    hops: Number(quote?.routePlan?.length || 0),
  };
  pruneRouteCache({ state, cfg, nowMs });
}

export async function resolveWatchlistRouteMeta({ cfg, state, mint, row, solUsdNow, nowMs, counters }) {
  const wl = ensureWatchlistState(state);
  const cached = wl.routeCache?.[mint] || null;
  if (!cfg.ROUTE_CACHE_ENABLED || !cached) {
    counters.watchlist.routeCacheMiss += 1;
    return { fromCache: false, cacheUsed: false, staleInvalidated: false, quote: null };
  }

  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  const ageMs = Math.max(0, nowMs - Number(cached?.atMs || 0));
  if (ageMs > ttlMs) {
    counters.watchlist.routeCacheMiss += 1;
    counters.watchlist.routeCacheStaleInvalidated += 1;
    delete wl.routeCache[mint];
    return { fromCache: false, cacheUsed: false, staleInvalidated: true, quote: null };
  }

  try {
    const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
    const route = await getRouteQuoteWithFallback({
      cfg,
      mint,
      amountLamports: lam,
      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
      solUsdNow,
      source: 'watchlist-route-cache-recheck',
    });
    if (!route.routeAvailable || !route.quote) {
      counters.watchlist.routeCacheMiss += 1;
      counters.watchlist.routeCacheStaleInvalidated += 1;
      delete wl.routeCache[mint];
      return { fromCache: false, cacheUsed: false, staleInvalidated: true, quote: null };
    }
    counters.watchlist.routeCacheHit += 1;
    row.routeHint = true;
    cacheRouteReadyMint({ state, cfg, mint, quote: route.quote, nowMs, source: `watchlist-recheck:${route.provider}` });
    return { fromCache: true, cacheUsed: true, staleInvalidated: false, quote: route.quote };
  } catch {
    counters.watchlist.routeCacheMiss += 1;
    return { fromCache: false, cacheUsed: false, staleInvalidated: false, quote: null };
  }
}

export function watchlistHotQueueMax(cfg) {
  return Math.max(8, Number(cfg.WATCHLIST_HOT_QUEUE_MAX || 16));
}

export function readPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? (n * 100) : n;
}

export function getRowHotScore(row) {
  const s = row?.snapshot || {};
  const latest = row?.latest || {};
  const tx30s = Number(s?.txns?.s30?.buys || 0) + Number(s?.txns?.s30?.sells || 0);
  const tx5m = Number(s?.txns?.m5?.buys || 0) + Number(s?.txns?.m5?.sells || 0);
  const tx5mAvg = tx5m > 0 ? (tx5m / 10) : 0;
  const txAccel = tx30s > 0 && tx5mAvg > 0 ? (tx30s / Math.max(1, tx5mAvg)) : 0;
  const ret1 = Number.isFinite(Number(s?.priceChange?.m1))
    ? Number(s?.priceChange?.m1)
    : (Number(latest?.pc1h || 0) / 60);
  const piNow = Number(latest?.priceImpactPct ?? s?.entryHints?.priceImpactPct ?? 0);
  const piBase = Number(row?.meta?.priceImpactBase || piNow || 0);
  const impactExpansion = piNow > 0 && piBase > 0 ? (piNow / Math.max(0.0001, piBase)) : 0;
  const liq = Number(latest?.liqUsd || 0);

  return (txAccel * 4) + (ret1 * 1.5) + (impactExpansion * 2) + (Math.log10(Math.max(1, liq)) * 1.2);
}

export function queueHotWatchlistMint({ state, cfg, mint, nowMs, priority = 1, reason = 'unspecified', counters = null }) {
  const wl = ensureWatchlistState(state);
  const queue = Array.isArray(wl.hotQueue) ? wl.hotQueue : [];
  const existingIdx = queue.findIndex(x => x?.mint === mint);
  const hotUntilMs = nowMs + Number(cfg.HOT_TTL_MS || 600_000);
  const next = { mint, atMs: nowMs, priority: Number(priority || 1), hotUntilMs, reason };
  if (existingIdx >= 0) {
    const prev = queue[existingIdx] || {};
    queue.splice(existingIdx, 1);
    next.priority = Math.max(Number(prev.priority || 0), next.priority);
    next.hotUntilMs = Math.max(Number(prev.hotUntilMs || 0), next.hotUntilMs);
  }
  queue.push(next);
  queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
  const max = watchlistHotQueueMax(cfg);
  if (queue.length > max) {
    const candidateRow = wl.mints?.[mint] || null;
    const candidateScore = getRowHotScore(candidateRow);
    let lowestIdx = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < queue.length; i += 1) {
      const qMint = String(queue[i]?.mint || '');
      const row = wl.mints?.[qMint] || null;
      const score = getRowHotScore(row);
      if (score < lowestScore) {
        lowestScore = score;
        lowestIdx = i;
      }
    }
    const margin = 0.5;
    if (candidateScore > (lowestScore + margin)) {
      if (lowestIdx >= 0) {
        queue.splice(lowestIdx, 1);
        counters && (counters.watchlist.capEvictions = Number(counters.watchlist.capEvictions || 0) + 1);
      }
    } else {
      const idxCandidate = queue.findIndex(x => x?.mint === mint);
      if (idxCandidate >= 0) queue.splice(idxCandidate, 1);
      counters && (counters.watchlist.rejectedDueToCap = Number(counters.watchlist.rejectedDueToCap || 0) + 1);
    }
    queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
    if (queue.length > max) queue.length = max;
  }
  wl.hotQueue = queue;
  if (counters?.watchlist) {
    counters.watchlist.hotQueueSizeSamples ||= [];
    counters.watchlist.hotQueueSizeSamples.push({ tMs: nowMs, size: Number(queue.length || 0), cap: Number(max || 0) });
    if (counters.watchlist.hotQueueSizeSamples.length > 200) counters.watchlist.hotQueueSizeSamples = counters.watchlist.hotQueueSizeSamples.slice(-200);
  }
}

export function watchlistEntriesSorted(state) {
  const wl = ensureWatchlistState(state);
  return Object.entries(wl.mints).sort((a, b) => {
    const aT = Number(a?.[1]?.lastEvaluatedAtMs || 0);
    const bT = Number(b?.[1]?.lastEvaluatedAtMs || 0);
    return aT - bT;
  });
}

export function watchlistEntriesPrioritized({ state, cfg, limit, nowMs }) {
  const wl = ensureWatchlistState(state);
  const mints = wl.mints || {};
  const activeMints = new Set(Object.keys(mints));

  const validHotItems = [];
  const hotQueue = wl.hotQueue || [];

  for (let i = 0; i < hotQueue.length; i++) {
    const item = hotQueue[i];
    const mint = item?.mint;
    const hotUntil = Number(item?.hotUntilMs || 0);

    if (mint && activeMints.has(mint) && hotUntil > nowMs) {
      validHotItems.push({
        mint,
        priority: Number(item?.priority || 0),
        atMs: Number(item?.atMs || 0),
        hotUntilMs: hotUntil,
        item,
      });
    }
  }

  validHotItems.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    return priorityDiff !== 0 ? priorityDiff : b.atMs - a.atMs;
  });

  const picked = [];
  const seen = new Set();

  for (let i = 0; i < validHotItems.length && picked.length < limit; i++) {
    const { mint } = validHotItems[i];
    if (seen.has(mint)) continue;

    const row = mints[mint];
    if (!row) continue;

    picked.push([mint, row, true]);
    seen.add(mint);
  }

  if (picked.length < limit) {
    const mintsWithTime = [];

    for (const mint in mints) {
      if (seen.has(mint)) continue;
      const row = mints[mint];
      mintsWithTime.push({
        mint,
        row,
        time: Number(row?.lastEvaluatedAtMs || 0),
      });
    }

    mintsWithTime.sort((a, b) => a.time - b.time);

    for (let i = 0; i < mintsWithTime.length && picked.length < limit; i++) {
      const { mint, row } = mintsWithTime[i];
      picked.push([mint, row, false]);
      seen.add(mint);
    }
  }

  const maxHotQueue = watchlistHotQueueMax(cfg);
  const newHotQueue = [];

  for (let i = 0; i < validHotItems.length && newHotQueue.length < maxHotQueue; i++) {
    const { mint, item } = validHotItems[i];
    if (!seen.has(mint)) {
      newHotQueue.push(item);
    }
  }

  wl.hotQueue = newHotQueue;

  return picked;
}

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

export function formatWatchlistSummary({ state, counters, nowMs = Date.now() }) {
  const wl = ensureWatchlistState(state);
  const size = Object.keys(wl.mints || {}).length;
  const hotDepth = Number((wl.hotQueue || []).length);
  const oldestMs = Math.min(...Object.values(wl.mints || {}).map(x => Number(x?.firstSeenAtMs || nowMs)), nowMs);
  const spanMin = size > 0 ? ((nowMs - oldestMs) / 60000) : 0;
  const minute = counters?.watchlist?.funnelMinute || {};
  const cumulative = counters?.watchlist?.funnelCumulative || {};
  const immediateBlockedTop = Object.entries(counters?.watchlist?.immediateBlockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ') || 'none';
  const minuteTopBlocked = Object.entries(minute?.blockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}/m`)
    .join(', ') || 'none';
  const topBlocked = Object.entries(cumulative?.blockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ') || 'none';
  return `🧺 watchlist size=${size} hotDepth=${hotDepth} spanMin=${spanMin.toFixed(1)} churn(+${Number(wl.stats?.ingested || 0)}/~${Number(wl.stats?.refreshed || 0)}/-${Number(wl.stats?.evicted || 0)} age=${Number(wl.stats?.ageEvicted || 0)} stale=${Number(wl.stats?.staleEvicted || 0)} ttl=${Number(wl.stats?.ttlEvicted || 0)}) hot(enq/cons/att/fill)=${Number(counters?.watchlist?.hotEnqueued || 0)}/${Number(counters?.watchlist?.hotConsumed || 0)}/${Number(counters?.watchlist?.hotAttempts || 0)}/${Number(counters?.watchlist?.hotFills || 0)} routeCache(hit/miss/fromCache/staleInvalid)=${Number(counters?.watchlist?.routeCacheHit || 0)}/${Number(counters?.watchlist?.routeCacheMiss || 0)}/${Number(counters?.watchlist?.attemptFromRouteCache || 0)}/${Number(counters?.watchlist?.routeCacheStaleInvalidated || 0)} immediate(promoted/confirm/att/fill)=${Number(counters?.watchlist?.immediateRoutePromoted || 0)}/${Number(counters?.watchlist?.immediateConfirmPassed || 0)}/${Number(counters?.watchlist?.immediateAttempts || 0)}/${Number(counters?.watchlist?.immediateFills || 0)} immediateBlockedTop=${immediateBlockedTop} minute(seen/eval/momo/confirm/attempt/fill)=${Number(minute.watchlistSeen || 0)}/${Number(minute.watchlistEvaluated || 0)}/${Number(minute.momentumPassed || 0)}/${Number(minute.confirmPassed || 0)}/${Number(minute.attempted || 0)}/${Number(minute.filled || 0)} blockedTop/min=${minuteTopBlocked} cumulative=${Number(cumulative.watchlistSeen || 0)}/${Number(cumulative.watchlistEvaluated || 0)}/${Number(cumulative.momentumPassed || 0)}/${Number(cumulative.confirmPassed || 0)}/${Number(cumulative.attempted || 0)}/${Number(cumulative.filled || 0)} blockedTop=${topBlocked}`;
}

export function bumpImmediateBlockedReason(counters, blockedReason) {
  counters.watchlist.immediateBlockedByReason ||= {};
  const key = String(blockedReason || 'unknown');
  counters.watchlist.immediateBlockedByReason[key] = Number(counters.watchlist.immediateBlockedByReason[key] || 0) + 1;
}
