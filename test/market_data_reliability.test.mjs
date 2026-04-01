import { describe, it, expect } from 'vitest';
import {
  ensureMarketDataState,
  getPairWithFallback,
  computeAdaptiveScanDelayMs,
} from '../src/market_data/reliability.mjs';

describe('market data reliability', () => {
  it('falls back to cached pair when live fetch fails', async () => {
    const state = {};
    ensureMarketDataState(state);

    const pair = { baseToken: { address: 'mint1' }, priceUsd: '1.23' };

    const live = await getPairWithFallback({
      state,
      mint: 'mint1',
      nowMs: 1_000,
      maxAgeMs: 10_000,
      fetchPairs: async () => [pair],
      pickBestPair: (pairs) => pairs[0],
    });

    expect(live.source).toBe('live');

    const fallback = await getPairWithFallback({
      state,
      mint: 'mint1',
      nowMs: 5_000,
      maxAgeMs: 10_000,
      fetchPairs: async () => {
        throw new Error('DEXSCREENER_429');
      },
      pickBestPair: (pairs) => pairs[0],
    });

    expect(fallback.source).toBe('cache');
    expect(fallback.pair?.priceUsd).toBe('1.23');
  });

  it('increases scan delay under dex 429 pressure', () => {
    const state = {
      dex: {
        streak429: 3,
        last429AtMs: 10_000,
        cooldownUntilMs: 0,
      },
    };

    const delay = computeAdaptiveScanDelayMs({
      state,
      nowMs: 11_000,
      baseScanMs: 20_000,
      maxScanMs: 300_000,
    });

    expect(delay).toBeGreaterThanOrEqual(20_000);
    expect(delay).toBeGreaterThan(25_000);
  });
});
