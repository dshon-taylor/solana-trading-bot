export const CORE_MOMO_CHECKS = ['dex.volumeExpansion', 'dex.buyPressure', 'dex.txAcceleration', 'dex.walletExpansion'];

export function canaryMomoShouldSample({ state, nowMs, limitPerMin = 0 }) {
  const limit = Math.max(0, Number(limitPerMin || 0));
  if (!limit) return { ok: true, limitPerMin: limit, usedThisMin: null };
  state.debug ||= {};
  state.debug.canary ||= {};
  state.debug.canary.momoSample ||= { windowStartMs: 0, used: 0 };
  const bucketMs = 60_000;
  const bucket = state.debug.canary.momoSample;
  if (!bucket.windowStartMs || (nowMs - bucket.windowStartMs) >= bucketMs) {
    bucket.windowStartMs = nowMs;
    bucket.used = 0;
  }
  if (bucket.used >= limit) return { ok: false, limitPerMin: limit, usedThisMin: bucket.used };
  bucket.used += 1;
  return { ok: true, limitPerMin: limit, usedThisMin: bucket.used };
}

export function recordCanaryMomoFailChecks({ state, nowMs, failedChecks, windowMin = 30, enabled = true }) {
  if (!enabled) return;
  const windowMs = Math.max(60_000, Number(windowMin || 30) * 60_000);
  state.debug ||= {};
  state.debug.momentumFail ||= { windowMs, events: [] };
  state.debug.momentumFail.windowMs = windowMs;
  const ev = { tMs: nowMs, checks: Array.from(new Set((failedChecks || []).map(String))).slice(0, 32) };
  state.debug.momentumFail.events.push(ev);
  const cutoff = nowMs - windowMs;
  while (state.debug.momentumFail.events.length && Number(state.debug.momentumFail.events[0]?.tMs || 0) < cutoff) {
    state.debug.momentumFail.events.shift();
  }
  if (state.debug.momentumFail.events.length > 1000) {
    state.debug.momentumFail.events = state.debug.momentumFail.events.slice(-1000);
  }
}

export function coreMomentumProgress(sig) {
  const reasons = sig?.reasons || {};
  const volRatio = Number(reasons.volume5m || 0) / Math.max(1, Number(reasons.volume_30m_avg || 0));
  const buyRatio = Number(reasons.buySellRatio || 0) / 1.2;
  const txRatio = Number(reasons.tx_1m || 0) / Math.max(1, Number(reasons.tx_5m_avg || 0));
  const walletRatio = Number(reasons.walletExpansion || 0) / Math.max(1e-9, Number(reasons.walletExpansionThreshold || 1.25));
  return {
    'dex.volumeExpansion': Number.isFinite(volRatio) ? volRatio : 0,
    'dex.buyPressure': Number.isFinite(buyRatio) ? buyRatio : 0,
    'dex.txAcceleration': Number.isFinite(txRatio) ? txRatio : 0,
    'dex.walletExpansion': Number.isFinite(walletRatio) ? walletRatio : 0,
  };
}

export function decideMomentumBranch(tokenAgeMinutes) {
  const agePresent = Number.isFinite(tokenAgeMinutes);
  const matureTokenMode = agePresent ? tokenAgeMinutes >= 30 : true;
  const earlyTokenMode = agePresent ? tokenAgeMinutes < 30 : false;
  const breakoutBranchUsed = earlyTokenMode ? 'early_2_of_3' : (agePresent ? 'mature_3_of_4' : 'missingAge_strict_3_of_4');
  return { agePresent, matureTokenMode, earlyTokenMode, breakoutBranchUsed };
}

