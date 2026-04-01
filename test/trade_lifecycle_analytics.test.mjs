import { describe, expect, it } from 'vitest';

import {
  entryQualityBucket,
  holdTimeBucket,
  slippageBucket,
  summarizeTradeLifecycle,
} from '../src/analytics/trade_lifecycle_analytics.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('trade_lifecycle_analytics buckets', () => {
  it('bucketizes hold durations', () => {
    expect(holdTimeBucket(2 * 60_000)).toBe('<5m');
    expect(holdTimeBucket(10 * 60_000)).toBe('5-15m');
    expect(holdTimeBucket(30 * 60_000)).toBe('15-60m');
    expect(holdTimeBucket(2 * 60 * 60_000)).toBe('1-4h');
  });

  it('bucketizes entry quality from paper and live features', () => {
    expect(entryQualityBucket({ paperEntrySignal: { ret15: 0.13, ret5: 0.09, greensLast5: 4 } })).toBe('elite');
    expect(entryQualityBucket({ signal: { pc1h: 12, buyDominant: true, txRising: true } })).toBe('strong');
    expect(entryQualityBucket({})).toBe('weak');
  });

  it('bucketizes slippage explicit and proxy', () => {
    expect(slippageBucket({ slippageBps: 60 })).toBe('tight(<=75bps)');
    expect(slippageBucket({ paperEntrySignal: { ret15: 0.2 } })).toBe('proxy:high-vol(15-30%)');
  });
});

describe('trade_lifecycle_analytics aggregate', () => {
  it('aggregates paper + live closed trades', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
    const paperPath = path.join(dir, 'paper.jsonl');
    const statePath = path.join(dir, 'state.json');

    fs.writeFileSync(paperPath, [
      JSON.stringify({ t: '2026-02-24T10:00:00.000Z', type: 'entry', mint: 'A', ret15: 0.12, ret5: 0.08, greensLast5: 4 }),
      JSON.stringify({ t: '2026-02-24T10:15:00.000Z', mint: 'A', entryT: '2026-02-24T10:00:00.000Z', exitT: '2026-02-24T10:15:00.000Z', exitReason: 'trailingStop', pnlPct: 0.2 }),
    ].join('\n'));

    fs.writeFileSync(statePath, JSON.stringify({
      positions: {
        B: {
          status: 'closed',
          mint: 'B',
          symbol: 'BBB',
          entryAt: '2026-02-24T11:00:00.000Z',
          exitAt: '2026-02-24T11:06:00.000Z',
          pnlPct: -0.04,
          exitReason: 'stop_loss',
          signal: { pc1h: 6, buyDominant: false },
        },
      },
    }, null, 2));

    const out = summarizeTradeLifecycle({ paperTradesPath: paperPath, statePath });
    expect(out.totals.trades).toBe(2);
    expect(out.breakdown.exitReason.find((r) => r.bucket === 'trailingStop')?.trades).toBe(1);
    expect(out.breakdown.holdTime.find((r) => r.bucket === '5-15m')?.trades).toBe(2);
  });
});
