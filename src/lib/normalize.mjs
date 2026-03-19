// Type normalization utilities to avoid redundant Number() conversions
// Validate and convert at data boundaries, then use directly

/**
 * Safely converts to number, returns 0 if invalid
 */
export function toNumber(value, defaultVal = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : defaultVal;
}

/**
 * Safely converts to positive number, returns 0 if invalid or negative
 */
export function toPositiveNumber(value, defaultVal = 0) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : defaultVal;
}

/**
 * Normalize market data snapshot from any provider
 */
export function normalizeMarketSnapshot(raw) {
  if (!raw) {
    return {
      price: 0,
      mcap: 0,
      liquidity: { usd: 0 },
      volume: { h24: 0 },
      priceChange: { h24: 0 },
      txns: { h24: { buys: 0, sells: 0 } }
    };
  }
  
  return {
    price: toPositiveNumber(raw.priceUsd || raw.price || raw.lastPrice),
    mcap: toPositiveNumber(raw.marketCapUsd || raw.marketCap || raw.mcap || raw.fdv || raw.mcapUsd),
    liquidity: {
      usd: toPositiveNumber(raw.liquidity?.usd || raw.liquidityUsd)
    },
    volume: {
      h1: toPositiveNumber(raw.volume?.h1),
      h4: toPositiveNumber(raw.volume?.h4),
      h24: toPositiveNumber(raw.volume?.h24),
      m5: toPositiveNumber(raw.volume?.m5),
    },
    txns: {
      h1: {
        buys: toNumber(raw.txns?.h1?.buys),
        sells: toNumber(raw.txns?.h1?.sells),
      },
      h24: {
        buys: toNumber(raw.txns?.h24?.buys),
        sells: toNumber(raw.txns?.h24?.sells),
      },
      m5: {
        buys: toNumber(raw.txns?.m5?.buys),
        sells: toNumber(raw.txns?.m5?.sells),
      },
      s30: {
        buys: toNumber(raw.txns?.s30?.buys),
        sells: toNumber(raw.txns?.s30?.sells),
      },
    },
    priceChange: {
      h1: toNumber(raw.priceChange?.h1),
      h4: toNumber(raw.priceChange?.h4),
      h24: toNumber(raw.priceChange?.h24),
      m5: toNumber(raw.priceChange?.m5),
      m1: toNumber(raw.priceChange?.m1),
    },
  };
}

/**
 * Normalize BirdEye signals
 */
export function normalizeBirdEyeSignals(be) {
  if (!be) {
    return {
      price: 0,
      volume_5m: 0,
      volume_30m_avg: 0,
      buy_sell_ratio: 0,
      tx_1m: 0,
      tx_5m_avg: 0,
      tx_1h: 0,
      rolling_high_5m: 0
    };
  }
  
  return {
    price: toPositiveNumber(be.price),
    volume_5m: toPositiveNumber(be.volume_5m),
    volume_30m_avg: toPositiveNumber(be.volume_30m_avg),
    buy_sell_ratio: toPositiveNumber(be.buy_sell_ratio || be.buySellRatio),
    tx_1m: toNumber(be.tx_1m),
    tx_5m_avg: toNumber(be.tx_5m_avg),
    tx_30m_avg: toNumber(be.tx_30m_avg),
    tx_1h: toNumber(be.tx_1h || be.tx_60m),
    rolling_high_5m: toPositiveNumber(be.rolling_high_5m || be.rolling_high_5min),
    walletExpansion: toPositiveNumber(be.walletExpansion),
    uniqueBuyers1m: toNumber(be.uniqueBuyers1m || be.uniqueWallet1m),
    uniqueBuyers5m: toNumber(be.uniqueBuyers5m || be.uniqueWallet5m),
    ret_1m: toNumber(be.ret_1m || be.ret1m),
    ret_5m: toNumber(be.ret_5m || be.ret5m),
    volatility_1m: toNumber(be.volatility_1m || be.vol1m),
    buyDominance: toNumber(be.buyDominance || be.buy_dominance),
  };
}

/**
 * Normalize pair data from DexScreener
 */
export function normalizeDexPair(pair) {
  if (!pair) return null;
  
  return {
    baseToken: {
      address: String(pair.baseToken?.address || ''),
      symbol: String(pair.baseToken?.symbol || ''),
    },
    priceUsd: toPositiveNumber(pair.priceUsd),
    liquidity: {
      usd: toPositiveNumber(pair.liquidity?.usd),
    },
    volume: {
      h1: toPositiveNumber(pair.volume?.h1),
      h4: toPositiveNumber(pair.volume?.h4),
      h24: toPositiveNumber(pair.volume?.h24),
    },
    txns: {
      h1: {
        buys: toNumber(pair.txns?.h1?.buys),
        sells: toNumber(pair.txns?.h1?.sells),
      },
      h24: {
        buys: toNumber(pair.txns?.h24?.buys),
        sells: toNumber(pair.txns?.h24?.sells),
      },
    },
    priceChange: {
      h1: toNumber(pair.priceChange?.h1),
      h4: toNumber(pair.priceChange?.h4),
      h24: toNumber(pair.priceChange?.h24),
    },
    marketCap: toPositiveNumber(pair.marketCap || pair.fdv),
    fdv: toPositiveNumber(pair.fdv),
    pairCreatedAt: toNumber(pair.pairCreatedAt),
    pairAddress: String(pair.pairAddress || ''),
    dexId: String(pair.dexId || ''),
    url: String(pair.url || ''),
    spreadPct: toNumber(pair.spreadPct || pair.market?.spreadPct),
  };
}

export default {
  toNumber,
  toPositiveNumber,
  normalizeMarketSnapshot,
  normalizeBirdEyeSignals,
  normalizeDexPair,
};
