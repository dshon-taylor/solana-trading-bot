import fs from 'fs';
const env = process.env;
export const DEFAULTS = {
  MIN_LIQUIDITY_FLOOR_USD: Number(env.MIN_LIQUIDITY_FLOOR_USD || 25000),
  LIVE_PROBE_MIN_LIQ_USD: Number(env.LIVE_PROBE_MIN_LIQ_USD || 25000),
  LIVE_CONFIRM_MIN_LIQ_USD: Number(env.LIVE_CONFIRM_MIN_LIQ_USD || 50000),
  LOW_LIQ_STRICT_MOMENTUM_USD: Number(env.LOW_LIQ_STRICT_MOMENTUM_USD || 25000),
  BIRDEYE_PER_MINT_MIN_INTERVAL_MS: Number(env.BIRDEYE_PER_MINT_MIN_INTERVAL_MS || 30000),
};

// Accepts snapshot-like pair and wsCache (optional) and returns computed signals.
// Primary: BirdEye fields (be). Fallback: derive signals from pair (dex/jup-like shapes).
export function computeBirdEyeSignals(pair, wsCache = {}) {
  // birdEye fields expected on pair.birdeye or wsCache
  const be = (pair?.birdeye) || wsCache.birdeye || {};
  const price = Number(pair?.price || pair?.lastPrice || pair?.priceUsd || 0);

  // BirdEye native fields
  const volume_5m = Number(be.volume_5m || 0);
  const volume_30m_avg = Number(be.volume_30m_avg || 0);
  const buySellRatio = Number(be.buySellRatio || 0);
  const tx_1m = Number(be.tx_1m || 0);
  const tx_5m_avg = Number(be.tx_5m_avg || 0);
  const tx_30m_avg = Number(be.tx_30m_avg || 0);
  const rolling_high_5m = Number(be.rolling_high_5m || be.rolling_high_5min || 0);
  const tx_1h = Number(be.tx_1h || be.tx_60m || 0);
  const raw = pair?.raw || be?.raw || {};
  const uniqueBuyers1mRaw = Number(
    be.uniqueBuyers1m || be.uniqueWallet1m || be.unique_buyers_1m || be.uniqueWalletHistory1m
    || raw.uniqueBuyers1m || raw.uniqueWallet1m || raw.unique_wallet_1m || raw.uniqueWalletHistory1m
    || 0
  );
  const uniqueBuyers5mRaw = Number(
    be.uniqueBuyers5m || be.uniqueWallet5m || be.unique_buyers_5m || be.uniqueWalletHistory5m
    || raw.uniqueBuyers5m || raw.uniqueWallet5m || raw.unique_wallet_5m || raw.uniqueWalletHistory5m
    || 0
  );

  // Fallback derivations when BirdEye fields missing
  // Use pair.volume.h1 as proxied 5m/30m signals where appropriate.
  const pairVolH1 = Number(pair?.volume?.h1 || pair?.volume?.h24 || 0);
  const pairTxH1 = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
  const pairVolH4 = Number(pair?.volume?.h4 || 0);
  const pairPriceChangeH1 = Number(pair?.priceChange?.h1 || 0);

  // If BirdEye doesn't provide short-window fields, derive reasonable fallbacks.
  const usedFallbackVolume5m = !(Number(volume_5m) > 0);
  const usedFallbackVolume30m = !(Number(volume_30m_avg) > 0);
  const usedFallbackTx1m = !(Number(tx_1m) > 0);
  const usedFallbackTx5mAvg = !(Number(tx_5m_avg) > 0);

  // Prefer comparable real micro windows (5m vs 30m/6).
  // Avoid paired h1-derived defaults that can force volStrength ~= 0.50.
  const volume5mFromH1 = Math.round(pairVolH1 / 12);
  const volume30mAvgFromH4 = Math.round(pairVolH4 / 8);
  const effectiveVolume5m = volume_5m || (volume5mFromH1 > 0 ? volume5mFromH1 : 0);
  const effectiveVolume30mAvg = volume_30m_avg || (volume30mAvgFromH4 > 0 ? volume30mAvgFromH4 : 0);
  const effectiveBuySellRatio = buySellRatio || (() => {
    const buys = Number(pair?.txns?.h1?.buys || 0);
    const sells = Number(pair?.txns?.h1?.sells || 0) || 1;
    return sells === 0 ? (buys > 0 ? Infinity : 0) : (buys / sells);
  })();
  const effectiveTx1m = tx_1m || Math.round(pairTxH1 / 60);
  const tx30Baseline = tx_30m_avg || Math.max(1, Math.round(pairTxH1 / 60));
  const effectiveTx5mAvg = tx_5m_avg || Math.max(1, Math.round(((effectiveTx1m * 1) + (tx30Baseline * 4)) / 5));
  const effectiveRollingHigh5m = rolling_high_5m || (pair?.priceChange?.h1 ? (price / (1 + (pairPriceChangeH1/100))) : 0);
  const effectiveTx1h = tx_1h || pairTxH1;
  const effectiveUniqueBuyers1m = Number.isFinite(uniqueBuyers1mRaw) && uniqueBuyers1mRaw > 0 ? uniqueBuyers1mRaw : 0;
  const effectiveUniqueBuyers5mTotal = Number.isFinite(uniqueBuyers5mRaw) && uniqueBuyers5mRaw > 0 ? uniqueBuyers5mRaw : 0;
  const effectiveUniqueBuyers5mAvg = effectiveUniqueBuyers5mTotal > 0 ? (effectiveUniqueBuyers5mTotal / 5) : 0;
  const walletExpansion = effectiveUniqueBuyers5mAvg > 0 ? (effectiveUniqueBuyers1m / effectiveUniqueBuyers5mAvg) : 0;

  const volumeExpansion = effectiveVolume5m > effectiveVolume30mAvg;
  const buyPressure = Number(effectiveBuySellRatio || 0) > 1.2;
  const txAcceleration = effectiveTx1m > effectiveTx5mAvg;
  const priceAboveRollingHigh = price > effectiveRollingHigh5m;

  return {
    price,
    volume_5m: effectiveVolume5m,
    volume_30m_avg: effectiveVolume30mAvg,
    buySellRatio: effectiveBuySellRatio,
    tx_1m: effectiveTx1m,
    tx_5m_avg: effectiveTx5mAvg,
    tx_30m_avg: tx30Baseline,
    rolling_high_5m: effectiveRollingHigh5m,
    tx_1h: effectiveTx1h,
    uniqueBuyers1m: effectiveUniqueBuyers1m,
    uniqueBuyers5m: effectiveUniqueBuyers5mTotal,
    uniqueBuyers5mAvg: effectiveUniqueBuyers5mAvg,
    walletExpansion,
    volumeExpansion,
    buyPressure,
    txAcceleration,
    priceAboveRollingHigh,
    fallbackMeta: {
      volume: usedFallbackVolume5m || usedFallbackVolume30m,
      volumeSource: (!usedFallbackVolume5m && !usedFallbackVolume30m) ? 'real_micro' : ((effectiveVolume5m > 0 && effectiveVolume30mAvg > 0) ? 'fallback_mixed' : 'fallback_missing_30m'),
      tx: usedFallbackTx1m || usedFallbackTx5mAvg,
    },
  };
}

export function fetchPaperMetricsFromBirdEye(pair, wsCache = {}, fetcher = null) {
  // Optional: use OHLCV in be to compute paper.ret5 / ret15 if present.
  const be = (pair?.birdeye) || wsCache.birdeye || {};
  if (!be.ohlcv) return null;
  try {
    const o = be.ohlcv; // expect array of candles with {t, o, h, l, c}
    // compute last 5m/15m returns if available
    const latest = o[o.length - 1];
    const five = o.filter(c => latest.t - c.t <= 5 * 60 * 1000);
    const fifteen = o.filter(c => latest.t - c.t <= 15 * 60 * 1000);
    const ret5 = five.length ? (latest.c / five[0].o - 1) * 100 : null;
    const ret15 = fifteen.length ? (latest.c / fifteen[0].o - 1) * 100 : null;
    return { ret5, ret15 };
  } catch (e) {
    return null;
  }
}
