import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  appendDiagEvent,
  buildCompactWindowFromDiagEvents,
  getCompactWindowForDiagRequest,
  getDiagEventsPath,
  getDiagFamilyEventsPath,
  readRecentDiagEvents,
} from '../src/control_tower/diag_reporting/diag_event_store.mjs';

function withTmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-store-'));
  return path.join(dir, 'state.json');
}

describe('diag event store', () => {
  it('appends only persistable kinds and replays them', () => {
    const statePath = withTmpStatePath();
    const canonicalPath = getDiagEventsPath(statePath);
    const written = [];
    const appendJsonl = (fp, obj) => {
      written.push({ fp, obj });
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
    };

    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 1000, kind: 'momentumRecent', extra: { mint: 'A' } } });
    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 2000, kind: 'watchlistSeen', extra: { mint: 'B' } } });

    const canonicalWrites = written.filter((w) => w.fp === canonicalPath);
    expect(canonicalWrites.length).toBe(1);
    expect(canonicalWrites[0].obj.kind).toBe('momentumRecent');

    const events = readRecentDiagEvents({ statePath, nowMs: 3000, windowStartMs: 0, retainMs: 10_000, replayMaxLines: 100 });
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe('momentumRecent');
  });

  it('writes family mirror logs and supports mode-scoped reads', () => {
    const statePath = withTmpStatePath();
    const appendJsonl = (fp, obj) => {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
    };

    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 1000, kind: 'momentumRecent', extra: { mint: 'A' } } });
    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 2000, kind: 'candidateSeen', extra: { mint: 'B' } } });

    const familyPath = getDiagFamilyEventsPath(statePath, 'momentum');
    expect(fs.existsSync(familyPath)).toBe(true);

    const momentumRows = readRecentDiagEvents({
      statePath,
      nowMs: 3000,
      windowStartMs: 0,
      retainMs: 10_000,
      replayMaxLines: 100,
      mode: 'momentum',
      preferFamilyLogs: true,
    });
    expect(momentumRows.length).toBeGreaterThanOrEqual(1);
    expect(momentumRows.some((x) => x.kind === 'momentumRecent')).toBe(true);
  });

  it('builds compact window buckets from replayed events', () => {
    const events = [
      { tMs: 1000, kind: 'momentumRecent', extra: { mint: 'mintA', final: 'momentum.passed' } },
      { tMs: 2000, kind: 'candidateSeen', extra: { mint: 'mintA', source: 'trending' } },
      { tMs: 3000, kind: 'scanCycle', extra: { durationMs: 1200 } },
      { tMs: 4000, kind: 'momentumEval', extra: null },
    ];

    const cw = buildCompactWindowFromDiagEvents({ events, cutoffMs: 0 });
    expect(Array.isArray(cw.momentumRecent)).toBe(true);
    expect(cw.momentumRecent.length).toBe(1);
    expect(cw.momentumRecent[0].mint).toBe('mintA');
    expect(cw.candidateSeen.length).toBe(1);
    expect(cw.scanCycles.length).toBe(1);
    expect(cw.momentumEval.length).toBe(1);
  });

  it('builds compact window directly for diag request', () => {
    const statePath = withTmpStatePath();
    const appendJsonl = (fp, obj) => {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
    };

    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 10_000, kind: 'momentumRecent', extra: { mint: 'M1', final: 'momentum.passed' } } });
    appendDiagEvent({ appendJsonl, statePath, event: { tMs: 12_000, kind: 'momentumEval', extra: null } });

    const cw = getCompactWindowForDiagRequest({
      statePath,
      mode: 'momentum',
      nowMs: 15_000,
      windowStartMs: 0,
      retainMs: 100_000,
      replayMaxLines: 100,
    });
    expect(Array.isArray(cw.momentumRecent)).toBe(true);
    expect(cw.momentumRecent.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(cw.momentumEval)).toBe(true);
  });

  it('resolves diag events file path from state path', () => {
    const p = getDiagEventsPath('/tmp/my-bot/state/state.json');
    expect(p.endsWith('/tmp/my-bot/state/diag_events.jsonl')).toBe(true);
  });
});
