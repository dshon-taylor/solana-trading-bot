import { describe, it, expect } from 'vitest';
import { getMarketSnapshot, isEntrySnapshotSafe, isStopSnapshotUsable, getWatchlistEntrySnapshotUnsafeReason, snapshotFromBirdseye } from '../src/market_data_router.mjs';

describe('market data router', () => {
  it('uses Birdseye first when enabled, then Jupiter, then Dex, then bounded cache', async () => {
    const state = {};

    const birdSnap = await getMarketSnapshot({
      state,
      mint: 'mintA',
      nowMs: 1_000,
      maxAgeMs: 10_000,
      birdeyeEnabled: true,
      getBirdseyeSnapshot: async () => ({ priceUsd: 1.6, liquidityUsd: 25_000, txns: { h24: { buys: 30, sells: 20 } }, volume: { h24: 22_000 } }),
      getTokenPairs: async () => [{ priceUsd: '1.5', liquidity: { usd: 20000 }, txns: { h1: { buys: 12, sells: 4 } }, volume: { h1: 1000 } }],
      pickBestPair: (pairs) => pairs[0],
      getJupPrice: async () => 1.4,
    });

    expect(birdSnap.source).toBe('birdeye');
    expect(birdSnap.priceUsd).toBe(1.6);

    const jupSnap = await getMarketSnapshot({
      state,
      mint: 'mintA',
      nowMs: 2_000,
      maxAgeMs: 10_000,
      birdeyeEnabled: true,
      getBirdseyeSnapshot: async () => null,
      getTokenPairs: async () => [{ priceUsd: '1.5', liquidity: { usd: 20000 }, txns: { h1: { buys: 12, sells: 4 } }, volume: { h1: 1000 } }],
      pickBestPair: (pairs) => pairs[0],
      getJupPrice: async () => 1.45,
    });

    expect(jupSnap.source).toBe('jupiter');

    const dexSnap = await getMarketSnapshot({
      state,
      mint: 'mintA',
      nowMs: 3_000,
      maxAgeMs: 10_000,
      birdeyeEnabled: true,
      getBirdseyeSnapshot: async () => null,
      getTokenPairs: async () => {
        return [{ priceUsd: '1.5', liquidity: { usd: 20000 }, txns: { h1: { buys: 12, sells: 4 } }, volume: { h1: 1000 } }]
      },
      pickBestPair: (pairs) => pairs[0],
      getJupPrice: async () => { throw new Error('jup down'); },
      allowDex: true,
    });

    expect(dexSnap.source).toBe('dexscreener');

    const cacheSnap = await getMarketSnapshot({
      state,
      mint: 'mintA',
      nowMs: 4_000,
      maxAgeMs: 10_000,
      birdeyeEnabled: true,
      getBirdseyeSnapshot: async () => null,
      getTokenPairs: async () => {
        throw new Error('dex down');
      },
      pickBestPair: (pairs) => pairs[0],
      getJupPrice: async () => null,
    });

    expect(cacheSnap.source).toBe('cache');
    expect(cacheSnap.priceUsd).toBe(1.45);
  });

  it('entry/stop gates reject low-confidence or stale snapshots', () => {
    const low = { priceUsd: 1, confidenceScore: 0.4, freshnessMs: 10_000 };
    const stale = { priceUsd: 1, confidenceScore: 0.9, freshnessMs: 600_000 };
    const good = { priceUsd: 1, confidenceScore: 0.9, freshnessMs: 1_000 };

    expect(isEntrySnapshotSafe(low)).toBe(false);
    expect(isEntrySnapshotSafe(stale)).toBe(false);
    expect(isEntrySnapshotSafe(good)).toBe(true);

    expect(isStopSnapshotUsable(low)).toBe(false);
    expect(isStopSnapshotUsable(stale)).toBe(false);
    expect(isStopSnapshotUsable(good)).toBe(true);
  });

  it('watchlist entry gate: Birdseye snapshot passes safety when pair snapshot missing (routeAvailable required)', () => {
    const nowMs = 100_000;
    const routeOnly = { source: 'routeAvailableOnly', priceUsd: null, confidenceScore: 0, freshnessMs: 0 };
    const bird = snapshotFromBirdseye({ priceUsd: 1.23, liquidityUsd: 50_000, txns: { h24: { buys: 240, sells: 240 } }, volume: { h24: 24_000 }, atMs: nowMs }, nowMs);

    const reason = getWatchlistEntrySnapshotUnsafeReason({ snapshot: routeOnly, birdseyeSnapshot: bird });
    // Current policy: safe BirdEye snapshot can satisfy watchlist safety.
    expect(reason).toBe(null);
  });

  it('watchlist entry gate: stale Birdseye is rejected with birdeyeStale', () => {
    const nowMs = 200_000;
    const bird = snapshotFromBirdseye({ priceUsd: 1.23, liquidityUsd: 50_000, txns: { h24: { buys: 240, sells: 240 } }, volume: { h24: 24_000 }, atMs: nowMs - 120_000 }, nowMs);

    const reason = getWatchlistEntrySnapshotUnsafeReason({ snapshot: null, birdseyeSnapshot: bird });
    expect(reason).toBe('unsafeSnapshot.birdeyeStale');
  });

  it('watchlist entry gate: falls back to existing snapshot when Birdseye missing', () => {
    const good = { priceUsd: 1, confidenceScore: 0.9, freshnessMs: 1_000, liquidityUsd: 60_000, routeAvailable: true };
    const reasonGood = getWatchlistEntrySnapshotUnsafeReason({ snapshot: good, birdseyeSnapshot: null });
    expect(reasonGood).toBe(null);

    const missingPrice = { priceUsd: null, confidenceScore: 0.9, freshnessMs: 1_000 };
    const reasonMissing = getWatchlistEntrySnapshotUnsafeReason({ snapshot: missingPrice, birdseyeSnapshot: null });
    expect(reasonMissing).toBe('unsafeSnapshot.birdeyeMissing');
  });
});
