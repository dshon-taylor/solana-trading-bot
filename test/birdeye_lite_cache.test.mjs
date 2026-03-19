import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBirdseyeLiteClient } from '../src/birdeye_lite.mjs';

function makeFetchMock() {
  const fn = vi.fn(async () => ({
    data: {
      price: 1.23,
      liquidityUsd: 4567,
      v24hUSD: 12,
      updatedAt: Date.now(),
      buy24h: 1,
      sell24h: 2,
    },
  }));
  return fn;
}

describe('birdeye_lite cache + per-mint min interval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-26T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached snapshot within TTL (no extra fetch)', async () => {
    const fetchJson = makeFetchMock();
    const client = createBirdseyeLiteClient({
      enabled: true,
      apiKey: 'k',
      cacheTtlMs: 30_000,
      perMintMinIntervalMs: 15_000,
      maxRps: 100000,
      fetchJson,
    });

    const p1 = client.getTokenSnapshot('mint1');
    await vi.advanceTimersByTimeAsync(1);
    const s1 = await p1;

    const p2 = client.getTokenSnapshot('mint1');
    const s2 = await p2;

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(s2?.priceUsd).toBe(s1?.priceUsd);

    const st = client.getStats(Date.now());
    expect(st.cacheHits).toBe(1);
    expect(st.cacheMisses).toBe(1);
    expect(st.fetches).toBe(1);
  });

  it('returns cached snapshot when stale but within per-mint min interval (suppresses refetch)', async () => {
    const fetchJson = makeFetchMock();
    const client = createBirdseyeLiteClient({
      enabled: true,
      apiKey: 'k',
      cacheTtlMs: 50,
      perMintMinIntervalMs: 200,
      maxRps: 100000,
      fetchJson,
    });

    const p1 = client.getTokenSnapshot('mint2');
    await vi.advanceTimersByTimeAsync(1);
    const s1 = await p1;

    // Let TTL expire, but still inside per-mint min interval window
    await vi.advanceTimersByTimeAsync(100);

    const s2 = await client.getTokenSnapshot('mint2');

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(s2?.priceUsd).toBe(s1?.priceUsd);

    const st = client.getStats(Date.now());
    expect(st.cacheHits).toBe(1);
    expect(st.cacheMisses).toBe(1);
    expect(st.fetches).toBe(1);
  });

  it('refetches after per-mint min interval when TTL expired', async () => {
    const fetchJson = makeFetchMock();
    const client = createBirdseyeLiteClient({
      enabled: true,
      apiKey: 'k',
      cacheTtlMs: 10,
      perMintMinIntervalMs: 20,
      maxRps: 100000,
      fetchJson,
    });

    const p1 = client.getTokenSnapshot('mint3');
    await vi.advanceTimersByTimeAsync(1);
    await p1;

    await vi.advanceTimersByTimeAsync(25); // past TTL and per-mint min interval

    const p2 = client.getTokenSnapshot('mint3');
    await vi.advanceTimersByTimeAsync(1);
    await p2;

    expect(fetchJson).toHaveBeenCalledTimes(2);

    const st = client.getStats(Date.now());
    expect(st.cacheMisses).toBe(2);
    expect(st.fetches).toBe(2);
  });
});
