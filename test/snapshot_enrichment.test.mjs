import { describe, it, expect } from 'vitest';
import { computeConfidence, validateSnapshot } from '../src/lib/snapshot/validators.mjs';

describe('snapshot validators', () => {
  it('computes confidence for healthy bird snapshot', () => {
    const c = computeConfidence({ source: 'birdeye', liquidityUsd: 100000, txns: { h1: { buys: 1, sells: 0 } }, freshnessMs: 1000 });
    expect(c).toBeGreaterThanOrEqual(0.7);
  });

  it('flags missing price and low liquidity', () => {
    const unsafe = validateSnapshot({ priceUsd: null, liquidityUsd: 1000, snapshotAgeMs: 1000, routeAvailable: true }, { minLiquidityUsd: 50000, maxFreshnessMs: 20000 });
    expect(unsafe).toContain('missingPrice');
    expect(unsafe).toContain('liquidityBelowThreshold');
  });
});
