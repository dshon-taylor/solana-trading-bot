import fs from 'node:fs';
import path from 'node:path';

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function readJsonl(filePath) {
  let txt = '';
  try {
    txt = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed row
    }
  }
  return out;
}

function listDailyJsonl(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(d.name))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

export function loadCandidateSeenEvents({ candidateDir = './state/candidates' } = {}) {
  const files = listDailyJsonl(candidateDir);
  const out = [];

  for (const fp of files) {
    for (const row of readJsonl(fp)) {
      if (row?.outcome !== 'seen') continue;
      const tMs = Date.parse(row?.t || '');
      out.push({
        t: row?.t || null,
        tMs: Number.isFinite(tMs) ? tMs : null,
        mint: row?.mint || null,
        symbol: row?.symbol || null,
        source: row?.source || null,
        priceUsd: toNum(row?.priceUsd),
        candidate: row,
      });
    }
  }

  return out
    .filter((r) => r.mint)
    .sort((a, b) => (a.tMs || 0) - (b.tMs || 0) || String(a.mint).localeCompare(String(b.mint)));
}

export function loadTrackedOutcomes({ trackDir = './state/track' } = {}) {
  const rows = readJsonl(path.join(trackDir, 'results.jsonl'));
  const byMint = new Map();
  for (const r of rows) {
    const mint = r?.mint;
    if (!mint) continue;
    const item = {
      outcomeType: 'tracked',
      t: r?.t || null,
      tMs: Number.isFinite(Date.parse(r?.t || '')) ? Date.parse(r?.t || '') : null,
      exitReason: r?.exitReason || null,
      horizonHours: toNum(r?.horizonHours),
      pnlPct: toNum(r?.pnlPct),
      maePct: toNum(r?.maxDrawdownPct),
      mfePct: toNum(r?.maxRunupPct),
      entryPrice: toNum(r?.entryPrice),
      exitPrice: toNum(r?.exitPrice),
      samples: toNum(r?.samples),
      raw: r,
    };
    const arr = byMint.get(mint) || [];
    arr.push(item);
    byMint.set(mint, arr);
  }

  for (const arr of byMint.values()) {
    arr.sort((a, b) => (a.tMs || 0) - (b.tMs || 0));
  }

  return byMint;
}

export function loadPaperOutcomes({ paperTradesPath = './state/paper_trades.jsonl' } = {}) {
  const rows = readJsonl(paperTradesPath);
  const exitsByMint = new Map();

  for (const r of rows) {
    if (r?.type === 'entry') continue;
    if (!r?.mint || !r?.exitReason) continue;

    const tMs = Date.parse(r?.t || r?.exitT || '');
    const item = {
      outcomeType: 'paper',
      t: r?.t || r?.exitT || null,
      tMs: Number.isFinite(tMs) ? tMs : null,
      exitReason: r?.exitReason || null,
      horizonHours: null,
      pnlPct: toNum(r?.pnlPct),
      maePct: null,
      mfePct: null,
      entryPrice: toNum(r?.entryPrice),
      exitPrice: toNum(r?.exitPrice),
      samples: null,
      raw: r,
    };

    const arr = exitsByMint.get(r.mint) || [];
    arr.push(item);
    exitsByMint.set(r.mint, arr);
  }

  for (const arr of exitsByMint.values()) {
    arr.sort((a, b) => (a.tMs || 0) - (b.tMs || 0));
  }

  return exitsByMint;
}

function classifyOutcome(pnlPct) {
  if (!Number.isFinite(pnlPct)) return 'unknown';
  if (pnlPct > 0) return 'win';
  if (pnlPct < 0) return 'loss';
  return 'neutral';
}

function pickFirstAfter(outcomes, tMs) {
  if (!Array.isArray(outcomes) || !outcomes.length) return null;
  if (!Number.isFinite(tMs)) return outcomes[0];
  for (const o of outcomes) {
    if (!Number.isFinite(o?.tMs)) continue;
    if (o.tMs >= tMs) return o;
  }
  return outcomes[outcomes.length - 1] || null;
}

export function buildOutcomeLabels({
  candidateDir = './state/candidates',
  trackDir = './state/track',
  paperTradesPath = './state/paper_trades.jsonl',
} = {}) {
  const seen = loadCandidateSeenEvents({ candidateDir });
  const trackedByMint = loadTrackedOutcomes({ trackDir });
  const paperByMint = loadPaperOutcomes({ paperTradesPath });

  return seen.map((c) => {
    const tracked = pickFirstAfter(trackedByMint.get(c.mint), c.tMs);
    const paper = pickFirstAfter(paperByMint.get(c.mint), c.tMs);
    const chosen = tracked || paper || null;

    return {
      t: c.t,
      tMs: c.tMs,
      mint: c.mint,
      symbol: c.symbol,
      source: c.source,
      candidatePriceUsd: c.priceUsd,
      outcomeSource: chosen?.outcomeType || 'none',
      outcomeClass: classifyOutcome(chosen?.pnlPct),
      pnlPct: chosen?.pnlPct ?? null,
      maePct: chosen?.maePct ?? null,
      mfePct: chosen?.mfePct ?? null,
      horizonHours: chosen?.horizonHours ?? null,
      exitReason: chosen?.exitReason ?? null,
      entryPrice: chosen?.entryPrice ?? null,
      exitPrice: chosen?.exitPrice ?? null,
      samples: chosen?.samples ?? null,
      hasOutcome: !!chosen,
      candidate: {
        marketDataSource: c.candidate?.marketDataSource ?? null,
        marketDataConfidence: c.candidate?.marketDataConfidence ?? null,
      },
    };
  });
}

export function summarizeLabels(labels) {
  const summary = {
    total: labels.length,
    withOutcome: 0,
    classCounts: { win: 0, loss: 0, neutral: 0, unknown: 0 },
    sourceCounts: {},
  };

  for (const l of labels) {
    if (l.hasOutcome) summary.withOutcome += 1;
    summary.classCounts[l.outcomeClass] = (summary.classCounts[l.outcomeClass] || 0) + 1;
    summary.sourceCounts[l.outcomeSource] = (summary.sourceCounts[l.outcomeSource] || 0) + 1;
  }

  return summary;
}

export function writeOutcomeLabels({ outDir = './state/outcome_labels', labels }) {
  const generatedAt = new Date().toISOString();
  const jsonlPath = path.join(outDir, 'labels.jsonl');
  const summaryPath = path.join(outDir, 'labels_summary.json');

  ensureDir(jsonlPath);
  fs.writeFileSync(jsonlPath, labels.map((x) => JSON.stringify(x)).join('\n') + (labels.length ? '\n' : ''), 'utf8');

  const summary = summarizeLabels(labels);
  const payload = { generatedAt, summary };
  fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2), 'utf8');

  return { generatedAt, jsonlPath, summaryPath, summary };
}
