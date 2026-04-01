import { toBaseUnits, DECIMALS } from '../../trading/trader.mjs';
import { getRouteQuoteWithFallback } from '../route_control.mjs';

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
