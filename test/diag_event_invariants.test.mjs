import { describe, it, expect } from 'vitest';
import {
  resolveConfirmTxMetricsFromDiagEvent,
  validateDiagEventNumericIntegrity,
  validateDiagEventBatch,
} from '../src/control_tower/diag_reporting/diag_event_invariants.mjs';

describe('diag_event_invariants', () => {
  it('resolves confirm tx metrics from evaluation-time event only', () => {
    const ev = {
      tMs: Date.now(),
      kind: 'postMomentumFlow',
      stage: 'confirm',
      outcome: 'reached',
      tx1m: 12,
      tx5mAvg: 4,
      tx30mAvg: 3,
      txMetricSource: 'confirm.eval',
    };

    const r = resolveConfirmTxMetricsFromDiagEvent(ev);
    expect(r).toEqual({
      tx1m: 12,
      tx5mAvg: 4,
      tx30mAvg: 3,
      txAccelObserved: 3,
      txMetricSource: 'confirm.eval',
    });
  });

  it('does not fabricate zeros for missing confirm tx metrics', () => {
    const r = resolveConfirmTxMetricsFromDiagEvent({ tMs: Date.now(), kind: 'postMomentumFlow', stage: 'confirm' });
    expect(r.tx1m).toBeNull();
    expect(r.tx5mAvg).toBeNull();
    expect(r.tx30mAvg).toBeNull();
    expect(r.txAccelObserved).toBeNull();
    expect(r.txMetricSource).toBe('unknown');
  });

  it('validates required positive fields by event kind', () => {
    const valid = [
      { tMs: Date.now(), kind: 'candidateLiquiditySeen', liqUsd: 10_000 },
      { tMs: Date.now(), kind: 'momentumLiq', liqUsd: 45_000 },
      { tMs: Date.now(), kind: 'momentumRecent', liq: 50_000, mcap: 300_000 },
      { tMs: Date.now(), kind: 'postMomentumFlow', stage: 'confirm', outcome: 'reached', liq: 55_000, mcap: 350_000, tx1m: 16, tx5mAvg: 6 },
      { tMs: Date.now(), kind: 'scanCycle', durationMs: 1200, totalCycleMs: 1200, scanWallClockMs: 1200 },
    ];

    for (const ev of valid) {
      const res = validateDiagEventNumericIntegrity(ev);
      expect(res.ok, JSON.stringify(res.issues)).toBe(true);
    }
  });

  it('fails when required fields are null/zero where they must be positive', () => {
    const badEvents = [
      { tMs: Date.now(), kind: 'candidateLiquiditySeen', liqUsd: 0 },
      { tMs: Date.now(), kind: 'momentumRecent', liq: null, mcap: 250_000 },
      { tMs: Date.now(), kind: 'postMomentumFlow', stage: 'confirm', outcome: 'passed', liq: 60_000, mcap: 320_000, tx1m: 0, tx5mAvg: 5 },
      { tMs: Date.now(), kind: 'postMomentumFlow', stage: 'attempt', outcome: 'rejected', liq: 0, mcap: 320_000 },
      { tMs: Date.now(), kind: 'scanCycle', durationMs: -1, totalCycleMs: 5, scanWallClockMs: 4 },
    ];

    const r = validateDiagEventBatch(badEvents);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBe(badEvents.length);
  });

  it('allows confirm events with explicit txMetricMissing=true', () => {
    const ev = {
      tMs: Date.now(),
      kind: 'postMomentumFlow',
      stage: 'confirm',
      outcome: 'rejected',
      txMetricMissing: true,
      liq: 48_000,
      mcap: 280_000,
      tx1m: null,
      tx5mAvg: null,
    };
    const r = validateDiagEventNumericIntegrity(ev);
    expect(r.ok).toBe(true);
  });
});
