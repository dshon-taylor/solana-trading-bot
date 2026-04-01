import { describe, it, expect } from 'vitest';
import {
  isMicroFreshEnough,
  applyMomentumPassHysteresis,
  getCachedMintCreatedAt,
  scheduleMintCreatedAtLookup,
} from '../src/signals/momentum_gate_controls.mjs';

describe('momentum_gate_controls', () => {
  describe('isMicroFreshEnough', () => {
    it('passes when freshness gate disabled', () => {
      const r = isMicroFreshEnough({
        microPresentCount: 5,
        freshnessMs: 999999,
        maxAgeMs: 1000,
        requireFreshMicro: false,
      });
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('freshnessGateDisabled');
    });

    it('passes when too few micro fields to enforce gate', () => {
      const r = isMicroFreshEnough({
        microPresentCount: 2,
        freshnessMs: 999999,
        maxAgeMs: 1000,
        requireFreshMicro: true,
        minPresentForGate: 3,
      });
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('insufficientMicroFieldsForGate');
    });

    it('fails when freshness missing and gate applies', () => {
      const r = isMicroFreshEnough({
        microPresentCount: 4,
        freshnessMs: NaN,
        maxAgeMs: 1000,
        requireFreshMicro: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('microFreshnessMissing');
    });

    it('fails when micro is stale', () => {
      const r = isMicroFreshEnough({
        microPresentCount: 4,
        freshnessMs: 15001,
        maxAgeMs: 10000,
        requireFreshMicro: true,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('microStale');
    });

    it('passes when micro is fresh', () => {
      const r = isMicroFreshEnough({
        microPresentCount: 4,
        freshnessMs: 2500,
        maxAgeMs: 10000,
        requireFreshMicro: true,
      });
      expect(r.ok).toBe(true);
      expect(r.reason).toBe('microFresh');
    });
  });

  describe('applyMomentumPassHysteresis', () => {
    it('requires streak warmup before passing when requiredStreak=2', () => {
      const state = { runtime: {} };
      const first = applyMomentumPassHysteresis({
        state,
        mint: 'A',
        nowMs: 1000,
        gatePassed: true,
        requiredStreak: 2,
      });
      expect(first.passed).toBe(false);
      expect(first.warmup).toBe(true);
      expect(first.streak).toBe(1);

      const second = applyMomentumPassHysteresis({
        state,
        mint: 'A',
        nowMs: 2000,
        gatePassed: true,
        requiredStreak: 2,
      });
      expect(second.passed).toBe(true);
      expect(second.warmup).toBe(false);
      expect(second.streak).toBe(2);
    });

    it('resets streak on fail', () => {
      const state = { runtime: {} };
      applyMomentumPassHysteresis({ state, mint: 'A', nowMs: 1000, gatePassed: true, requiredStreak: 2 });
      const r = applyMomentumPassHysteresis({ state, mint: 'A', nowMs: 2000, gatePassed: false, requiredStreak: 2 });
      expect(r.passed).toBe(false);
      expect(r.streak).toBe(0);
    });

    it('resets stale streak after reset window', () => {
      const state = { runtime: {} };
      applyMomentumPassHysteresis({ state, mint: 'A', nowMs: 1000, gatePassed: true, requiredStreak: 3, streakResetMs: 2000 });
      const r = applyMomentumPassHysteresis({ state, mint: 'A', nowMs: 32_500, gatePassed: true, requiredStreak: 3, streakResetMs: 2000 });
      expect(r.streak).toBe(1);
      expect(r.warmup).toBe(true);
      expect(r.passed).toBe(false);
    });
  });

  describe('mint age cache + scheduling', () => {
    it('returns cached mint created-at when fresh', () => {
      const state = {
        runtime: {
          mintCreatedAtCache: {
            MINT: { createdAtMs: 12345, checkedAtMs: 1_000_000, source: 'rpc' },
          },
        },
      };
      const r = getCachedMintCreatedAt({ state, mint: 'MINT', nowMs: 1_010_000, maxAgeMs: 60_000 });
      expect(r).toEqual({ createdAtMs: 12345, source: 'rpc' });
    });

    it('schedules lookup only once while in-flight', async () => {
      const state = { runtime: {} };
      let calls = 0;
      const lookupFn = async () => {
        calls += 1;
      };

      const first = scheduleMintCreatedAtLookup({ state, mint: 'MINT', nowMs: 1000, minRetryMs: 30000, lookupFn });
      const second = scheduleMintCreatedAtLookup({ state, mint: 'MINT', nowMs: 1001, minRetryMs: 30000, lookupFn });

      expect(first).toBe(true);
      expect(second).toBe(false);

      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toBe(1);
    });
  });
});
