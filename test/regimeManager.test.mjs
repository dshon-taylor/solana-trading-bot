import { describe, it, expect } from 'vitest';
import RegimeManager, { MODES } from '../src/trading/regimeManager.mjs';

describe('regimeManager', () => {
  it('normalizes and computes bounded score', () => {
    const rm = new RegimeManager({ logger: { info: () => {} } });
    rm.updateMetrics({
      confirmRate10m: 0.8,
      runnerRate30m: 0.05,
      snapshotBlockRate10m: 0.01,
      winRate30m: 0.2,
      marketHeat10m: 0.2,
    });
    const { score, normalized } = rm.computeScore();
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(normalized.confirmRate10m).toBeGreaterThanOrEqual(0);
    expect(normalized.confirmRate10m).toBeLessThanOrEqual(1);
  });

  it('applies hysteresis transitions across modes', () => {
    const rm = new RegimeManager({ logger: { info: () => {} } });
    expect(rm.getMode()).toBe(MODES.BALANCED);

    const defenseMetrics = {
      confirmRate10m: 0.1,
      runnerRate30m: 0.01,
      snapshotBlockRate10m: 0.0,
      winRate30m: 0.05,
      marketHeat10m: 0.1,
    };
    for (let i = 0; i < 3; i += 1) {
      rm.updateMetrics(defenseMetrics);
      rm._computeAndApply();
    }
    expect(rm.getMode()).toBe(MODES.DEFENSE);

    const aggressiveMetrics = {
      confirmRate10m: 0.9,
      runnerRate30m: 0.16,
      snapshotBlockRate10m: 0.0,
      winRate30m: 0.9,
      marketHeat10m: 0.9,
    };
    for (let i = 0; i < 3; i += 1) {
      rm.updateMetrics(aggressiveMetrics);
      rm._computeAndApply();
    }
    expect(rm.getMode()).toBe(MODES.AGGRESSIVE);
  });
});
