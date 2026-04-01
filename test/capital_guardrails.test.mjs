import { describe, it, expect } from 'vitest';
import {
  ensureCapitalGuardrailsState,
  canOpenNewEntry,
  recordEntryOpened,
  applySoftReserveToUsdTarget,
} from '../src/trading/capital_guardrails.mjs';

describe('capital guardrails', () => {
  it('enforces optional max-new-entries-per-hour throttle', () => {
    const state = {};
    ensureCapitalGuardrailsState(state);
    const now = Date.now();

    recordEntryOpened({ state, nowMs: now - 10_000 });
    recordEntryOpened({ state, nowMs: now - 20_000 });

    const blocked = canOpenNewEntry({ state, nowMs: now, maxNewEntriesPerHour: 2 });
    expect(blocked.ok).toBe(false);

    const allowedWhenDisabled = canOpenNewEntry({ state, nowMs: now, maxNewEntriesPerHour: 0 });
    expect(allowedWhenDisabled.ok).toBe(true);
  });

  it('caps usd target using fee reserve + soft reserve + retry buffer', () => {
    const out = applySoftReserveToUsdTarget({
      solBalance: 1,
      solUsd: 100,
      usdTarget: 80,
      minSolForFees: 0.06,
      softReserveSol: 0.10,
      retryBufferPct: 0.10,
    });

    expect(out.ok).toBe(true);
    expect(out.reason).toBe('soft_reserve_capped');
    expect(out.adjustedUsdTarget).toBeCloseTo(76, 3); // spendable SOL = 1 - (0.06 + 0.1 + 0.08)
  });
});
