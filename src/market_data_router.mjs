import { jupPriceUsd } from './providers/jupiter/price.mjs';
import { validateSnapshot, computeConfidence as validatorComputeConfidence } from './lib/snapshot/validators.mjs';
import cache from './lib/cache/global_cache.mjs';

const PROVIDERS = {
  bird: 'birdeye',
  birdWs: 'birdeye_ws',
  dex: 'dexscreener',
  jup: 'jupiter',
  cache: 'cache',
};

const DEFAULTS = {
  providerCooldownBaseMs: {
    [PROVIDERS.bird]: 7_500,
    [PROVIDERS.dex]: 15_000,
    [PROVIDERS.jup]: 8_000,
  },
  providerCooldownMaxMs: 5 * 60_000,
  minEntryConfidenceScore: Number(process.env.MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE || 0.65),
  maxFreshnessMsForEntry: Number(process.env.MARKETDATA_MAX_FRESHNESS_MS_FOR_ENTRY || 20_000),
  maxFreshnessMsForStops: 180_000,
  lkgMaxEntries: 500,
};

function confidenceLabel(score) {
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}

function confidenceForSnapshot({ source, hasLiquidity, hasTxns, freshnessMs }) {
  let score = 0.25;
  if (source === PROVIDERS.bird || source === PROVIDERS.birdWs) score += 0.6;
  if (source === PROVIDERS.dex) score += 0.55;
  if (source === PROVIDERS.jup) score += 0.25;
  if (source === PROVIDERS.cache) score += 0.15;
  if (hasLiquidity) score += 0.1;
  if (hasTxns) score += 0.1;
  if (Number.isFinite(Number(freshnessMs)) && freshnessMs <= 60_000) score += 0.1;
  if (Number.isFinite(Number(freshnessMs)) && freshnessMs > 5 * 60_000) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

function ensureRouterState(state) {
  state.marketData ||= {};
  state.marketData.providers ||= {};
  state.marketData.lastKnownGood ||= {};
  state.marketData.staleSkips ||= {};
  state.marketData.staleSkipStrikes ||= {};
  return state.marketData;
}

function clearStaleSkip(state, mint) {
  if (!state?.marketData || !mint) return;
  if (state.marketData.staleSkips) delete state.marketData.staleSkips[mint];
  if (state.marketData.staleSkipStrikes) delete state.marketData.staleSkipStrikes[mint];
}

function markStaleSkip(state, mint, nowMs) {
  if (!state?.marketData || !mint) return;
  state.marketData.staleSkips ||= {};
  state.marketData.staleSkipStrikes ||= {};
  const prev = Number(state.marketData.staleSkipStrikes[mint] || 0);
  const strikes = Math.max(1, Math.min(6, prev + 1));
  state.marketData.staleSkipStrikes[mint] = strikes;

  const baseMs = Math.max(10_000, Number(process.env.SKIP_MINT_ON_STALE_BASE_MS || 60_000));
  const maxMs = Math.max(baseMs, Number(process.env.SKIP_MINT_ON_STALE_MAX_MS || 300_000));
  const skipMs = Math.min(maxMs, Math.round(baseMs * (2 ** (strikes - 1))));
  state.marketData.staleSkips[mint] = nowMs + skipMs;
}

function ensureProviderHealth(state, provider) {
  ensureRouterState(state);
  state.marketData.providers[provider] ||= {};
  const h = state.marketData.providers[provider];
  if (!Number.isFinite(Number(h.failStreak))) h.failStreak = 0;
  if (!Number.isFinite(Number(h.successStreak))) h.successStreak = 0;
  if (!Number.isFinite(Number(h.cooldownUntilMs))) h.cooldownUntilMs = 0;
  if (!Number.isFinite(Number(h.lastOkAtMs))) h.lastOkAtMs = 0;
  if (!Number.isFinite(Number(h.lastErrAtMs))) h.lastErrAtMs = 0;
  if (h.lastErrMsg === undefined) h.lastErrMsg = null;
  if (!Number.isFinite(Number(h.requests))) h.requests = 0;
  if (!Number.isFinite(Number(h.hits))) h.hits = 0;
  if (!Number.isFinite(Number(h.misses))) h.misses = 0;
  if (!Number.isFinite(Number(h.rejects))) h.rejects = 0;
  if (!Number.isFinite(Number(h.rateLimited))) h.rateLimited = 0;
  return h;
}

function markProviderRequest(state, provider) {
  const h = ensureProviderHealth(state, provider);
  h.requests = Number(h.requests || 0) + 1;
}

function markProviderHit(state, provider) {
  const h = ensureProviderHealth(state, provider);
  h.hits = Number(h.hits || 0) + 1;
}

function markProviderMiss(state, provider) {
  const h = ensureProviderHealth(state, provider);
  h.misses = Number(h.misses || 0) + 1;
}

function markProviderReject(state, provider) {
  const h = ensureProviderHealth(state, provider);
  h.rejects = Number(h.rejects || 0) + 1;
}

function markProviderSuccess(state, provider, nowMs) {
  const h = ensureProviderHealth(state, provider);
  h.failStreak = 0;
  h.successStreak = Number(h.successStreak || 0) + 1;
  h.cooldownUntilMs = 0;
  h.lastOkAtMs = nowMs;
  h.lastErrMsg = null;
}

function markProviderFailure(state, provider, nowMs, err, cooldownBaseMs, cooldownMaxMs) {
  const h = ensureProviderHealth(state, provider);
  h.failStreak = Number(h.failStreak || 0) + 1;
  h.successStreak = 0;
  h.lastErrAtMs = nowMs;
  h.lastErrMsg = err?.message || String(err || 'unknown');

  const msg = String(err?.message || '').toLowerCase();
  const status = Number(err?.status || 0);
  if (status === 429 || msg.includes('429') || msg.includes('rate limit')) {
    h.rateLimited = Number(h.rateLimited || 0) + 1;
  }

  const waitMs = Math.min(cooldownMaxMs, cooldownBaseMs * (2 ** Math.min(6, h.failStreak - 1)));
  h.cooldownUntilMs = Math.max(Number(h.cooldownUntilMs || 0), nowMs + waitMs);
}

function providerReady(state, provider, nowMs) {
  const h = ensureProviderHealth(state, provider);
  return Number(h.cooldownUntilMs || 0) <= nowMs;
}

function rememberLkg(state, mint, snapshot, nowMs, maxEntries) {
  if (!mint || !snapshot?.priceUsd) return;
  ensureRouterState(state);
  state.marketData.lastKnownGood[mint] = {
    atMs: nowMs,
    source: snapshot.source,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd ?? null,
    volume: snapshot.volume || {},
    txns: snapshot.txns || {},
    pair: snapshot.pair || null,
  };

  const rows = Object.entries(state.marketData.lastKnownGood);
  if (rows.length > maxEntries) {
    rows
      .sort((a, b) => Number(a[1]?.atMs || 0) - Number(b[1]?.atMs || 0))
      .slice(0, rows.length - maxEntries)
      .forEach(([k]) => {
        delete state.marketData.lastKnownGood[k];
      });
  }
}

function snapshotFromDexPair(pair, nowMs) {
  const priceUsd = Number(pair?.priceUsd || 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const liquidityUsd = Number(pair?.liquidity?.usd || 0) || null;
  const txns = pair?.txns || {};
  const volume = pair?.volume || {};
  const freshnessMs = 0;
  const confidenceScore = confidenceForSnapshot({
    source: PROVIDERS.dex,
    hasLiquidity: Number(liquidityUsd || 0) > 0,
    hasTxns: Number(txns?.h1?.buys || 0) + Number(txns?.h1?.sells || 0) > 0,
    freshnessMs,
  });
  return {
    source: PROVIDERS.dex,
    timestampMs: nowMs,
    freshnessMs,
    priceUsd,
    liquidityUsd,
    txns,
    volume,
    pair,
    confidenceScore,
    confidence: confidenceLabel(confidenceScore),
  };
}

export function snapshotFromBirdseye(bird, nowMs) {
  const priceUsd = Number(bird?.priceUsd || 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const pickVal = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const liquidityUsd = Number(bird?.liquidityUsd || 0) || null;
  const marketCapUsd = pickVal(
    bird?.marketCapUsd,
    bird?.raw?.marketCap,
    bird?.raw?.market_cap,
    bird?.raw?.mcap,
    bird?.raw?.marketCapUsd,
  );
  const fdvUsd = pickVal(
    bird?.fdvUsd,
    bird?.raw?.fdv,
    bird?.raw?.fdvUsd,
    bird?.raw?.fdv_usd,
  );

  // Normalize: Birdseye overview is often 24h aggregates. For watchlist gating we want 1h-ish hints.
  const tx24b = Number(bird?.txns?.h24?.buys || 0);
  const tx24s = Number(bird?.txns?.h24?.sells || 0);
  const tx1hHintBuys = Math.max(0, tx24b / 24);
  const tx1hHintSells = Math.max(0, tx24s / 24);

  const vol24 = Number(bird?.volume?.h24 || 0);
  const vol1hHint = Math.max(0, vol24 / 24);

  const txns = {
    ...(bird?.txns || {}),
    h1: {
      // If upstream already supplies h1, keep it; otherwise attach hints.
      ...(bird?.txns?.h1 || {}),
      buys: Number.isFinite(Number(bird?.txns?.h1?.buys)) ? Number(bird.txns.h1.buys) : tx1hHintBuys,
      sells: Number.isFinite(Number(bird?.txns?.h1?.sells)) ? Number(bird.txns.h1.sells) : tx1hHintSells,
      _hintFromH24: true,
    },
    h24: {
      ...(bird?.txns?.h24 || {}),
      buys: tx24b,
      sells: tx24s,
    },
  };

  const volume = {
    ...(bird?.volume || {}),
    h1: Number.isFinite(Number(bird?.volume?.h1)) ? Number(bird.volume.h1) : vol1hHint,
    h24: vol24,
  };

  const pickNum = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  const pickNumPositive = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };

  const tx1hTotal = Number(txns?.h1?.buys || 0) + Number(txns?.h1?.sells || 0);
  const tx1mObserved = Number(txns?.m1?.buys || 0) + Number(txns?.m1?.sells || 0);
  const tx5mObserved = Number(txns?.m5?.buys || 0) + Number(txns?.m5?.sells || 0);
  const tx30mObserved = Number(txns?.m30?.buys || 0) + Number(txns?.m30?.sells || 0);
  const trade1mTotal = pickNumPositive(bird?.raw?.trade1m, bird?.trade1m);
  const trade5mTotal = pickNumPositive(bird?.raw?.trade5m, bird?.trade5m);
  const trade30mRaw = pickNumPositive(bird?.raw?.trade30m, bird?.trade30m);
  const trade30mLooksPlausible = trade30mRaw > 0
    && trade30mRaw <= Math.max(5000, (trade5mTotal > 0 ? trade5mTotal * 50 : 0), (trade1mTotal > 0 ? trade1mTotal * 300 : 0));
  const trade30mTotal = trade30mLooksPlausible ? trade30mRaw : 0;

  const tx1mFallback = trade1mTotal > 0
    ? trade1mTotal
    : (tx1mObserved > 0 ? tx1mObserved : (tx1hTotal / 60));
  const tx5mAvgFallback = trade5mTotal > 0
    ? (trade5mTotal / 5)
    : (tx5mObserved > 0
      ? (tx5mObserved / 5)
      : ((tx1mObserved > 0) ? (((tx1hTotal / 60) * 4 + tx1mObserved) / 5) : (tx1hTotal / 60)));
  const tx30mAvgFallback = trade30mTotal > 0
    ? (trade30mTotal / 30)
    : (tx30mObserved > 0 ? (tx30mObserved / 30) : (tx1hTotal / 60));

  const volume30mTotalRaw = pickNumPositive(
    bird?.volume_30m,
    bird?.raw?.volume_30m,
    bird?.raw?.volume30m,
    bird?.raw?.v30mUSD,
    bird?.raw?.volume30mUSD,
  );
  const volume30mAvgFromTotal = volume30mTotalRaw > 0 ? (volume30mTotalRaw / 6) : 0;
  const micro = {
    // Keep micro windows sourced from real BirdEye micro fields where available.
    // Avoid defaulting to paired h1-derived 5m/30m values here (that can force a synthetic 0.5 ratio).
    volume_5m: pickNumPositive(
      bird?.volume_5m,
      bird?.raw?.volume_5m,
      bird?.raw?.volume5m,
      bird?.raw?.v5mUSD,
      bird?.raw?.volume5mUSD,
    ),
    volume_30m_avg: pickNumPositive(
      bird?.volume_30m_avg,
      bird?.raw?.volume_30m_avg,
      bird?.raw?.volume30mAvg,
      volume30mAvgFromTotal,
    ),
    buySellRatio: pickNum(bird?.buySellRatio, bird?.raw?.buySellRatio, Number(txns?.h1?.sells || 0) > 0 ? (Number(txns?.h1?.buys || 0) / Number(txns?.h1?.sells || 1)) : 0),
    tx_1m: pickNumPositive(bird?.tx_1m, bird?.raw?.tx_1m, tx1mFallback),
    tx_5m_avg: pickNumPositive(bird?.tx_5m_avg, bird?.raw?.tx_5m_avg, tx5mAvgFallback),
    tx_30m_avg: pickNumPositive(bird?.tx_30m_avg, bird?.raw?.tx_30m_avg, tx30mAvgFallback),
    rolling_high_5m: pickNum(bird?.rolling_high_5m, bird?.raw?.rolling_high_5m, priceUsd),
    // Prefer current unique-wallet windows; fallback to history windows when current window fields are absent.
    uniqueBuyers1m: pickNumPositive(
      bird?.raw?.uniqueBuyers1m,
      bird?.raw?.uniqueWallet1m,
      bird?.raw?.uniqueWalletHistory1m,
    ),
    uniqueBuyers5m: pickNumPositive(
      bird?.raw?.uniqueBuyers5m,
      bird?.raw?.uniqueWallet5m,
      bird?.raw?.uniqueWalletHistory5m,
    ),
  };

  const normalizeEpochMs = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    const parsed = Date.parse(String(v || '').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
  };
  const pickEpochMs = (...vals) => {
    for (const v of vals) {
      const n = normalizeEpochMs(v);
      if (n) return n;
    }
    return null;
  };

  const ts = Number(bird?.atMs || bird?.timestampMs || bird?.observedAtMs || nowMs);
  const timestampMs = Number.isFinite(ts) ? ts : nowMs;
  const freshnessMs = Math.max(0, nowMs - timestampMs);
  const pairCreatedAtMs = pickEpochMs(
    bird?.pairCreatedAt,
    bird?.pair_created_at,
    bird?.createdAt,
    bird?.created_at,
    bird?.poolCreatedAt,
    bird?.pool_created_at,
    bird?.launchTime,
    bird?.raw?.pairCreatedAt,
    bird?.raw?.pair_created_at,
    bird?.raw?.createdAt,
    bird?.raw?.created_at,
    bird?.raw?.poolCreatedAt,
    bird?.raw?.pool_created_at,
    bird?.raw?.launchTime,
  );

  const hasTxns = (Number(txns?.h1?.buys || 0) + Number(txns?.h1?.sells || 0) > 0)
    || (Number(txns?.h24?.buys || 0) + Number(txns?.h24?.sells || 0) > 0);

  // Extract participation metadata if available (optional & non-blocking)
  let participation = null;
  try {
    const pRoot = bird?.participation ?? bird?.raw?.participation ?? null;
    const holdersCand = pRoot?.holders ?? bird?.holders ?? bird?.raw?.holders ?? null;
    const uniqueBuyersCand = pRoot?.uniqueBuyers ?? bird?.uniqueBuyers ?? bird?.raw?.uniqueBuyers ?? bird?.raw?.uniqueWallet24hBuy ?? null;
    const holders = Number.isFinite(Number(holdersCand)) ? Number(holdersCand) : null;
    const uniqueBuyers = Number.isFinite(Number(uniqueBuyersCand)) ? Number(uniqueBuyersCand) : null;
    if (holders !== null || uniqueBuyers !== null) {
      participation = {};
      if (holders !== null) participation.holders = holders;
      if (uniqueBuyers !== null) participation.uniqueBuyers = uniqueBuyers;
    }
  } catch (e) {
    participation = null;
  }

  const confidenceScore = confidenceForSnapshot({
    source: PROVIDERS.bird,
    hasLiquidity: Number(liquidityUsd || 0) > 0,
    hasTxns,
    freshnessMs,
  });

  const tokenAddress = String(
    bird?.raw?.address
    || bird?.raw?.tokenAddress
    || bird?.raw?.mint
    || bird?.address
    || bird?.tokenAddress
    || ''
  ).trim() || null;
  const tokenSymbol = String(
    bird?.raw?.symbol
    || bird?.raw?.tokenSymbol
    || bird?.symbol
    || bird?.tokenSymbol
    || ''
  ).trim() || null;
  const tokenName = String(
    bird?.raw?.name
    || bird?.raw?.tokenName
    || bird?.name
    || bird?.tokenName
    || ''
  ).trim() || null;

  return {
    source: PROVIDERS.bird,
    timestampMs,
    freshnessMs,
    priceUsd,
    liquidityUsd,
    txns,
    volume,
    volume_5m: Number(micro.volume_5m || 0),
    volume_30m_avg: Number(micro.volume_30m_avg || 0),
    buySellRatio: Number(micro.buySellRatio || 0),
    tx_1m: Number(micro.tx_1m || 0),
    tx_5m_avg: Number(micro.tx_5m_avg || 0),
    tx_30m_avg: Number(micro.tx_30m_avg || 0),
    rolling_high_5m: Number(micro.rolling_high_5m || 0),
    pairCreatedAt: pairCreatedAtMs,
    tokenName,
    tokenSymbol,
    // Synthetic pair so downstream momentum/filters do not depend on DexScreener structures.
    marketCapUsd,
    fdvUsd,
    pair: {
      baseToken: { address: tokenAddress, symbol: tokenSymbol, name: tokenName },
      quoteToken: { address: null, symbol: 'SOL' },
      liquidity: { usd: liquidityUsd || 0 },
      marketCap: marketCapUsd || null,
      fdv: fdvUsd || null,
      volume: { h1: Number(volume?.h1 || 0), h24: Number(volume?.h24 || 0) },
      txns: { h1: { buys: Number(txns?.h1?.buys || 0), sells: Number(txns?.h1?.sells || 0) } },
      priceChange: {
        h1: Number(bird?.priceChange?.h1 ?? bird?.priceChange1h ?? 0),
        h24: Number(bird?.priceChange?.h24 ?? bird?.priceChange24h ?? 0),
      },
      birdeye: { ...micro },
      priceUsd,
      dexId: 'birdeye',
      pairAddress: null,
      pairCreatedAt: pairCreatedAtMs,
      url: null,
    },
    confidenceScore,
    confidence: confidenceLabel(confidenceScore),
    // Watchlist entry schema surface area (non-breaking add):
    entryHints: {
      tx1hHint: Number(txns?.h1?.buys || 0) + Number(txns?.h1?.sells || 0),
      volume1hHintUsd: Number(volume?.h1 || 0),
      liquidityUsd: liquidityUsd,
      freshnessMs,
      confidenceScore,
      ...(participation ? { participation } : {}),
    },
  };
}

function snapshotFromJupPrice(priceUsd, nowMs) {
  const n = Number(priceUsd || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  const confidenceScore = confidenceForSnapshot({
    source: PROVIDERS.jup,
    hasLiquidity: false,
    hasTxns: false,
    freshnessMs: 0,
  });
  return {
    source: PROVIDERS.jup,
    timestampMs: nowMs,
    freshnessMs: 0,
    priceUsd: n,
    liquidityUsd: null,
    txns: { h1: { buys: 0, sells: 0 } },
    volume: { h1: 0, h24: 0 },
    // Synthetic pair so downstream logic can run without DexScreener structures.
    pair: {
      baseToken: { address: null, symbol: null },
      quoteToken: { address: null, symbol: 'SOL' },
      liquidity: { usd: 0 },
      volume: { h1: 0, h24: 0 },
      txns: { h1: { buys: 0, sells: 0 } },
      priceChange: { h1: 0, h24: 0 },
      priceUsd: n,
      dexId: 'jupiter',
      pairAddress: null,
      pairCreatedAt: null,
      url: null,
    },
    confidenceScore,
    confidence: confidenceLabel(confidenceScore),
  };
}

function snapshotFromLkg(row, nowMs) {
  if (!row?.priceUsd) return null;
  const freshnessMs = Math.max(0, nowMs - Number(row.atMs || nowMs));
  const confidenceScore = confidenceForSnapshot({
    source: PROVIDERS.cache,
    hasLiquidity: Number(row?.liquidityUsd || 0) > 0,
    hasTxns: Number(row?.txns?.h1?.buys || 0) + Number(row?.txns?.h1?.sells || 0) > 0,
    freshnessMs,
  });
  return {
    source: PROVIDERS.cache,
    timestampMs: Number(row.atMs || nowMs),
    freshnessMs,
    priceUsd: Number(row.priceUsd),
    liquidityUsd: Number(row.liquidityUsd || 0) || null,
    txns: row.txns || {},
    volume: row.volume || {},
    pair: row.pair || null,
    confidenceScore,
    confidence: confidenceLabel(confidenceScore),
  };
}

function snapshotFromBirdEyeWsCache(mint, nowMs, lkg = null) {
  const key = String(mint || '').trim();
  if (!key) return null;
  const p = cache.get(`birdeye:ws:price:${key}`) || null;
  const priceUsd = Number(p?.priceUsd || 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const tsMs = Number(p?.tsMs || nowMs);
  const freshnessMs = Math.max(0, nowMs - tsMs);
  const txRows = cache.get(`birdeye:ws:tx:${key}`) || [];
  const buys1m = txRows.filter((x) => (nowMs - Number(x?.t || 0)) <= 60_000 && String(x?.side || '') === 'buy').length;
  const sells1m = txRows.filter((x) => (nowMs - Number(x?.t || 0)) <= 60_000 && String(x?.side || '') === 'sell').length;
  const series = cache.get(`birdeye:ws:series:${key}`) || [];
  const vol1m = series.filter((x) => (nowMs - Number(x?.t || 0)) <= 60_000).reduce((a, b) => a + Number(b?.v || 0), 0);

  const confidenceScore = confidenceForSnapshot({
    source: PROVIDERS.birdWs,
    hasLiquidity: Number(lkg?.liquidityUsd || 0) > 0,
    hasTxns: (buys1m + sells1m) > 0,
    freshnessMs,
  });

  return {
    source: PROVIDERS.birdWs,
    timestampMs: tsMs,
    freshnessMs,
    priceUsd,
    liquidityUsd: Number(lkg?.liquidityUsd || 0) || null,
    txns: {
      h1: {
        buys: Number(lkg?.txns?.h1?.buys || 0),
        sells: Number(lkg?.txns?.h1?.sells || 0),
      },
      m1: { buys: buys1m, sells: sells1m },
    },
    volume: {
      h1: Number(lkg?.volume?.h1 || 0),
      m1: vol1m,
    },
    pair: lkg?.pair || null,
    confidenceScore,
    confidence: confidenceLabel(confidenceScore),
  };
}

export function getEntrySnapshotUnsafeReason(snapshot, opts = {}) {
  const minScore = Number(opts.minEntryConfidenceScore ?? DEFAULTS.minEntryConfidenceScore);
  const maxFreshnessMs = Number(opts.maxFreshnessMsForEntry ?? DEFAULTS.maxFreshnessMsForEntry);
  if (!snapshot?.priceUsd) return 'missingPrice';
  if (Number(snapshot.confidenceScore ?? 0) < minScore) return `lowScore(<${minScore})`;
  if (Number(snapshot.freshnessMs ?? Number.MAX_SAFE_INTEGER) > maxFreshnessMs) return `stale(>${maxFreshnessMs}ms)`;
  return null;
}

export function isEntrySnapshotSafe(snapshot, opts = {}) {
  return getEntrySnapshotUnsafeReason(snapshot, opts) == null;
}

// New snapshot status helpers: provide structured assessment for watchlist/entry gating.
export function getSnapshotStatus({ snapshot, birdseyeSnapshot } = {}, opts = {}) {
  const maxFreshnessMs = Number(opts.maxFreshnessMsForEntry ?? DEFAULTS.maxFreshnessMsForEntry);
  const minLiquidityUsd = Number(opts.minLiquidityUsd ?? Number(process.env.MIN_LIQUIDITY_FLOOR_USD || 50000));

  // Prefer BirdEye snapshot when available
  const sourceSnap = birdseyeSnapshot || snapshot || null;
  if (!sourceSnap) {
    return { snapshotStatus: 'unsafe', unsafeReasons: ['missingSnapshot'], confidenceScore: 0 };
  }

  const snapForValidate = {
    priceUsd: sourceSnap.priceUsd,
    liquidityUsd: sourceSnap.liquidityUsd,
    txns: sourceSnap.txns,
    snapshotAgeMs: sourceSnap.freshnessMs,
    routeAvailable: sourceSnap.routeAvailable === true,
  };

  const unsafe = validateSnapshot(snapForValidate, { minLiquidityUsd, maxFreshnessMs });
  const confidenceScore = Number(sourceSnap.confidenceScore ?? validatorComputeConfidence({ source: sourceSnap.source || 'cache', liquidityUsd: sourceSnap.liquidityUsd, txns: sourceSnap.txns, freshnessMs: sourceSnap.freshnessMs }));

  return {
    snapshotStatus: (unsafe.length === 0) ? 'safe' : 'unsafe',
    unsafeReasons: unsafe,
    confidenceScore,
  };
}

// Backward-compatible helper: returns legacy unsafeSnapshot.* string or null
export function getWatchlistEntrySnapshotUnsafeReason({ snapshot, birdseyeSnapshot } = {}, opts = {}) {
  const status = getSnapshotStatus({ snapshot, birdseyeSnapshot }, opts);
  if (status.snapshotStatus === 'safe') return null;

  // If BirdEye missing entirely and no fallback price, keep the previous sentinel
  if (!birdseyeSnapshot && (!snapshot || !snapshot.priceUsd)) return 'unsafeSnapshot.birdeyeMissing';

  const first = (status.unsafeReasons && status.unsafeReasons.length) ? status.unsafeReasons[0] : 'unknown';
  if (first === 'missingPrice') return 'unsafeSnapshot.noPrice';
  if (first === 'staleTimestamp') return 'unsafeSnapshot.birdeyeStale';
  return `unsafeSnapshot.${first}`;
}

export function isWatchlistEntrySnapshotSafe({ snapshot, birdseyeSnapshot } = {}, opts = {}) {
  const status = getSnapshotStatus({ snapshot, birdseyeSnapshot }, opts);
  return status.snapshotStatus === 'safe';
}

export function isStopSnapshotUsable(snapshot, opts = {}) {
  const maxFreshnessMs = Number(opts.maxFreshnessMsForStops ?? DEFAULTS.maxFreshnessMsForStops);
  if (!snapshot?.priceUsd) return false;
  if (Number(snapshot.freshnessMs ?? Number.MAX_SAFE_INTEGER) > maxFreshnessMs) return false;
  // allow medium+ confidence for stop updates/exits
  return Number(snapshot.confidenceScore ?? 0) >= 0.55;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function formatMarketDataProviderSummary(state = {}) {
  const providers = state?.marketData?.providers || {};
  const rows = Object.entries(providers);
  if (!rows.length) return '• providers: no market-data provider stats yet';

  const body = rows
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, h]) => {
      const req = safeNum(h?.requests);
      const hits = safeNum(h?.hits);
      const rejects = safeNum(h?.rejects);
      const hitRate = req > 0 ? `${((hits / req) * 100).toFixed(0)}%` : 'n/a';
      const rejRate = req > 0 ? `${((rejects / req) * 100).toFixed(0)}%` : 'n/a';
      const rl = safeNum(h?.rateLimited);
      return `  - ${name}: hit=${hits}/${req}(${hitRate}) rejectImpact=${rejects}/${req}(${rejRate}) rl=${rl} failStreak=${safeNum(h?.failStreak)}`;
    });

  return ['• providers:', ...body].join('\n');
}

export function markMarketDataRejectImpact(state, provider) {
  if (!provider) return;
  markProviderReject(state, String(provider));
}

export async function getMarketSnapshot({
  state,
  mint,
  nowMs,
  maxAgeMs,
  getTokenPairs,
  pickBestPair,
  getJupPrice = jupPriceUsd,
  getBirdseyeSnapshot = null,
  birdeyeEnabled = false,
  providerCooldownBaseMs = DEFAULTS.providerCooldownBaseMs,
  providerCooldownMaxMs = DEFAULTS.providerCooldownMaxMs,
  lkgMaxEntries = DEFAULTS.lkgMaxEntries,
  allowDex = false,
  preferWsPrice = false,
} = {}) {
  ensureRouterState(state);
  state.marketData.staleSkips ||= {};

  // If we previously skipped this mint due to repeated stale responses, avoid re-fetching until expiry.
  const skipUntil = Number(state.marketData.staleSkips?.[mint] || 0);
  if (skipUntil && nowMs < skipUntil) return null;

  const maxFreshnessMs = Number(DEFAULTS.maxFreshnessMsForEntry || 20_000);

  // Optional priority for exits: use BirdEye websocket cache first when available/fresh.
  if (preferWsPrice) {
    const lkg = state.marketData.lastKnownGood?.[mint] || null;
    const wsSnap = snapshotFromBirdEyeWsCache(mint, nowMs, lkg);
    if (wsSnap && Number(wsSnap.freshnessMs || Number.MAX_SAFE_INTEGER) <= Number(maxAgeMs || DEFAULTS.maxFreshnessMsForStops)) {
      markProviderHit(state, PROVIDERS.bird);
      markProviderSuccess(state, PROVIDERS.bird, nowMs);
      rememberLkg(state, mint, wsSnap, nowMs, lkgMaxEntries);
      clearStaleSkip(state, mint);
      return wsSnap;
    }
  }

  // Primary: BirdEye (fast path). If BirdEye is stale, retry once, then fall through to on-chain fallback.
  if (birdeyeEnabled && typeof getBirdseyeSnapshot === 'function' && providerReady(state, PROVIDERS.bird, nowMs)) {
    try {
      markProviderRequest(state, PROVIDERS.bird);
      const bird = await getBirdseyeSnapshot(mint);
      const birdSnap = snapshotFromBirdseye(bird, nowMs);

      if (birdSnap) {
        // Fresh enough -> return immediately
        if (Number(birdSnap.freshnessMs || 0) <= Number(maxFreshnessMs)) {
          markProviderHit(state, PROVIDERS.bird);
          markProviderSuccess(state, PROVIDERS.bird, nowMs);
          rememberLkg(state, mint, birdSnap, nowMs, lkgMaxEntries);
          clearStaleSkip(state, mint);
          return birdSnap;
        }

        // Stale: retry once after jitter
        markProviderMiss(state, PROVIDERS.bird);
        const retryDelayMs = 250 + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        try {
          const bird2 = await getBirdseyeSnapshot(mint);
          const birdSnap2 = snapshotFromBirdseye(bird2, nowMs);
          if (birdSnap2 && Number(birdSnap2.freshnessMs || 0) <= Number(maxFreshnessMs)) {
            markProviderHit(state, PROVIDERS.bird);
            markProviderSuccess(state, PROVIDERS.bird, nowMs);
            rememberLkg(state, mint, birdSnap2, nowMs, lkgMaxEntries);
            clearStaleSkip(state, mint);
            return birdSnap2;
          }
        } catch (e) {
          // ignore retry error and continue to fallback
        }

        // Still stale: mark degraded and fall through to on-chain fallback
        markProviderFailure(state, PROVIDERS.bird, nowMs, new Error('birdeye stale'), providerCooldownBaseMs[PROVIDERS.bird], providerCooldownMaxMs);
      } else {
        markProviderMiss(state, PROVIDERS.bird);
        markProviderFailure(state, PROVIDERS.bird, nowMs, new Error('birdeye empty/invalid'), providerCooldownBaseMs[PROVIDERS.bird], providerCooldownMaxMs);
      }
    } catch (error) {
      markProviderMiss(state, PROVIDERS.bird);
      markProviderFailure(state, PROVIDERS.bird, nowMs, error, providerCooldownBaseMs[PROVIDERS.bird], providerCooldownMaxMs);
    }
  }

  // Secondary: on-chain / Jupiter-derived pool price (route-availability + price probe)
  if (providerReady(state, PROVIDERS.jup, nowMs)) {
    try {
      markProviderRequest(state, PROVIDERS.jup);
      const jup = await getJupPrice(mint);
      const jupSnap = snapshotFromJupPrice(jup, nowMs);
      if (jupSnap) {
        markProviderHit(state, PROVIDERS.jup);
        markProviderSuccess(state, PROVIDERS.jup, nowMs);
        const lkg = state.marketData.lastKnownGood?.[mint] || null;
        if (lkg?.liquidityUsd && !jupSnap.liquidityUsd) jupSnap.liquidityUsd = Number(lkg.liquidityUsd);
        rememberLkg(state, mint, jupSnap, nowMs, lkgMaxEntries);
        clearStaleSkip(state, mint);
        return jupSnap;
      }
      markProviderMiss(state, PROVIDERS.jup);
      markProviderFailure(state, PROVIDERS.jup, nowMs, new Error('jup empty/invalid'), providerCooldownBaseMs[PROVIDERS.jup], providerCooldownMaxMs);
    } catch (error) {
      markProviderMiss(state, PROVIDERS.jup);
      markProviderFailure(state, PROVIDERS.jup, nowMs, error, providerCooldownBaseMs[PROVIDERS.jup], providerCooldownMaxMs);
    }
  }

  // Tertiary: DexScreener is discovery-only. Only use if explicitly allowed (allowDex=true).
  if (allowDex && providerReady(state, PROVIDERS.dex, nowMs)) {
    try {
      markProviderRequest(state, PROVIDERS.dex);
      const pairs = await getTokenPairs('solana', mint);
      const pair = pickBestPair(pairs);
      const dexSnap = snapshotFromDexPair(pair, nowMs);
      if (dexSnap) {
        markProviderHit(state, PROVIDERS.dex);
        markProviderSuccess(state, PROVIDERS.dex, nowMs);
        // DexScreener is discovery-only: do not persist it as last-known-good for cache-backed entry gating.
        clearStaleSkip(state, mint);
        return dexSnap;
      }
      markProviderMiss(state, PROVIDERS.dex);
      markProviderFailure(state, PROVIDERS.dex, nowMs, new Error('dex empty/invalid'), providerCooldownBaseMs[PROVIDERS.dex], providerCooldownMaxMs);
    } catch (error) {
      markProviderMiss(state, PROVIDERS.dex);
      markProviderFailure(state, PROVIDERS.dex, nowMs, error, providerCooldownBaseMs[PROVIDERS.dex], providerCooldownMaxMs);
    }
  }

  // Last-resort: last-known-good cache
  const lkg = state.marketData.lastKnownGood?.[mint] || null;
  if (lkg) {
    const snap = snapshotFromLkg(lkg, nowMs);
    if (snap && Number(snap.freshnessMs || 0) <= Number(maxAgeMs || 0)) {
      clearStaleSkip(state, mint);
      return snap;
    }
  }

  // If we got here, nothing usable found.
  // If BirdEye was stale earlier, set a temporary skip to avoid repeated wasted fetches.
  markStaleSkip(state, mint, nowMs);
  return null;
}
