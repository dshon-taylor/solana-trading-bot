import { describe, it, expect } from 'vitest';
import { confirmContinuationGate } from '../src/lib/confirm_continuation.mjs';

class FakeCache {
  constructor({ wsSeq = [], txSeq = [] } = {}) {
    this.map = new Map();
    this.wsSeq = Array.isArray(wsSeq) ? wsSeq.slice() : [];
    this.txSeq = Array.isArray(txSeq) ? txSeq.slice() : [];
    this.setCalls = [];
    this.getCalls = [];
  }

  set(key, value, ttlSec) {
    this.setCalls.push({ key, value, ttlSec });
    this.map.set(key, value);
  }

  get(key) {
    this.getCalls.push(key);
    const k = String(key);
    if (k.startsWith('birdeye:ws:price:')) {
      if (this.wsSeq.length > 0) {
        const next = this.wsSeq.shift();
        return typeof next === 'function' ? next() : next;
      }
      return null;
    }
    if (k.startsWith('birdeye:ws:tx:')) {
      if (this.txSeq.length > 0) {
        const next = this.txSeq.shift();
        return typeof next === 'function' ? next() : next;
      }
      return this.map.get(k) ?? [];
    }
    return this.map.get(k) ?? null;
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
    expect(String(res.failReason || '')).toMatch(/windowExpired|dataUnavailable/);
    expect(Number(res?.diag?.snapshotReads || 0)).toBeGreaterThan(0);

    const wsReads = cache.getCalls.filter((k) => k === 'birdeye:ws:price:MintStale').length;
    expect(wsReads).toBeGreaterThan(1);
  });

  it('uses trade-derived prices and captures trade diagnostics within a 15s window', async () => {
    const clock = makeClock(3_000_000);
    const t0 = clock.nowFn();
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: t0 - 60_000 },
        { priceUsd: 1.0, tsMs: t0 - 60_000 },
        { priceUsd: 1.0, tsMs: t0 - 60_000 },
      ],
      txSeq: [
        [{ t: t0 + 1_000, priceUsd: 1.000, side: 'buy' }],
        [{ t: t0 + 1_000, priceUsd: 1.000, side: 'buy' }, { t: t0 + 4_000, priceUsd: 1.008, side: 'buy' }],
        [{ t: t0 + 1_000, priceUsd: 1.000, side: 'buy' }, { t: t0 + 4_000, priceUsd: 1.008, side: 'buy' }, { t: t0 + 8_000, priceUsd: 1.016, side: 'buy' }],
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintTrade',
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
        windowMs: 15_000,
        passPct: 0.015,
        hardFailDipPct: 0.02,
        wsFreshMs: 15_000,
        sleepMs: 1_000,
        subRefreshMs: 300,
      },
    });

    expect(res.ok).toBe(true);
    expect(res.passReason).toBe('runup');
    expect(res.diag.priceSource).toBe('ws_trade');
    expect(Number(res.diag.selectedTradeReads || 0)).toBeGreaterThan(0);
    expect(Array.isArray(res.diag.tradeUpdateTimestamps)).toBe(true);
    expect(Array.isArray(res.diag.tradeUpdatePrices)).toBe(true);
    expect(res.diag.tradeUpdateTimestamps.length).toBeGreaterThan(0);
    expect(res.diag.tradeUpdatePrices.length).toBeGreaterThan(0);

    const withinWindow = res.diag.tradeUpdateTimestamps.every((ts) => Number(ts) - Number(res.diag.confirmStartedAtMs) <= 15_000);
    expect(withinWindow).toBe(true);
    expect(Number(res.diag.maxRunupPctWithinConfirm || 0)).toBeGreaterThanOrEqual(0.015);
  });

  it('requires consecutive trade upticks when enabled', async () => {
    const clock = makeClock(6_000_000);
    const t0 = clock.nowFn();
    const cache = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: t0 - 60_000 },
        { priceUsd: 1.0, tsMs: t0 - 60_000 },
      ],
      txSeq: [
        [{ t: t0 + 100, priceUsd: 1.0, side: 'buy' }],
        [{ t: t0 + 100, priceUsd: 1.0, side: 'buy' }, { t: t0 + 500, priceUsd: 1.016, side: 'buy' }],
      ],
    });

    const res = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintTrendNeed',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: cache,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
      tuning: { active: true, windowMs: 1_000, passPct: 0.015, hardFailDipPct: 0.2, wsFreshMs: 15_000, sleepMs: 250, subRefreshMs: 200, requireTradeUpticks: true, minConsecutiveTradeUpticks: 2 },
    });

    expect(res.ok).toBe(false);
    expect(res.failReason).toBe('runupNoTradeTrendConfirm');
    expect(Number(res.diag.maxConsecutiveTradeUpticks || 0)).toBeLessThan(2);
  });

  it('shows trade feed detects burst where flat OHLCV stalls', async () => {
    const clockA = makeClock(4_000_000);
    const flatOhlcv = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: clockA.nowFn() + 100 },
        { priceUsd: 1.0, tsMs: clockA.nowFn() + 200 },
        { priceUsd: 1.0, tsMs: clockA.nowFn() + 300 },
      ],
      txSeq: [[], [], []],
    });

    const withoutTrade = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintCompare',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: flatOhlcv,
      nowFn: clockA.nowFn,
      sleepFn: clockA.sleepFn,
      tuning: { active: true, windowMs: 1_000, passPct: 0.015, hardFailDipPct: 0.2, wsFreshMs: 15_000, sleepMs: 250, subRefreshMs: 200 },
    });

    const clockB = makeClock(5_000_000);
    const withTradeFeed = new FakeCache({
      wsSeq: [
        { priceUsd: 1.0, tsMs: clockB.nowFn() + 100 },
        { priceUsd: 1.0, tsMs: clockB.nowFn() + 200 },
      ],
      txSeq: [
        [{ t: clockB.nowFn() + 100, priceUsd: 1.0, side: 'buy' }],
        [{ t: clockB.nowFn() + 100, priceUsd: 1.0, side: 'buy' }, { t: clockB.nowFn() + 500, priceUsd: 1.017, side: 'buy' }],
      ],
    });

    const withTrade = await confirmContinuationGate({
      cfg: { EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT: 3 },
      mint: 'MintCompare',
      row: { latest: { liqUsd: 100_000, priceUsd: 1.0 } },
      snapshot: { priceUsd: 1.0, liquidityUsd: 100_000 },
      pair: { priceUsd: 1.0, liquidity: { usd: 100_000 } },
      confirmPriceImpactPct: 0.5,
      confirmStartLiqUsd: 100_000,
      cacheImpl: withTradeFeed,
      nowFn: clockB.nowFn,
      sleepFn: clockB.sleepFn,
      tuning: { active: true, windowMs: 1_000, passPct: 0.015, hardFailDipPct: 0.2, wsFreshMs: 15_000, sleepMs: 250, subRefreshMs: 200 },
    });

    expect(withoutTrade.ok).toBe(false);
    expect(String(withoutTrade.failReason)).toMatch(/windowExpired/);
    expect(withTrade.ok).toBe(true);
    expect(withTrade.passReason).toBe('runup');
    expect(withTrade.diag.priceSource).toBe('ws_trade');
  });
});
