import fs from 'node:fs';
import path from 'node:path';

const PRICES = {
  'gpt-5.2': { in: 1.75, out: 14.0 },
  'gpt-5.2-pro': { in: 21.0, out: 168.0 },
  'gpt-5-mini': { in: 0.25, out: 2.0 },
  'gpt-4.1': { in: 3.0, out: 12.0 },
  'gpt-4.1-mini': { in: 0.8, out: 3.2 },
  'gpt-4.1-nano': { in: 0.2, out: 0.8 },
};

export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0 }) {
  const m = PRICES[model];
  if (!m) return null;
  return (inputTokens / 1e6) * m.in + (outputTokens / 1e6) * m.out;
}

export function appendCost({ ledgerPath, event }) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
}

export function parseRange(arg) {
  const a = String(arg || '24h').trim().toLowerCase();
  if (a === 'last') return { kind: 'last' };
  const m = a.match(/^([0-9]+)\s*(h|d)$/);
  if (!m) return { kind: 'hours', n: 24 };
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'h') return { kind: 'hours', n };
  return { kind: 'days', n };
}

export function readLedger(ledgerPath) {
  try {
    const txt = fs.readFileSync(ledgerPath, 'utf8');
    return txt.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function summarize(events, range) {
  if (!events.length) return { events: 0, cost: 0, byModel: {}, byOp: {} };
  let filtered = events;
  if (range.kind === 'last') {
    filtered = [events[events.length - 1]];
  } else {
    const ms = range.kind === 'days' ? range.n * 24 * 3600 * 1000 : range.n * 3600 * 1000;
    const cutoff = Date.now() - ms;
    filtered = events.filter(e => new Date(e.t).valueOf() >= cutoff);
  }

  const byModel = {};
  const byOp = {};
  let cost = 0;
  for (const e of filtered) {
    const c = Number(e.costUsd || 0);
    cost += c;
    byModel[e.model] = (byModel[e.model] || 0) + c;
    byOp[e.op] = (byOp[e.op] || 0) + c;
  }
  return { events: filtered.length, cost, byModel, byOp };
}
