function jitterMs(ms, pct = 0.2) {
  const delta = ms * pct;
  const v = ms + ((Math.random() * 2 - 1) * delta);
  return Math.max(0, Math.round(v));
}

export function ensureMarketDataState(state) {
  state.marketData ||= {};
  state.marketData.pairCache ||= {};
  state.marketData.scan ||= {};
  state.marketData.scan.lastDelayMs = Number(state.marketData.scan.lastDelayMs || 0);
  return state.marketData;
}

export function rememberPairSnapshot({ state, mint, pair, nowMs }) {
  ensureMarketDataState(state);
  if (!mint || !pair) return;
  state.marketData.pairCache[mint] = {
    pair,
    atMs: nowMs,
  };
}

export function getCachedPairSnapshot({ state, mint, nowMs, maxAgeMs }) {
  ensureMarketDataState(state);
  const row = state.marketData.pairCache?.[mint];
  if (!row?.pair || !Number.isFinite(Number(row?.atMs))) return null;
  const ageMs = Math.max(0, nowMs - Number(row.atMs));
  if (ageMs > maxAgeMs) return null;
  return { pair: row.pair, ageMs };
}

export async function getPairWithFallback({
  state,
  mint,
  nowMs,
  maxAgeMs,
  fetchPairs,
  pickBestPair,
}) {
  try {
    const pairs = await fetchPairs(mint);
    const pair = pickBestPair(pairs);
    if (!pair) return { pair: null, source: 'none' };
    rememberPairSnapshot({ state, mint, pair, nowMs });
    return { pair, source: 'live' };
  } catch (error) {
    const cached = getCachedPairSnapshot({ state, mint, nowMs, maxAgeMs });
    if (cached?.pair) {
      return { pair: cached.pair, source: 'cache', cacheAgeMs: cached.ageMs, error };
    }
    throw error;
  }
}

export function computeAdaptiveScanDelayMs({ state, nowMs, baseScanMs, maxScanMs }) {
  ensureMarketDataState(state);
  const streak = Math.max(0, Number(state?.dex?.streak429 || 0));
  const last429AtMs = Number(state?.dex?.last429AtMs || 0);
  const cooldownUntilMs = Number(state?.dex?.cooldownUntilMs || 0);

  let pressureFactor = 1;
  if (streak > 0) pressureFactor = Math.min(6, 1 + (streak * 0.45));
  if (last429AtMs > 0 && (nowMs - last429AtMs) > 10 * 60_000) pressureFactor = 1;

  let nextMs = Math.round(baseScanMs * pressureFactor);

  if (cooldownUntilMs > nowMs) {
    const remain = cooldownUntilMs - nowMs;
    nextMs = Math.max(nextMs, remain + 500);
  }

  nextMs = Math.min(maxScanMs, Math.max(baseScanMs, nextMs));
  nextMs = jitterMs(nextMs, 0.18);
  state.marketData.scan.lastDelayMs = nextMs;
  return nextMs;
}
