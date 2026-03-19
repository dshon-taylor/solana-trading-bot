import { describe, it, expect } from 'vitest';
import { computeTrailPct, computeStopFromAnchor, updateTrailingAnchor } from '../src/lib/trailing.mjs';

describe('trailing', () => {
  it('computeTrailPct tiers', () => {
    // below 30% -> stop-at-entry (null)
    expect(computeTrailPct(0.29)).toBeNull();
    expect(computeTrailPct(-0.5)).toBeNull();

    // boundary and between tiers
    expect(computeTrailPct(0.30)).toBe(0.30);
    expect(computeTrailPct(0.5)).toBe(0.30);
    expect(computeTrailPct(0.80)).toBe(0.22);
    expect(computeTrailPct(1.50)).toBe(0.18);
    expect(computeTrailPct(10)).toBe(0.18);
  });

  it('computeStopFromAnchor is monotonic with trailPct (smaller trailPct -> higher stop)', () => {
    const anchor = 100;
    const stopWide = computeStopFromAnchor(anchor, 0.30, 0); // wider trail -> lower stop
    const stopTight = computeStopFromAnchor(anchor, 0.18, 0); // tighter trail -> higher stop

    expect(stopTight).toBeGreaterThan(stopWide);

    // slippage increases safe stop slightly
    const stopTightWithSlip = computeStopFromAnchor(anchor, 0.18, 0.02);
    expect(stopTightWithSlip).toBeGreaterThan(stopTight * 0.99); // sanity
  });

  it('updateTrailingAnchor only raises anchor (never lowers it)', () => {
    expect(updateTrailingAnchor(110, 100)).toBe(110);
    expect(updateTrailingAnchor(90, 100)).toBe(100);
    expect(updateTrailingAnchor(null, 100)).toBe(100);
    expect(updateTrailingAnchor(120, null)).toBe(120);
  });
});
