import { describe, it, expect } from 'vitest';
import { promoteRouteAvailableCandidateToImmediate } from '../src/route_available_watchlist.mjs';

describe('routeAvailable watchlist immediate promotion', () => {
  it('promotes routeAvailable candidate into immediate rows for same-cycle evaluation', () => {
    const immediateRows = [];
    const immediateRowMints = new Set();
    const row = { mint: 'MINT1', lastImmediateEvalAtMs: 0 };

    const res = promoteRouteAvailableCandidateToImmediate({
      mint: 'MINT1',
      row,
      nowMs: 1_000,
      dedupMs: 500,
      immediateRows,
      immediateRowMints,
    });

    expect(res.promoted).toBe(true);
    expect(immediateRows).toHaveLength(1);
    expect(immediateRows[0][0]).toBe('MINT1');
    expect(immediateRows[0][1]).toBe(row);
    expect(immediateRows[0][2]).toBe(true);
    expect(immediateRowMints.has('MINT1')).toBe(true);
    expect(row.lastImmediateEvalAtMs).toBe(1_000);
  });

  it('drops candidate when dedup window is active', () => {
    const immediateRows = [];
    const immediateRowMints = new Set();
    const row = { mint: 'MINT1', lastImmediateEvalAtMs: 900 };

    const res = promoteRouteAvailableCandidateToImmediate({
      mint: 'MINT1',
      row,
      nowMs: 1_000,
      dedupMs: 200,
      immediateRows,
      immediateRowMints,
    });

    expect(res.promoted).toBe(false);
    expect(res.reason).toBe('immediateDedup');
    expect(immediateRows).toHaveLength(0);
  });
});
