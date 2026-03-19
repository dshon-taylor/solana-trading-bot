import { describe, it, expect } from 'vitest';
import { makeCounters, formatThroughputSummary, buildRejectBuckets, bumpSourceCounter } from '../src/metrics.mjs';

describe('metrics throughput summary', () => {
  it('formats hourly-rate style throughput output with required fields', () => {
    const c = makeCounters();
    c.lastFlushAt = Date.now() - 30 * 60_000; // 0.5h
    c.scanCycles = 12;
    c.consideredPairs = 80;
    c.entryAttempts = 4;
    c.entrySuccesses = 1;
    c.reject.baseFilters = 22;
    c.reject.noPair = 10;
    c.reject.noPairReasons.rateLimited = 6;
    c.funnel.signals = 10;
    c.funnel.probeShortlist = 6;
    c.funnel.confirmPassed = 3;
    c.funnel.attempts = 2;
    c.funnel.fills = 1;
    c.retry.slippageRetryAttempted = 1;
    c.retry.slippageRetrySucceeded = 1;
    c.route.shortlistPrefilterDropped = 4;
    c.route.shortlistPrefilterPassed = 22;
    c.watchlist.evicted = 7;
    c.watchlist.ageEvicted = 3;
    c.watchlist.staleEvicted = 2;
    c.watchlist.ttlEvicted = 2;
    bumpSourceCounter(c, 'dex', 'seen');
    bumpSourceCounter(c, 'dex', 'seen');
    bumpSourceCounter(c, 'dex', 'rejects');
    bumpSourceCounter(c, 'dex', 'noPairRejects');

    const msg = formatThroughputSummary({ counters: c, title: 'diag' });
    expect(msg).toContain('scans/h:');
    expect(msg).toContain('candidates/h:');
    expect(msg).toContain('entries/h: attempts=');
    expect(msg).toContain('entries/min: attempts=');
    expect(msg).toContain('funnel: signal=');
    expect(msg).toContain('route: shortlistPrefilter drop/pass=');
    expect(msg).toContain('retry: slippage attempted=');
    expect(msg).toContain('watchlist: ingested=');
    expect(msg).toContain('(age=3 stale=2 ttl=2)');
    expect(msg).toContain('opportunities/day est:');
    expect(msg).toContain('• sources:');
    expect(msg).toContain('top rejects:');
  });

  it('includes noPair sub-reasons as reject buckets', () => {
    const buckets = buildRejectBuckets({
      noPair: 3,
      noPairReasons: {
        providerEmpty: 1,
        providerCooldown: 0,
        rateLimited: 2,
        routeNotFound: 0,
        nonTradableMint: 0,
        routeableNoMarketData: 0,
        staleData: 0,
        retriesExhausted: 0,
      },
      baseFilters: 4,
    });
    expect(buckets.find(([k]) => k === 'noPair.rateLimited')?.[1]).toBe(2);
    expect(buckets.find(([k]) => k === 'baseFilters')?.[1]).toBe(4);
  });
});
