import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendTrackSample, buildTrackSampleRow } from '../src/trading/tracker.mjs';

describe('tracker sample serialization', () => {
  it('falls back to entry price when live source is missing', () => {
    const row = buildTrackSampleRow({
      tMs: Date.parse('2026-02-25T00:00:00Z'),
      mint: 'mintA',
      symbol: 'AAA',
      entryPrice: 0.42,
      priceUsd: null,
      source: 'rate_limited',
      lastGoodPrice: null,
    });

    expect(row).toMatchObject({
      mint: 'mintA',
      symbol: 'AAA',
      entryPrice: 0.42,
      priceUsd: 0.42,
      source: 'entry_price',
    });
    expect(row.t).toBe('2026-02-25T00:00:00.000Z');
  });

  it('prefers last known good price for continuity', () => {
    const row = buildTrackSampleRow({
      tMs: 1,
      mint: 'mintB',
      entryPrice: 1,
      priceUsd: null,
      source: 'none',
      lastGoodPrice: 1.25,
    });

    expect(row.priceUsd).toBe(1.25);
    expect(row.source).toBe('last_good');
  });

  it('rejects malformed/empty rows and only writes valid points', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
    const fp = path.join(tmp, 'track.jsonl');

    expect(appendTrackSample(fp, null)).toBe(false);
    expect(appendTrackSample(fp, { t: 'x', mint: 'm', priceUsd: 0 })).toBe(false);

    const valid = buildTrackSampleRow({
      tMs: 2,
      mint: 'mintC',
      entryPrice: 0.5,
      priceUsd: 0.55,
      source: 'jup',
    });
    expect(appendTrackSample(fp, valid)).toBe(true);

    const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.priceUsd).toBe(0.55);
  });
});
