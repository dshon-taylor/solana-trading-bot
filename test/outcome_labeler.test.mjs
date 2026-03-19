import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOutcomeLabels, writeOutcomeLabels } from '../src/outcome_labeler.mjs';

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carl-labels-'));
}

describe('outcome_labeler', () => {
  it('enriches candidate seen events with tracked outcomes and writes durable files', () => {
    const root = mkTmpDir();
    const candidateDir = path.join(root, 'candidates');
    const trackDir = path.join(root, 'track');
    const outDir = path.join(root, 'out');

    fs.mkdirSync(candidateDir, { recursive: true });
    fs.mkdirSync(trackDir, { recursive: true });

    fs.writeFileSync(
      path.join(candidateDir, '2026-02-24.jsonl'),
      [
        JSON.stringify({ t: '2026-02-24T00:00:00.000Z', mint: 'M1', symbol: 'AAA', source: 'dex', priceUsd: 1, outcome: 'seen', reason: 'evaluated' }),
        JSON.stringify({ t: '2026-02-24T00:01:00.000Z', mint: 'M2', symbol: 'BBB', source: 'dex', priceUsd: 2, outcome: 'seen', reason: 'evaluated' }),
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(trackDir, 'results.jsonl'),
      [
        JSON.stringify({
          t: '2026-02-24T00:10:00.000Z',
          mint: 'M1',
          exitReason: 'trailingStop',
          horizonHours: 24,
          pnlPct: 0.15,
          maxRunupPct: 0.22,
          maxDrawdownPct: -0.03,
          entryPrice: 1,
          exitPrice: 1.15,
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const labels = buildOutcomeLabels({ candidateDir, trackDir, paperTradesPath: path.join(root, 'missing_paper.jsonl') });
    expect(labels).toHaveLength(2);
    expect(labels[0].mint).toBe('M1');
    expect(labels[0].outcomeClass).toBe('win');
    expect(labels[0].mfePct).toBeCloseTo(0.22, 6);
    expect(labels[0].maePct).toBeCloseTo(-0.03, 6);
    expect(labels[0].exitReason).toBe('trailingStop');

    expect(labels[1].mint).toBe('M2');
    expect(labels[1].outcomeClass).toBe('unknown');
    expect(labels[1].hasOutcome).toBe(false);

    const writeRes = writeOutcomeLabels({ outDir, labels });
    expect(fs.existsSync(writeRes.jsonlPath)).toBe(true);
    expect(fs.existsSync(writeRes.summaryPath)).toBe(true);
    expect(writeRes.summary.total).toBe(2);
    expect(writeRes.summary.withOutcome).toBe(1);
  });
});