export function normalizeEpochMs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(String(v || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export function pickEpochMsWithSource(candidates = []) {
  for (const candidate of candidates) {
    const value = normalizeEpochMs(candidate?.value);
    if (value) return { value, source: String(candidate?.source || 'unknown') };
  }
  return { value: null, source: 'missing' };
}

export function applySnapshotToLatest({ row, snapshot }) {
  if (!row || !snapshot) return;
  row.latest ||= {};
  if (Number(snapshot.marketCapUsd || 0) > 0) row.latest.mcapUsd = Number(snapshot.marketCapUsd);
  if (Number(snapshot.liquidityUsd || 0) > 0) row.latest.liqUsd = Number(snapshot.liquidityUsd);
  const snapshotPairCreatedAt = normalizeEpochMs(snapshot.pairCreatedAt ?? snapshot?.pair?.pairCreatedAt ?? snapshot?.raw?.pairCreatedAt ?? snapshot?.raw?.pair_created_at ?? 0);
  if (Number(snapshotPairCreatedAt || 0) > 0) row.latest.pairCreatedAt = Number(snapshotPairCreatedAt || 0);
  if (Number(snapshot.priceUsd || 0) > 0) row.latest.priceUsd = Number(snapshot.priceUsd);
  if (Number.isFinite(Number(snapshot.freshnessMs))) row.latest.marketDataFreshnessMs = Number(snapshot.freshnessMs);
  row.latest.marketDataSource = snapshot.source || row.latest.marketDataSource || 'unknown';
  const decimalsFromSnapshot = [snapshot?.raw?.decimals, snapshot?.pair?.baseToken?.decimals, row?.pair?.baseToken?.decimals]
    .map((x) => Number(x))
    .find((x) => Number.isInteger(x) && x >= 0);
  if (Number.isInteger(decimalsFromSnapshot)) row.latest.decimals = Number(decimalsFromSnapshot);

  const rawBuy1m = Number(snapshot?.raw?.buy1m ?? 0);
  const rawSell1m = Number(snapshot?.raw?.sell1m ?? 0);
  const rawTrade1m = Number(snapshot?.raw?.trade1m ?? 0);
  const rawTrade5m = Number(snapshot?.raw?.trade5m ?? 0);
  const rawTrade30m = Number(snapshot?.raw?.trade30m ?? 0);

  const derivedBuySellRatio = (rawBuy1m > 0 || rawSell1m > 0)
    ? (rawBuy1m / Math.max(1, rawSell1m))
    : 0;

  const micro = {
    volume5m: Number(snapshot?.volume_5m ?? snapshot?.raw?.v5mUSD ?? snapshot?.raw?.v5m ?? snapshot?.pair?.birdeye?.volume_5m ?? 0),
    volume30mAvg: Number(snapshot?.volume_30m_avg ?? ((Number(snapshot?.raw?.v30mUSD ?? snapshot?.raw?.v30m ?? 0) > 0) ? (Number(snapshot?.raw?.v30mUSD ?? snapshot?.raw?.v30m) / 6) : null) ?? snapshot?.pair?.birdeye?.volume_30m_avg ?? 0),
    buySellRatio: Number(snapshot?.buySellRatio ?? snapshot?.raw?.buySellRatio ?? (derivedBuySellRatio > 0 ? derivedBuySellRatio : null) ?? snapshot?.pair?.birdeye?.buySellRatio ?? 0),
    tx1m: Number(snapshot?.tx_1m ?? snapshot?.raw?.tx_1m ?? (rawTrade1m > 0 ? rawTrade1m : (rawBuy1m + rawSell1m)) ?? snapshot?.pair?.birdeye?.tx_1m ?? 0),
    tx5mAvg: Number(snapshot?.tx_5m_avg ?? snapshot?.raw?.tx_5m_avg ?? (rawTrade5m > 0 ? (rawTrade5m / 5) : null) ?? ((Number(snapshot?.raw?.buy5m ?? 0) + Number(snapshot?.raw?.sell5m ?? 0)) > 0 ? ((Number(snapshot?.raw?.buy5m ?? 0) + Number(snapshot?.raw?.sell5m ?? 0)) / 5) : null) ?? snapshot?.pair?.birdeye?.tx_5m_avg ?? 0),
    tx30mAvg: Number(snapshot?.tx_30m_avg ?? snapshot?.raw?.tx_30m_avg ?? (rawTrade30m > 0 ? (rawTrade30m / 30) : null) ?? ((Number(snapshot?.raw?.buy30m ?? 0) + Number(snapshot?.raw?.sell30m ?? 0)) > 0 ? ((Number(snapshot?.raw?.buy30m ?? 0) + Number(snapshot?.raw?.sell30m ?? 0)) / 30) : null) ?? snapshot?.pair?.birdeye?.tx_30m_avg ?? 0),
    rollingHigh5m: Number(snapshot?.rolling_high_5m ?? snapshot?.raw?.history5mPrice ?? snapshot?.pair?.birdeye?.rolling_high_5m ?? 0),
    uniqueBuyers1m: Number(snapshot?.uniqueBuyers1m ?? snapshot?.raw?.uniqueBuyers1m ?? snapshot?.raw?.uniqueWallet1m ?? snapshot?.raw?.uniqueWalletHistory1m ?? snapshot?.pair?.birdeye?.uniqueBuyers1m ?? snapshot?.pair?.birdeye?.uniqueWallet1m ?? 0),
    uniqueBuyers5m: Number(snapshot?.uniqueBuyers5m ?? snapshot?.raw?.uniqueBuyers5m ?? snapshot?.raw?.uniqueWallet5m ?? snapshot?.raw?.uniqueWalletHistory5m ?? snapshot?.pair?.birdeye?.uniqueBuyers5m ?? snapshot?.pair?.birdeye?.uniqueWallet5m ?? 0),
  };
  for (const [key, value] of Object.entries(micro)) {
    if (Number.isFinite(Number(value)) && Number(value) > 0) row.latest[key] = Number(value);
  }
}

export function buildNormalizedMomentumInput({ snapshot, latest, pair }) {
  const p = pair || {};
  const s = snapshot || {};
  const l = latest || {};
  const wsBe = p?.wsCache?.birdeye || {};
  const rawBuy1m = Number(s?.raw?.buy1m ?? 0);
  const rawSell1m = Number(s?.raw?.sell1m ?? 0);
  const rawTrade1m = Number(s?.raw?.trade1m ?? 0);
  const rawTrade5m = Number(s?.raw?.trade5m ?? 0);
  const rawTrade30m = Number(s?.raw?.trade30m ?? 0);
  const rawTrade1h = Number(s?.raw?.trade1h ?? 0);
  const rawBuySellRatio = (rawBuy1m > 0 || rawSell1m > 0)
    ? (rawBuy1m / Math.max(1, rawSell1m))
    : null;

  const avgFromTotal = (total, divisor) => {
    const n = Number(total ?? 0);
    return Number.isFinite(n) && n > 0 ? (n / Math.max(1, Number(divisor || 1))) : null;
  };
  const v30FromRaw = avgFromTotal((s?.raw?.v30mUSD ?? s?.raw?.v30m), 6);
  const tx5FromTrades = avgFromTotal(rawTrade5m, 5);
  const tx5FromBuySell = avgFromTotal((Number(s?.raw?.buy5m ?? 0) + Number(s?.raw?.sell5m ?? 0)), 5);
  const tx30FromTrades = avgFromTotal(rawTrade30m, 30);
  const tx30FromBuySell = avgFromTotal((Number(s?.raw?.buy30m ?? 0) + Number(s?.raw?.sell30m ?? 0)), 30);
  const tx1FromSides = (rawBuy1m > 0 || rawSell1m > 0) ? (rawBuy1m + rawSell1m) : null;

  const withSource = (entries = [], fallbackValue = 0, fallbackSource = 'missing') => {
    for (const entry of entries) {
      const n = Number(entry?.value);
      if (Number.isFinite(n) && n > 0) return { value: n, source: String(entry?.source || 'unknown') };
    }
    return { value: Number(fallbackValue || 0), source: String(fallbackSource) };
  };

  const volume5mResolved = withSource([
    { value: l.volume5m, source: 'latest.volume5m' },
    { value: s?.volume_5m, source: 'snapshot.volume_5m' },
    { value: s?.raw?.volume_5m, source: 'snapshot.raw.volume_5m' },
    { value: s?.raw?.v5mUSD, source: 'snapshot.raw.v5mUSD' },
    { value: s?.raw?.v5m, source: 'snapshot.raw.v5m' },
    { value: p?.birdeye?.volume_5m, source: 'pair.birdeye.volume_5m' },
    { value: wsBe?.volume_5m, source: 'ws.birdeye.volume_5m' },
  ]);
  const volume30mAvgResolved = withSource([
    { value: l.volume30mAvg, source: 'latest.volume30mAvg' },
    { value: s?.volume_30m_avg, source: 'snapshot.volume_30m_avg' },
    { value: s?.raw?.volume_30m_avg, source: 'snapshot.raw.volume_30m_avg' },
    { value: v30FromRaw, source: 'snapshot.raw.v30m/6' },
    { value: p?.birdeye?.volume_30m_avg, source: 'pair.birdeye.volume_30m_avg' },
    { value: wsBe?.volume_30m_avg, source: 'ws.birdeye.volume_30m_avg' },
  ]);
  const buySellRatioResolved = withSource([
    { value: l.buySellRatio, source: 'latest.buySellRatio' },
    { value: s?.buySellRatio, source: 'snapshot.buySellRatio' },
    { value: s?.raw?.buySellRatio, source: 'snapshot.raw.buySellRatio' },
    { value: rawBuySellRatio, source: 'snapshot.raw.buy1m/sell1m' },
    { value: p?.birdeye?.buySellRatio, source: 'pair.birdeye.buySellRatio' },
    { value: wsBe?.buySellRatio, source: 'ws.birdeye.buySellRatio' },
  ], 1, 'neutral_default');
  const tx1mResolved = withSource([
    { value: l.tx1m, source: 'latest.tx1m' },
    { value: s?.tx_1m, source: 'snapshot.tx_1m' },
    { value: s?.raw?.tx_1m, source: 'snapshot.raw.tx_1m' },
    { value: rawTrade1m, source: 'snapshot.raw.trade1m' },
    { value: tx1FromSides, source: 'snapshot.raw.buy1m+sell1m' },
    { value: p?.birdeye?.tx_1m, source: 'pair.birdeye.tx_1m' },
    { value: wsBe?.tx_1m, source: 'ws.birdeye.tx_1m' },
  ]);
  const tx5mAvgResolved = withSource([
    { value: l.tx5mAvg, source: 'latest.tx5mAvg' },
    { value: s?.tx_5m_avg, source: 'snapshot.tx_5m_avg' },
    { value: s?.raw?.tx_5m_avg, source: 'snapshot.raw.tx_5m_avg' },
    { value: tx5FromTrades, source: 'snapshot.raw.trade5m/5' },
    { value: tx5FromBuySell, source: 'snapshot.raw.buy5m+sell5m/5' },
    { value: p?.birdeye?.tx_5m_avg, source: 'pair.birdeye.tx_5m_avg' },
    { value: wsBe?.tx_5m_avg, source: 'ws.birdeye.tx_5m_avg' },
  ]);
  const tx30mAvgResolved = withSource([
    { value: l.tx30mAvg, source: 'latest.tx30mAvg' },
    { value: s?.tx_30m_avg, source: 'snapshot.tx_30m_avg' },
    { value: s?.raw?.tx_30m_avg, source: 'snapshot.raw.tx_30m_avg' },
    { value: tx30FromTrades, source: 'snapshot.raw.trade30m/30' },
    { value: tx30FromBuySell, source: 'snapshot.raw.buy30m+sell30m/30' },
    { value: p?.birdeye?.tx_30m_avg, source: 'pair.birdeye.tx_30m_avg' },
    { value: wsBe?.tx_30m_avg, source: 'ws.birdeye.tx_30m_avg' },
  ]);
  const rollingHigh5mResolved = withSource([
    { value: l.rollingHigh5m, source: 'latest.rollingHigh5m' },
    { value: s?.rolling_high_5m, source: 'snapshot.rolling_high_5m' },
    { value: s?.raw?.rolling_high_5m, source: 'snapshot.raw.rolling_high_5m' },
    { value: s?.raw?.history5mPrice, source: 'snapshot.raw.history5mPrice' },
    { value: p?.birdeye?.rolling_high_5m, source: 'pair.birdeye.rolling_high_5m' },
    { value: wsBe?.rolling_high_5m, source: 'ws.birdeye.rolling_high_5m' },
  ]);
  const tx1hResolved = withSource([
    { value: l.tx1h, source: 'latest.tx1h' },
    { value: s?.tx_1h, source: 'snapshot.tx_1h' },
    { value: s?.raw?.tx_1h, source: 'snapshot.raw.tx_1h' },
    { value: rawTrade1h, source: 'snapshot.raw.trade1h' },
    { value: p?.birdeye?.tx_1h, source: 'pair.birdeye.tx_1h' },
    { value: wsBe?.tx_1h, source: 'ws.birdeye.tx_1h' },
  ]);
  const uniqueBuyers1mResolved = withSource([
    { value: l.uniqueBuyers1m, source: 'latest.uniqueBuyers1m' },
    { value: s?.uniqueBuyers1m, source: 'snapshot.uniqueBuyers1m' },
    { value: s?.raw?.uniqueBuyers1m, source: 'snapshot.raw.uniqueBuyers1m' },
    { value: s?.raw?.uniqueWallet1m, source: 'snapshot.raw.uniqueWallet1m' },
    { value: s?.raw?.uniqueWalletHistory1m, source: 'snapshot.raw.uniqueWalletHistory1m' },
    { value: p?.birdeye?.uniqueBuyers1m, source: 'pair.birdeye.uniqueBuyers1m' },
    { value: p?.birdeye?.uniqueWallet1m, source: 'pair.birdeye.uniqueWallet1m' },
    { value: p?.birdeye?.uniqueWalletHistory1m, source: 'pair.birdeye.uniqueWalletHistory1m' },
    { value: wsBe?.uniqueBuyers1m, source: 'ws.birdeye.uniqueBuyers1m' },
    { value: wsBe?.uniqueWallet1m, source: 'ws.birdeye.uniqueWallet1m' },
  ]);
  const uniqueBuyers5mResolved = withSource([
    { value: l.uniqueBuyers5m, source: 'latest.uniqueBuyers5m' },
    { value: s?.uniqueBuyers5m, source: 'snapshot.uniqueBuyers5m' },
    { value: s?.raw?.uniqueBuyers5m, source: 'snapshot.raw.uniqueBuyers5m' },
    { value: s?.raw?.uniqueWallet5m, source: 'snapshot.raw.uniqueWallet5m' },
    { value: s?.raw?.uniqueWalletHistory5m, source: 'snapshot.raw.uniqueWalletHistory5m' },
    { value: p?.birdeye?.uniqueBuyers5m, source: 'pair.birdeye.uniqueBuyers5m' },
    { value: p?.birdeye?.uniqueWallet5m, source: 'pair.birdeye.uniqueWallet5m' },
    { value: p?.birdeye?.uniqueWalletHistory5m, source: 'pair.birdeye.uniqueWalletHistory5m' },
    { value: wsBe?.uniqueBuyers5m, source: 'ws.birdeye.uniqueBuyers5m' },
    { value: wsBe?.uniqueWallet5m, source: 'ws.birdeye.uniqueWallet5m' },
  ]);

  const birdeye = {
    volume_5m: Number(volume5mResolved.value || 0) || 0,
    volume_30m_avg: Number(volume30mAvgResolved.value || 0) || 0,
    buySellRatio: Number(buySellRatioResolved.value || 0) || 0,
    tx_1m: Number(tx1mResolved.value || 0) || 0,
    tx_5m_avg: Number(tx5mAvgResolved.value || 0) || 0,
    tx_30m_avg: Number(tx30mAvgResolved.value || 0) || 0,
    rolling_high_5m: Number(rollingHigh5mResolved.value || 0) || 0,
    tx_1h: Number(tx1hResolved.value || 0) || 0,
    uniqueBuyers1m: Number(uniqueBuyers1mResolved.value || 0) || 0,
    uniqueBuyers5m: Number(uniqueBuyers5mResolved.value || 0) || 0,
    uniqueWallet1m: Number(s?.raw?.uniqueWallet1m ?? p?.birdeye?.uniqueWallet1m ?? wsBe?.uniqueWallet1m ?? 0) || 0,
    uniqueWallet5m: Number(s?.raw?.uniqueWallet5m ?? p?.birdeye?.uniqueWallet5m ?? wsBe?.uniqueWallet5m ?? 0) || 0,
  };
  const normalized = {
    ...p,
    priceUsd: Number(s.priceUsd ?? l.priceUsd ?? p.priceUsd ?? p.price ?? 0) || 0,
    price: Number(s.priceUsd ?? l.priceUsd ?? p.price ?? p.priceUsd ?? 0) || 0,
    liquidity: { usd: Number(s.liquidityUsd ?? l.liqUsd ?? p?.liquidity?.usd ?? 0) || 0 },
    marketCap: Number(s.marketCapUsd ?? l.mcapUsd ?? p.marketCap ?? p.fdv ?? 0) || 0,
    fdv: Number(s.fdvUsd ?? l.fdvUsd ?? p.fdv ?? 0) || 0,
    pairCreatedAt: Number(s.pairCreatedAt ?? l.pairCreatedAt ?? p.pairCreatedAt ?? 0) || null,
    volume: {
      h1: Number(l.volume1h ?? s?.pair?.volume?.h1 ?? p?.volume?.h1 ?? 0) || 0,
      h4: Number(l.volume4h ?? s?.pair?.volume?.h4 ?? p?.volume?.h4 ?? 0) || 0,
    },
    txns: {
      h1: {
        buys: Number(l.buys1h ?? s?.pair?.txns?.h1?.buys ?? p?.txns?.h1?.buys ?? 0) || 0,
        sells: Number(l.sells1h ?? s?.pair?.txns?.h1?.sells ?? p?.txns?.h1?.sells ?? 0) || 0,
      },
    },
    priceChange: {
      h1: Number(l.pc1h ?? s?.pair?.priceChange?.h1 ?? p?.priceChange?.h1 ?? 0) || 0,
      h4: Number(l.pc4h ?? s?.pair?.priceChange?.h4 ?? p?.priceChange?.h4 ?? 0) || 0,
    },
    birdeye,
  };
  const presentFields = [
    normalized.priceUsd > 0,
    Number(normalized?.liquidity?.usd || 0) > 0,
    Number(normalized.marketCap || 0) > 0,
    Number(normalized?.volume?.h1 || 0) > 0,
    Number(normalized?.txns?.h1?.buys || 0) + Number(normalized?.txns?.h1?.sells || 0) > 0,
    Number(normalized?.priceChange?.h1 || 0) !== 0,
    Number(normalized.pairCreatedAt || 0) > 0,
    Number(normalized?.birdeye?.volume_5m || 0) > 0,
    Number(normalized?.birdeye?.buySellRatio || 0) > 0,
    Number(normalized?.birdeye?.tx_1m || 0) > 0,
  ].filter(Boolean).length;
  const sourceUsed = (s?.priceUsd || s?.liquidityUsd || s?.marketCapUsd)
    ? 'snapshot+merged'
    : ((l?.liqUsd || l?.mcapUsd) ? 'latest+pair' : 'pairOnly');
  const microFieldNames = ['volume_5m', 'volume_30m_avg', 'buySellRatio', 'tx_1m', 'tx_5m_avg'];
  const microPresent = microFieldNames.reduce((acc, key) => acc + (Number(normalized?.birdeye?.[key] || 0) > 0 ? 1 : 0), 0);
  const microSourceUsed = (Number(l?.volume5m || 0) > 0 || Number(l?.tx1m || 0) > 0 || Number(l?.buySellRatio || 0) > 0)
    ? 'latest'
    : ((Number(s?.volume_5m || 0) > 0 || Number(s?.tx_1m || 0) > 0 || Number(s?.buySellRatio || 0) > 0 || Number(s?.pair?.birdeye?.volume_5m || 0) > 0)
      ? 'snapshot'
      : ((Number(p?.birdeye?.volume_5m || 0) > 0 || Number(wsBe?.volume_5m || 0) > 0) ? 'pair/ws' : 'none'));
  const rawAvail = {
    snapshot: { priceUsd: s?.priceUsd ?? null, liquidityUsd: s?.liquidityUsd ?? null, marketCapUsd: s?.marketCapUsd ?? null, freshnessMs: s?.freshnessMs ?? null },
    latest: { priceUsd: l?.priceUsd ?? null, liqUsd: l?.liqUsd ?? null, mcapUsd: l?.mcapUsd ?? null, freshnessMs: l?.marketDataFreshnessMs ?? null },
    pair: { priceUsd: p?.priceUsd ?? p?.price ?? null, liqUsd: p?.liquidity?.usd ?? null, mcapUsd: p?.marketCap ?? p?.fdv ?? null },
    microSources: {
      volume_5m: volume5mResolved.source,
      volume_30m_avg: volume30mAvgResolved.source,
      buySellRatio: buySellRatioResolved.source,
      tx_1m: tx1mResolved.source,
      tx_5m_avg: tx5mAvgResolved.source,
      tx_30m_avg: tx30mAvgResolved.source,
      rolling_high_5m: rollingHigh5mResolved.source,
      tx_1h: tx1hResolved.source,
      uniqueBuyers1m: uniqueBuyers1mResolved.source,
      uniqueBuyers5m: uniqueBuyers5mResolved.source,
    },
  };
  return { normalized, presentFields, sourceUsed, rawAvail, microPresent, microSourceUsed };
}

export function pruneMomentumRepeatFailMap(map, { nowMs = Date.now(), staleAfterMs = 30 * 60_000, maxEntries = Infinity } = {}) {
  const target = map && typeof map === 'object' ? map : {};
  const cutoff = Number(nowMs || Date.now()) - Math.max(60_000, Number(staleAfterMs || 0));
  let entries = Object.entries(target)
    .filter(([, value]) => Number(value?.tMs || 0) >= cutoff);

  if (Number.isFinite(maxEntries) && maxEntries > 0 && entries.length > maxEntries) {
    entries = entries
      .sort((a, b) => Number(b?.[1]?.tMs || 0) - Number(a?.[1]?.tMs || 0))
      .slice(0, maxEntries);
  }

  const keep = new Set(entries.map(([key]) => key));
  for (const key of Object.keys(target)) {
    if (!keep.has(key)) delete target[key];
  }
  return target;
}
