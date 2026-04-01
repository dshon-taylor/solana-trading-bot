import { describe, expect, it } from 'vitest';

import {
  computeRollingStability,
  evaluateReplay,
  optimizeReplay,
  parseRangeSpec,
  simulateReplayPosition,
} from '../src/analytics/replay_optimizer.mjs';

describe('replay_optimizer', () => {
  it('parses range specs deterministically', () => {
    expect(parseRangeSpec('0.1:0.2:0.05')).toEqual([0.1, 0.15, 0.2]);
    expect(parseRangeSpec('0.1,0.15,0.2')).toEqual([0.1, 0.15, 0.2]);
  });

  it('simulates stop-at-entry + trailing exits', () => {
    const sim = simulateReplayPosition({
      entryPrice: 1,
      rules: { stopEntryBufferPct: 0.01, trailActivatePct: 0.1, trailDistancePct: 0.05 },
      series: [
        { t: 't1', tMs: 1, price: 1 },
        { t: 't2', tMs: 2, price: 1.12 },
        { t: 't3', tMs: 3, price: 1.2 },
        { t: 't4', tMs: 4, price: 1.05 },
      ],
    });

    expect(sim.exitReason).toBe('trailingStop');
    expect(sim.pnlPct).toBeGreaterThan(0);
  });

  it('evaluates and ranks optimization candidates', () => {
    const dataset = [
      {
        key: 'a',
        entryPrice: 1,
        startedAtMs: 1,
        series: [
          { t: 't1', tMs: 1, price: 1 },
          { t: 't2', tMs: 2, price: 1.25 },
          { t: 't3', tMs: 3, price: 1.18 },
        ],
      },
      {
        key: 'b',
        entryPrice: 1,
        startedAtMs: 2,
        series: [
          { t: 't1', tMs: 1, price: 1 },
          { t: 't2', tMs: 2, price: 0.995 },
          { t: 't3', tMs: 3, price: 0.98 },
        ],
      },
    ];

    const evalOut = evaluateReplay({
      dataset,
      rules: { stopEntryBufferPct: 0.003, trailActivatePct: 0.1, trailDistancePct: 0.1 },
    });
    expect(evalOut.metrics.trades).toBe(2);
    expect(evalOut.metrics.exits).toBeTruthy();

    const ranked = optimizeReplay({
      dataset,
      grid: {
        trailDistancePct: '0.05:0.1:0.05',
        trailActivatePct: '0.1:0.2:0.1',
        stopEntryBufferPct: '0.002:0.004:0.002',
      },
      top: 2,
      rollingWindows: 2,
    });

    expect(ranked.length).toBe(2);
    expect(ranked[0].metrics.stability).toBeTruthy();
    expect(Number.isFinite(ranked[0].metrics.stability.consistencyScore)).toBe(true);
  });

  it('computes deterministic rolling stability metrics', () => {
    const stability = computeRollingStability({
      windows: 3,
      trades: [
        { key: 'a', startedAtMs: 1, pnlPct: 0.1 },
        { key: 'b', startedAtMs: 2, pnlPct: 0.12 },
        { key: 'c', startedAtMs: 3, pnlPct: -0.05 },
        { key: 'd', startedAtMs: 4, pnlPct: -0.04 },
        { key: 'e', startedAtMs: 5, pnlPct: 0.08 },
        { key: 'f', startedAtMs: 6, pnlPct: 0.09 },
      ],
    });

    expect(stability.windowTradeCounts).toEqual([2, 2, 2]);
    expect(stability.positiveWindowRate).toBeCloseTo(2 / 3, 6);
    expect(stability.pnlAvgStdDev).toBeGreaterThan(0);
  });
});
