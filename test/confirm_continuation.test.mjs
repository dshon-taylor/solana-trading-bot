import { describe, it, expect } from 'vitest';
import { confirmContinuationGate } from '../src/lib/confirm_continuation.mjs';

class FakeCache {
  constructor({ wsSeq = [], fallbackPrice = 0 } = {}) {
    this.map = new Map();
    this.wsSeq = Array.isArray(wsSeq) ? wsSeq.slice() : [];
    this.fallbackPrice = fallbackPrice;
    this.setCalls = [];
    this.getCalls = [];
  }

  set(key, value, ttlSec) {
    this.setCalls.push({ key, value, ttlSec });
    this.map.set(key, value);
  }

  get(key) {
    this.getCalls.push(key);
    if (String(key).startsWith('birdeye:ws:price:')) {
      if (this.wsSeq.length > 0) {
        const next = this.wsSeq.shift();
        return typeof next === 'function' ? next() : next;
      }
      return null;
    }
    return this.map.get(key) ?? null;
  }
}

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    nowFn: () => now,
    sleepFn: async (ms) => { now += Number(ms || 0); },
    advance: (ms) => { now += Number(ms || 0); },
  };
}

describe('confirmContinuationGate', () => {
  it('subscribes to BirdEye WS and passes on runup inside window', async () => {
    const clock = makeClock();
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: clock.nowFn() },
        { priceUsd: 1.001, tsMs: clock.nowFn() + 100 },
        { priceUsd: 1.018, tsMs: clock.nowFn() + 220 },
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintA',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: cache,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      tuning: {
        active: true,
        windowMs: 1_500,
        passPct: 0.015,
        hardFailDipPct: 0.015,
        wsFreshMs: 10_000,
        sleepMs: 100,
        subRefreshMs: 300,
      },
    });

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('continuation');
    expect(res.passReason).toBe('runup');

    const subCalls = cache.setCalls.filter((c) => c.key === 'birdeye:sub:MintA');
    expect(subCalls.length).toBeGreaterThan(0);
    expect(subCalls[0].ttlSec).toBeGreaterThanOrEqual(30);

    const wsReads = cache.getCalls.filter((k) => k === 'birdeye:ws:price:MintA').length;
    expect(wsReads).toBeGreaterThan(1);
    expect(Number(res?.diag?.wsObservedTicks || 0)).toBeGreaterThan(0);
  });

  it('fails hardDip when price drops inside window', async () => {
    const clock = makeClock();
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: clock.nowFn() },
        { priceUsd: 0.98, tsMs: clock.nowFn() + 100 },
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintDip',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: cache,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      tuning: {
        active: true,
        windowMs: 1_500,
        passPct: 0.015,
        hardFailDipPct: 0.015,
        wsFreshMs: 10_000,
        sleepMs: 100,
        subRefreshMs: 300,
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failReason).toBe('hardDip');
    expect(Number(res?.diag?.maxDipPctWithinConfirm || 0)).toBeGreaterThanOrEqual(0.015);
  });

  it('returns windowExpiredStall when no runup and flat/negative close', async () => {
    const clock = makeClock();
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: clock.nowFn() },
        { priceUsd: 0.999, tsMs: clock.nowFn() + 120 },
        { priceUsd: 1.0, tsMs: clock.nowFn() + 240 },
        { priceUsd: 0.9995, tsMs: clock.nowFn() + 360 },
        { priceUsd: 0.9995, tsMs: clock.nowFn() + 480 },
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintFlat',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: cache,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      tuning: {
        active: true,
        windowMs: 500,
        passPct: 0.015,
        hardFailDipPct: 0.15,
        wsFreshMs: 10_000,
        sleepMs: 100,
        subRefreshMs: 200,
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failReason).toBe('windowExpiredStall');
    expect(res?.diag?.timeoutWasFlatOrNegative).toBe(true);
    expect(Number(res?.diag?.wsReads || 0)).toBeGreaterThan(1);
  });

  it('falls back to snapshot when WS tick is stale but still watches WS key', async () => {
    const clock = makeClock(2_000_000);
    const staleTs = clock.nowFn() - 60_000;
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: staleTs },
        { priceUsd: 1.0, tsMs: staleTs },
        { priceUsd: 1.0, tsMs: staleTs },
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintStale',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.02, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.02, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: cache,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      tuning: {
        active: true,
        windowMs: 300,
        passPct: 0.015,
        hardFailDipPct: 0.2,
        wsFreshMs: 1_000,
        sleepMs: 100,
        subRefreshMs: 100,
      },
    });

    expect(res.ok).toBe(false);
    expect(String(res.failReason || '')).toMatch(/windowExpired/);
    expect(Number(res?.diag?.snapshotReads || 0)).toBeGreaterThan(0);

    const wsReads = cache.getCalls.filter((k) => k === 'birdeye:ws:price:MintStale').length;
    expect(wsReads).toBeGreaterThan(1);
  });
});
