import { fetchJsonWithRetry } from './fetch_retry.mjs';
import cache from './global_cache.mjs';
import { fetchJupTokenList } from './jup_tokenlist.mjs';

const BASE = 'https://public-api.birdeye.so';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickNumber(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickTimeMs(...values) {
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    // Heuristic: if it's seconds (10 digits-ish), convert to ms.
    const ms = n < 2e12 ? (n * 1000) : n;
    if (Number.isFinite(ms) && ms > 946684800000) return ms; // > year 2000
  }
  return null;
}

export function createBirdseyeLiteClient({
  enabled = false,
  apiKey = '',
  chain = 'solana',
  maxRps = 15,
  retries = 1,
  baseDelayMs = 350,
  // Cache knobs (per mint)
  cacheTtlMs = 30_000,
  perMintMinIntervalMs = 15_000,
  // Test hook
  fetchJson = fetchJsonWithRetry,
  fetchTokenList = fetchJupTokenList,
} = {}) {
  const isEnabled = !!enabled && !!String(apiKey || '').trim();

  const ttlMs = Math.max(0, Number(cacheTtlMs ?? 30_000));
  const minMintIntervalMs = Math.max(0, Number(perMintMinIntervalMs ?? 15_000));

  // Global RPS throttle (applies only to actual HTTP fetches)
  const minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(1, Number(maxRps || 15))));
  let lastAtMs = 0;

  const snapCache = new Map();

  const stats = {
    cacheHits: 0,
    cacheMisses: 0,
    wsBypassCount: 0,
    fetches: 0,
    fetchAtMs: [], // rolling timestamps (ms)
  };
  let tokenListCache = null;
  let tokenListCacheAtMs = 0;

  function noteFetch(nowMs) {
    stats.fetchAtMs.push(nowMs);
    // Cap memory: keep last ~10 minutes at 1 rps worst-case.
    if (stats.fetchAtMs.length > 10_000) stats.fetchAtMs.splice(0, stats.fetchAtMs.length - 10_000);
  }

  function getRequestRatePerMin(nowMs = Date.now()) {
    const cutoff = nowMs - 60_000;
    let n = 0;
    const arr = stats.fetchAtMs;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (arr[i] < cutoff) break;
      n += 1;
    }
    return n;
  }

  async function throttle() {
    const now = Date.now();
    const waitMs = Math.max(0, (lastAtMs + minIntervalMs) - now);
    if (waitMs > 0) await sleep(waitMs);
    lastAtMs = Date.now();
  }

  async function fetchBirdeye(pathname, params = {}) {
    await throttle();
    const url = new URL(pathname, BASE);
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    stats.fetches += 1;
    noteFetch(Date.now());
    return fetchJson(url.toString(), {
      retries,
      baseDelayMs,
      maxDelayMs: 6000,
      tag: 'BIRDEYE',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        'x-chain': chain,
      },
    });
  }

  async function fetchTokenSnapshot(mint) {
    const json = await fetchBirdeye('/defi/token_overview', { address: mint });

    const data = json?.data || null;
    if (!data) return null;

    const observedAtMs = Date.now();
    const atMs = pickTimeMs(
      data.updatedAt,
      data.updateUnixTime,
      data.updateTime,
      data.lastTradeUnixTime,
      data.lastTradeTime,
      data.lastUpdatedAt,
    ) || observedAtMs;

    const priceUsd = pickNumber(data.price, data.value, data.priceUsd);
    if (!Number.isFinite(Number(priceUsd)) || Number(priceUsd) <= 0) return null;

    const liquidityUsd = pickNumber(
      data.liquidity,
      data.liquidityUsd,
      data.liquidity_usd,
      data.liquidityValue,
    );

    const marketCapUsd = pickNumber(
      data.marketCap,
      data.market_cap,
      data.mcap,
      data.marketCapUsd,
    );

    const fdvUsd = pickNumber(
      data.fdv,
      data.fdvUsd,
      data.fdv_usd,
      data.fullyDilutedValuation,
    );

    const volume24h = pickNumber(
      data.v24hUSD,
      data.v24h,
      data.volume24h,
      data.volume24hUSD,
      data.volumeUsd24h,
    );
    // Use USD-window volumes for comparable units in volume expansion.
    const volume5m = pickNumber(
      data.v5mUSD,
      data.volume5mUSD,
      data.volume_5m_usd,
    );
    const volume30m = pickNumber(
      data.v30mUSD,
      data.volume30mUSD,
      data.volume_30m_usd,
    );
    const volume30mAvg = Number.isFinite(Number(volume30m)) && Number(volume30m) > 0
      ? (Number(volume30m) / 6)
      : pickNumber(data.volume_30m_avg, data.volume30mAvg);

    const buy24h = pickNumber(data.buy24h, data.uniqueWallet24hBuy, data.trade24hBuy) || 0;
    const sell24h = pickNumber(data.sell24h, data.uniqueWallet24hSell, data.trade24hSell) || 0;

    return {
      source: 'birdeye',
      atMs,
      observedAtMs,
      priceUsd: Number(priceUsd),
      liquidityUsd: Number.isFinite(Number(liquidityUsd)) ? Number(liquidityUsd) : null,
      marketCapUsd: Number.isFinite(Number(marketCapUsd)) ? Number(marketCapUsd) : null,
      fdvUsd: Number.isFinite(Number(fdvUsd)) ? Number(fdvUsd) : null,
      txns: { h1: {}, h24: { buys: Number(buy24h), sells: Number(sell24h) } },
      volume: { h24: Number.isFinite(Number(volume24h)) ? Number(volume24h) : 0 },
      volume_5m: Number.isFinite(Number(volume5m)) ? Number(volume5m) : null,
      volume_30m_avg: Number.isFinite(Number(volume30mAvg)) ? Number(volume30mAvg) : null,
      raw: data,
    };
  }

  function wsDerivedForMint(mint) {
    const key = String(mint || '').trim();
    if (!key) return null;
    const price = cache.get(`birdeye:ws:price:${key}`) || null;
    const series = cache.get(`birdeye:ws:series:${key}`) || [];
    const txs = cache.get(`birdeye:ws:tx:${key}`) || [];
    if (!price && !series.length && !txs.length) return null;

    const now = Date.now();
    const s5 = series.filter(x => (now - Number(x.t || 0)) <= 5 * 60_000);
    const s30 = series.filter(x => (now - Number(x.t || 0)) <= 30 * 60_000);
    const volume5m = s5.reduce((a, b) => a + Number(b.v || 0), 0);
    const volume30m = s30.reduce((a, b) => a + Number(b.v || 0), 0);
    const volume30mAvg = volume30m / 6;
    const rollingHigh5m = s5.length ? Math.max(...s5.map(x => Number(x.c || 0))) : Number(price?.priceUsd || 0);

    const tx1m = txs.filter(x => (now - Number(x.t || 0)) <= 60_000);
    const tx5m = txs.filter(x => (now - Number(x.t || 0)) <= 5 * 60_000);
    const tx30m = txs.filter(x => (now - Number(x.t || 0)) <= 30 * 60_000);
    const tx1h = txs.filter(x => (now - Number(x.t || 0)) <= 60 * 60_000);
    const buys1h = tx1h.filter(x => String(x.side || '') === 'buy').length;
    const sells1h = tx1h.filter(x => String(x.side || '') === 'sell').length;
    const buySellRatio = sells1h > 0 ? (buys1h / sells1h) : (buys1h > 0 ? 99 : 0);

    return {
      atMs: Number(price?.tsMs || now),
      priceUsd: Number(price?.priceUsd || 0) || null,
      volume_5m: volume5m,
      volume_30m_avg: volume30mAvg,
      tx_1m: tx1m.length,
      tx_5m_avg: tx5m.length / 5,
      tx_30m_avg: tx30m.length / 30,
      tx_1h: tx1h.length,
      rolling_high_5m: rollingHigh5m,
      buySellRatio,
    };
  }

  async function getTokenSnapshot(mint) {
    if (!isEnabled || !mint) return null;

    const key = String(mint).trim();
    if (!key) return null;

    const nowMs = Date.now();
    const entry = snapCache.get(key) || null;
    const cached = entry?.snapshot || null;

    if (cached && ttlMs > 0) {
      const ageMs = Math.max(0, nowMs - Number(entry.cachedAtMs || 0));
      if (ageMs <= ttlMs) {
        const ws = wsDerivedForMint(key);
        const merged = ws
          ? {
              ...cached,
              atMs: Number(ws.atMs || cached.atMs || nowMs),
              priceUsd: Number(ws.priceUsd || cached.priceUsd || 0),
              txns: {
                ...(cached.txns || {}),
                h1: {
                  buys: Number(ws.tx_1h || 0),
                  sells: Number(ws.tx_1h || 0) > 0 ? Math.max(0, Math.round((ws.tx_1h || 0) / Math.max(1, Number(ws.buySellRatio || 1)))) : 0,
                },
              },
              volume: {
                ...(cached.volume || {}),
                h1: Number(ws.volume_5m || 0) * 12,
              },
              raw: {
                ...(cached.raw || {}),
                volume_5m: ws.volume_5m,
                volume_30m_avg: ws.volume_30m_avg,
                tx_1m: ws.tx_1m,
                tx_5m_avg: ws.tx_5m_avg,
                tx_30m_avg: ws.tx_30m_avg,
                tx_1h: ws.tx_1h,
                rolling_high_5m: ws.rolling_high_5m,
                buySellRatio: ws.buySellRatio,
              },
            }
          : cached;
        stats.cacheHits += 1;
        return merged;
      }
    }

    // Even if stale, avoid refetching too frequently per mint.
    if (cached && minMintIntervalMs > 0) {
      const sinceFetchMs = Math.max(0, nowMs - Number(entry.lastFetchAtMs || 0));
      if (sinceFetchMs <= minMintIntervalMs) {
        const ws = wsDerivedForMint(key);
        const merged = ws
          ? {
              ...cached,
              atMs: Number(ws.atMs || cached.atMs || nowMs),
              priceUsd: Number(ws.priceUsd || cached.priceUsd || 0),
              raw: {
                ...(cached.raw || {}),
                volume_5m: ws.volume_5m,
                volume_30m_avg: ws.volume_30m_avg,
                tx_1m: ws.tx_1m,
                tx_5m_avg: ws.tx_5m_avg,
                tx_30m_avg: ws.tx_30m_avg,
                tx_1h: ws.tx_1h,
                rolling_high_5m: ws.rolling_high_5m,
                buySellRatio: ws.buySellRatio,
              },
            }
          : cached;
        stats.cacheHits += 1;
        return merged;
      }
    }

    // WS fast path: if WS data is fresh enough, skip REST entirely (zero CU churn).
    // Env: BIRDEYE_WS_FRESHNESS_BYPASS_MS (default 10 s). Set to 0 to disable.
    const wsFastPathMs = Math.max(0, Number(process.env.BIRDEYE_WS_FRESHNESS_BYPASS_MS ?? 10_000));
    if (wsFastPathMs > 0) {
      const ws = wsDerivedForMint(key);
      if (ws && ws.priceUsd > 0) {
        const wsAgeMs = Math.max(0, nowMs - Number(ws.atMs || 0));
        if (wsAgeMs <= wsFastPathMs) {
          stats.cacheHits += 1;
          stats.wsBypassCount += 1;
          return {
            source: 'birdeye_ws',
            atMs: ws.atMs,
            observedAtMs: nowMs,
            priceUsd: ws.priceUsd,
            liquidityUsd: cached?.liquidityUsd ?? null,
            marketCapUsd: cached?.marketCapUsd ?? null,
            fdvUsd: cached?.fdvUsd ?? null,
            txns: {
              ...(cached?.txns || {}),
              h1: {
                buys: Number(ws.tx_1h || 0),
                sells: Number(ws.tx_1h || 0) > 0
                  ? Math.max(0, Math.round(Number(ws.tx_1h) / Math.max(1, Number(ws.buySellRatio || 1))))
                  : 0,
              },
            },
            volume: { ...(cached?.volume || {}), h1: Number(ws.volume_5m || 0) * 12 },
            volume_5m: ws.volume_5m,
            volume_30m_avg: ws.volume_30m_avg,
            raw: {
              ...(cached?.raw || {}),
              volume_5m: ws.volume_5m,
              volume_30m_avg: ws.volume_30m_avg,
              tx_1m: ws.tx_1m,
              tx_5m_avg: ws.tx_5m_avg,
              tx_30m_avg: ws.tx_30m_avg,
              tx_1h: ws.tx_1h,
              rolling_high_5m: ws.rolling_high_5m,
              buySellRatio: ws.buySellRatio,
            },
          };
        }
      }
    }

    stats.cacheMisses += 1;

    // Record intent to fetch now so concurrent callers don't all burst.
    const nextEntry = {
      snapshot: cached,
      cachedAtMs: Number(entry?.cachedAtMs || 0),
      lastFetchAtMs: nowMs,
    };
    snapCache.set(key, nextEntry);

    const snap = await fetchTokenSnapshot(key);
    if (!snap) return cached;

    snapCache.set(key, {
      snapshot: snap,
      cachedAtMs: Date.now(),
      lastFetchAtMs: Date.now(),
    });

    return snap;
  }

  function parseHistoricalPriceFromJson(json) {
    const d = json?.data;
    if (!d) return null;
    const direct = pickNumber(d.price, d.value, d.priceUsd, d.close, d.c);
    if (direct && direct > 0) return Number(direct);

    const candidates = [];
    if (Array.isArray(d.items)) candidates.push(...d.items);
    if (Array.isArray(d.list)) candidates.push(...d.list);
    if (Array.isArray(d.points)) candidates.push(...d.points);
    if (Array.isArray(d.ohlcv_list)) candidates.push(...d.ohlcv_list);
    if (Array.isArray(d.candles)) candidates.push(...d.candles);

    if (candidates.length > 0) {
      const last = candidates[candidates.length - 1] || {};
      const p = pickNumber(last.price, last.value, last.priceUsd, last.close, last.c);
      if (p && p > 0) return Number(p);
      if (Array.isArray(last) && last.length >= 5) {
        const c = pickNumber(last[4], last[1]);
        if (c && c > 0) return Number(c);
      }
    }
    return null;
  }

  async function getTokenSnapshotAt(mint, atMs, { toleranceSec = 120 } = {}) {
    if (!isEnabled || !mint || !Number.isFinite(Number(atMs))) return null;
    const tsSec = Math.floor(Number(atMs) / 1000);
    const fromSec = Math.max(1, tsSec - Math.max(30, Number(toleranceSec || 120)));
    const toSec = tsSec + Math.max(30, Number(toleranceSec || 120));

    const endpointAttempts = [
      ['/defi/historical_price_unix', { address: mint, unixtime: tsSec }],
      ['/defi/price', { address: mint, time: tsSec }],
      ['/defi/history_price', { address: mint, address_type: 'token', type: '1m', time_from: fromSec, time_to: toSec }],
      ['/defi/ohlcv', { address: mint, type: '1m', time_from: fromSec, time_to: toSec }],
      ['/defi/token_overview', { address: mint }],
    ];

    let lastErr = null;
    for (const [pathname, params] of endpointAttempts) {
      try {
        const json = await fetchBirdeye(pathname, params);
        const price = parseHistoricalPriceFromJson(json);
        if (!(price > 0)) continue;
        const data = json?.data || null;
        const liq = pickNumber(data?.liquidity, data?.liquidityUsd, data?.liquidity_usd, data?.liquidityValue);
        const holders = pickNumber(data?.holders, data?.holderCount, data?.holder);
        const uniqueBuyers = pickNumber(data?.uniqueWallet24hBuy, data?.uniqueBuyers);
        return {
          source: 'birdeye_historical',
          atMs: Number(atMs),
          observedAtMs: Date.now(),
          priceUsd: Number(price),
          liquidityUsd: Number.isFinite(Number(liq)) ? Number(liq) : null,
          raw: data,
          participation: {
            holders: Number.isFinite(Number(holders)) ? Number(holders) : null,
            uniqueBuyers: Number.isFinite(Number(uniqueBuyers)) ? Number(uniqueBuyers) : null,
          },
          endpoint: pathname,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) return null;
    return null;
  }

  function getStats(nowMs = Date.now()) {
    const hits = Number(stats.cacheHits || 0);
    const misses = Number(stats.cacheMisses || 0);
    const lookups = hits + misses;
    const fetchPerMin = getRequestRatePerMin(nowMs);

    // Projected daily fetches and CU estimate (configurable via env)
    const projectedDailyFetches = fetchPerMin * 60 * 24;
    const cuPerFetch = Number(process.env.BIRDEYE_CU_PER_FETCH || 1);
    const projectedDailyCu = projectedDailyFetches * cuPerFetch;
    const cuGuardEnabled = (process.env.BIRDEYE_CU_GUARD_ENABLED || 'false') === 'true';
    const cuDailyBudget = Number(process.env.BIRDEYE_CU_DAILY_BUDGET || 2000000);

    return {
      enabled: isEnabled,
      ttlMs,
      perMintMinIntervalMs: minMintIntervalMs,
      cacheSize: snapCache.size,
      cacheHits: hits,
      cacheMisses: misses,
      wsBypassCount: Number(stats.wsBypassCount || 0),
      cacheHitRate: lookups > 0 ? hits / lookups : null,
      fetches: Number(stats.fetches || 0),
      fetchPerMin,
      projectedDailyFetches,
      projectedDailyCu,
      cuGuardEnabled,
      cuDailyBudget,
      cuBudgetExceeded: cuGuardEnabled ? (projectedDailyCu > cuDailyBudget) : false,
    };
  }

  async function listJupiterTokens(nowMs = Date.now()) {
    const ttlMsTokens = Math.max(30_000, Number(process.env.JUP_TOKENS_CACHE_MS || 15 * 60_000));
    if (Array.isArray(tokenListCache) && (nowMs - Number(tokenListCacheAtMs || 0)) <= ttlMsTokens) {
      return tokenListCache;
    }
    try {
      const rows = await fetchTokenList();
      tokenListCache = Array.isArray(rows) ? rows : [];
      tokenListCacheAtMs = nowMs;
      return tokenListCache;
    } catch {
      // Keep this best-effort and non-fatal for scanner/candidate pipeline.
      if (Array.isArray(tokenListCache)) return tokenListCache;
      return [];
    }
  }

  return {
    enabled: isEnabled,
    getTokenSnapshot,
    getTokenSnapshotAt,
    getStats,
    listJupiterTokens,
  };
}
