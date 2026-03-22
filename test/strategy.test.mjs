import { describe, it, expect } from 'vitest';
import { evaluateMomentumSignal, canUseMomentumFallback } from '../src/strategy.mjs';

describe('strategy momentum profiles', () => {
  const pair = {
    volume: { h1: 1000, h4: 3600 },
    txns: { h1: { buys: 8, sells: 6 } },
    priceChange: { h1: 1.2, h4: 2.6 },
  };

  it('hard guards dominate profile thresholds when setup is unsafe', () => {
    const normal = evaluateMomentumSignal(pair, { profile: 'normal', strict: false });
    const aggressive = evaluateMomentumSignal(pair, { profile: 'aggressive', strict: false });
    expect(normal.ok).toBe(false);
    expect(aggressive.ok).toBe(false);
    expect(Number(aggressive.thresholds.minBuys)).toBeLessThanOrEqual(Number(normal.thresholds.minBuys));
  });

  it('fallback allows near miss only', () => {
    const nearMissPair = {
      volume: { h1: 1000, h4: 3000 },
      txns: { h1: { buys: 12, sells: 4 } },
      priceChange: { h1: 1.4, h4: 2.8 },
    };
    const sig = evaluateMomentumSignal(nearMissPair, { profile: 'normal', strict: false });
    expect(sig.ok).toBe(false);
    expect(canUseMomentumFallback(sig, { tolerance: 0.85 })).toBe(true);

    const farMissPair = {
      ...nearMissPair,
      priceChange: { h1: 0.4, h4: 0.9 },
    };
    const farSig = evaluateMomentumSignal(farMissPair, { profile: 'normal', strict: false });
    expect(canUseMomentumFallback(farSig, { tolerance: 0.85 })).toBe(false);
  });
});
