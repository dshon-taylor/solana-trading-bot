import { describe, it, expect } from 'vitest';
import { applyOnchainBalanceToPosition } from '../src/reconcile_positions.mjs';

function mkPos(overrides = {}) {
  return {
    status: 'open',
    entryAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10m ago
    entryPrice: 1.0,
    ...overrides,
  };
}

describe('reconcile_positions', () => {
  it('debounces transient zero balances before marking closed', () => {
    const pos = mkPos();
    const t0 = Date.now();

    for (let i = 0; i < 2; i++) {
      applyOnchainBalanceToPosition({
        pos,
        bal: { amount: 0, fetchOk: true, source: 'test' },
        nowMs: t0 + i * 60_000,
        nowIso: new Date(t0 + i * 60_000).toISOString(),
      });
      expect(pos.status).toBe('open');
    }

    // Third consecutive zero closes.
    applyOnchainBalanceToPosition({
      pos,
      bal: { amount: 0, fetchOk: true, source: 'test' },
      nowMs: t0 + 2 * 60_000,
      nowIso: new Date(t0 + 2 * 60_000).toISOString(),
    });

    expect(pos.status).toBe('closed');
    expect(pos.exitReason).toMatch(/onchain token balance=0/);
  });

  it('reopens a position if on-chain balance becomes non-zero again', () => {
    const pos = mkPos({ status: 'closed', exitAt: new Date().toISOString(), exitReason: 'x', exitTx: 'y', _zeroBalCount: 3 });
    const t = Date.now();

    applyOnchainBalanceToPosition({
      pos,
      bal: { amount: 123, fetchOk: true, source: 'test' },
      nowMs: t,
      nowIso: new Date(t).toISOString(),
    });

    expect(pos.status).toBe('open');
    expect(pos.exitAt).toBeUndefined();
    expect(pos.exitReason).toBeUndefined();
    expect(pos.exitTx).toBeUndefined();
    expect(pos._zeroBalCount).toBe(0);
  });
});
