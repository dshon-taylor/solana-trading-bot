import { describe, it, expect } from 'vitest';
import { evaluateTrackerIngestionHealth, formatTrackerIngestionSummary, trackerSamplingBreakdown } from '../src/tracker.mjs';

describe('tracker observability guardrail', () => {
  const cfg = {
    TRACK_SAMPLE_EVERY_MS: 60_000,
    TRACK_INGEST_WINDOW_MINUTES: 30,
    TRACK_INGEST_MIN_POINTS: 10,
    TRACK_INGEST_EXPECTED_FRACTION: 0.2,
  };

  it('flags critical when active jobs exist but zero recent writes', () => {
    const nowMs = Date.now();
    const state = {
      track: {
        active: { A: {}, B: {} },
        ingest: { recentWriteTimestamps: [], pointsLastHour: 0, pointsToday: 0 },
      },
    };
    const health = evaluateTrackerIngestionHealth({ cfg, state, nowMs });
    expect(health.severity).toBe('critical');
    expect(health.minExpected).toBeGreaterThan(0);
  });

  it('flags warning when recent writes are abnormally low', () => {
    const nowMs = Date.now();
    const state = {
      track: {
        active: { A: {}, B: {}, C: {} },
        ingest: {
          recentWriteTimestamps: [nowMs - 60_000, nowMs - 120_000],
          pointsLastHour: 2,
          pointsToday: 15,
        },
      },
    };
    const health = evaluateTrackerIngestionHealth({ cfg, state, nowMs });
    expect(health.severity).toBe('warning');
    expect(health.recentCount).toBe(2);
  });

  it('reports ok when no active trackers are running', () => {
    const nowMs = Date.now();
    const state = {
      track: {
        active: {},
        ingest: { recentWriteTimestamps: [], pointsLastHour: 0, pointsToday: 0 },
      },
    };
    const health = evaluateTrackerIngestionHealth({ cfg, state, nowMs });
    expect(health.severity).toBe('ok');
    expect(health.minExpected).toBe(0);
  });

  it('formats summary with explicit hour/day counters', () => {
    const nowMs = Date.now();
    const state = {
      track: {
        active: { A: {} },
        ingest: {
          recentWriteTimestamps: [nowMs - 20_000, nowMs - 40_000, nowMs - 80_000],
          pointsLastHour: 14,
          pointsToday: 123,
        },
      },
    };
    const msg = formatTrackerIngestionSummary({ cfg, state, nowMs });
    expect(msg).toContain('hour=14');
    expect(msg).toContain('day=123');
    expect(msg).toContain('tracker ingest:');
  });

  it('computes a last-hour sampling breakdown by resolved source', () => {
    const nowMs = Date.now();
    const state = {
      track: {
        ingest: {
          recentSamples: [
            { tMs: nowMs - 10_000, source: 'birdseye' },
            { tMs: nowMs - 20_000, source: 'jup' },
            { tMs: nowMs - 30_000, source: 'dex' },
            { tMs: nowMs - 40_000, source: 'last_good' },
            { tMs: nowMs - 50_000, source: 'entry_price' },
            { tMs: nowMs - (2 * 60 * 60_000), source: 'birdseye' },
          ],
        },
      },
    };

    const b = trackerSamplingBreakdown({ state, nowMs, windowMs: 60 * 60_000 });
    expect(b.total).toBe(5);
    expect(b.counts.birdseye).toBe(1);
    expect(b.counts.jup).toBe(1);
    expect(b.counts.dex).toBe(1);
    expect(b.counts.last_good).toBe(1);
    expect(b.counts.entry_price).toBe(1);
  });
});
