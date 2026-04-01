import fs from 'node:fs';

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).map(safeJsonParse).filter(Boolean);
}

function toMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function holdTimeBucket(holdMs) {
  if (!Number.isFinite(holdMs) || holdMs < 0) return 'unknown';
  const min = holdMs / 60_000;
  if (min < 5) return '<5m';
  if (min <= 15) return '5-15m';
  if (min < 60) return '15-60m';
  if (min < 240) return '1-4h';
  if (min < 1440) return '4-24h';
  return '24h+';
}

function entryQualityFromPaper(entry = {}) {
  const ret15 = Number(entry.ret15);
  const ret5 = Number(entry.ret5);
  const greens = Number(entry.greensLast5);
  if (!Number.isFinite(ret15) || !Number.isFinite(ret5) || !Number.isFinite(greens)) return null;

  if (ret15 >= 0.12 && ret5 >= 0.08 && greens >= 4) return 'elite';
  if (ret15 >= 0.08 && ret5 >= 0.04 && greens >= 3) return 'strong';
  if (ret15 >= 0.04 && ret5 >= 0.02) return 'medium';
  return 'weak';
}

function entryQualityFromLiveSignal(signal = {}) {
  const pc1h = Number(signal.pc1h || 0);
  const buyBonus = signal.buyDominant ? 6 : 0;
  const txBonus = signal.txRising ? 5 : 0;
  const volBonus = signal.volumeRising ? 5 : 0;
  const breakBonus = signal.priceBreaking ? 8 : 0;
  const score = pc1h + buyBonus + txBonus + volBonus + breakBonus;

  if (!Number.isFinite(score)) return null;
  if (score >= 35) return 'elite';
  if (score >= 20) return 'strong';
  if (score >= 8) return 'medium';
  return 'weak';
}

export function entryQualityBucket(trade = {}) {
  const paper = entryQualityFromPaper(trade.paperEntrySignal || trade);
  if (paper) return paper;
  const live = entryQualityFromLiveSignal(trade.signal || {});
  if (live) return live;
  return 'unknown';
}

export function slippageBucket(trade = {}) {
  const explicitBps = Number(trade.slippageBps);
  if (Number.isFinite(explicitBps) && explicitBps > 0) {
    if (explicitBps <= 75) return 'tight(<=75bps)';
    if (explicitBps <= 150) return 'normal(76-150bps)';
    if (explicitBps <= 300) return 'wide(151-300bps)';
    return 'very-wide(>300bps)';
  }

  const paper = trade.paperEntrySignal || {};
  const volPct = Number.isFinite(Number(paper.ret15))
    ? Math.abs(Number(paper.ret15))
    : Math.abs(Number(trade.signal?.pc1h || 0)) / 100;

  if (!Number.isFinite(volPct)) return 'proxy:unknown';
  if (volPct < 0.05) return 'proxy:low-vol(<5%)';
  if (volPct < 0.15) return 'proxy:med-vol(5-15%)';
  if (volPct < 0.3) return 'proxy:high-vol(15-30%)';
  return 'proxy:extreme-vol(30%+)';
}

function toTradeRecordFromPaperExit(exitRow, entryByKey) {
  const entryT = exitRow.entryT || null;
  const key = `${exitRow.mint || ''}|${entryT || ''}`;
  const entry = entryByKey.get(key) || null;
  const entryMs = toMs(exitRow.entryT || entry?.t || null);
  const exitMs = toMs(exitRow.exitT || exitRow.t || null);
  return {
    source: 'paper',
    mint: exitRow.mint,
    symbol: exitRow.symbol,
    entryAt: exitRow.entryT || entry?.t || null,
    exitAt: exitRow.exitT || exitRow.t || null,
    holdMs: (entryMs != null && exitMs != null) ? (exitMs - entryMs) : null,
    pnlPct: Number(exitRow.pnlPct),
    exitReason: exitRow.exitReason || 'unknown',
    paperEntrySignal: entry ? {
      ret15: entry.ret15,
      ret5: entry.ret5,
      greensLast5: entry.greensLast5,
    } : null,
  };
}

function loadAttemptSignals(attemptsPath) {
  const rows = readJsonl(attemptsPath);
  return rows
    .filter((r) => r && r.stage === 'signal' && r.kind === 'paper_entry')
    .map((r) => ({
      mint: r.mint,
      t: r.t,
      ret15: r.ret15,
      ret5: r.ret5,
      greensLast5: r.greensLast5,
    }));
}

function loadPaperTrades(paperTradesPath, attemptSignals = []) {
  const rows = readJsonl(paperTradesPath).sort((a, b) => (toMs(a.t) || 0) - (toMs(b.t) || 0));
  const entries = rows.filter(r => r && r.type === 'entry');
  const entryByKey = new Map(entries.map(e => [`${e.mint || ''}|${e.t || ''}`, e]));
  const attemptByKey = new Map(attemptSignals.map(a => [`${a.mint || ''}|${a.t || ''}`, a]));

  return rows
    .filter(r => r && (r.exitReason || r.type === 'exit') && Number.isFinite(Number(r.pnlPct)))
    .map((r) => {
      const tr = toTradeRecordFromPaperExit(r, entryByKey);
      const attemptKey = `${r.mint || ''}|${r.entryT || ''}`;
      if (!tr.paperEntrySignal && attemptByKey.has(attemptKey)) {
        tr.paperEntrySignal = attemptByKey.get(attemptKey);
      }
      return tr;
    });
}

function loadLiveTradesFromState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return [];
  }
  const positions = Object.values(parsed?.positions || {});
  return positions
    .filter((p) => p && p.status === 'closed')
    .map((p) => {
      const entryMs = toMs(p.entryAt);
      const exitMs = toMs(p.exitAt);
      return {
        source: 'live',
        mint: p.mint,
        symbol: p.symbol,
        entryAt: p.entryAt,
        exitAt: p.exitAt,
        holdMs: (entryMs != null && exitMs != null) ? (exitMs - entryMs) : null,
        pnlPct: Number(p.pnlPct),
        exitReason: p.exitReason || 'unknown',
        signal: p.signal || null,
        slippageBps: p.slippageBps,
      };
    })
    .filter((t) => Number.isFinite(t.pnlPct));
}

function loadOutcomeLabels(labelsPath) {
  return readJsonl(labelsPath).filter((r) => r && r.mint);
}

function aggregateByBucket(trades, bucketFn) {
  const map = new Map();
  for (const tr of trades) {
    const bucket = bucketFn(tr);
    if (!map.has(bucket)) map.set(bucket, []);
    map.get(bucket).push(tr);
  }

  return Array.from(map.entries()).map(([bucket, items]) => {
    const pnls = items.map((t) => t.pnlPct).filter(Number.isFinite);
    const holds = items.map((t) => t.holdMs).filter(Number.isFinite);
    const wins = pnls.filter((x) => x > 0).length;
    return {
      bucket,
      trades: items.length,
      winRate: pnls.length ? wins / pnls.length : 0,
      avgPnlPct: pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0,
      medianPnlPct: median(pnls) ?? 0,
      avgHoldMins: holds.length ? (holds.reduce((a, b) => a + b, 0) / holds.length) / 60_000 : null,
    };
  }).sort((a, b) => b.trades - a.trades);
}

export function summarizeTradeLifecycle({
  paperTradesPath = './state/paper_trades.jsonl',
  attemptsPath = './state/paper_live_attempts.jsonl',
  labelsPath = './state/outcome_labels/labels.jsonl',
  statePath = './state/state.json',
  sinceHours = null,
} = {}) {
  const attemptSignals = loadAttemptSignals(attemptsPath);
  const labels = loadOutcomeLabels(labelsPath);

  const trades = [
    ...loadPaperTrades(paperTradesPath, attemptSignals),
    ...loadLiveTradesFromState(statePath),
  ];

  const now = Date.now();
  const filtered = Number.isFinite(Number(sinceHours)) && Number(sinceHours) > 0
    ? trades.filter((t) => {
      const exitMs = toMs(t.exitAt);
      return exitMs != null && exitMs >= (now - Number(sinceHours) * 60 * 60_000);
    })
    : trades;

  const allPnls = filtered.map((t) => t.pnlPct).filter(Number.isFinite);
  const allHolds = filtered.map((t) => t.holdMs).filter(Number.isFinite);

  const summary = {
    totals: {
      trades: filtered.length,
      wins: allPnls.filter((x) => x > 0).length,
      losses: allPnls.filter((x) => x <= 0).length,
      winRate: allPnls.length ? allPnls.filter((x) => x > 0).length / allPnls.length : 0,
      avgPnlPct: allPnls.length ? allPnls.reduce((a, b) => a + b, 0) / allPnls.length : 0,
      pnlSumPct: allPnls.reduce((a, b) => a + b, 0),
      medianHoldMins: allHolds.length ? (median(allHolds) / 60_000) : null,
    },
    breakdown: {
      entryQuality: aggregateByBucket(filtered, entryQualityBucket),
      holdTime: aggregateByBucket(filtered, (t) => holdTimeBucket(t.holdMs)),
      exitReason: aggregateByBucket(filtered, (t) => t.exitReason || 'unknown'),
      slippage: aggregateByBucket(filtered, slippageBucket),
    },
    notes: {
      slippageMethod: 'Uses explicit slippageBps when present; otherwise buckets by volatility proxy (paper ret15 or live signal pc1h).',
      sources: ['paper_trades.jsonl exits', 'paper_live_attempts.jsonl signal rows', 'state.json closed live positions', 'outcome_labels/labels.jsonl coverage'],
      coverage: {
        attemptSignals: attemptSignals.length,
        outcomeLabels: labels.length,
      },
    },
  };

  return summary;
}

export function formatLifecycleSummary(summary) {
  const pct = (x) => `${(Number(x || 0) * 100).toFixed(2)}%`;
  const lineFor = (row) => `• ${row.bucket}: n=${row.trades} win=${pct(row.winRate)} avg=${pct(row.avgPnlPct)} med=${pct(row.medianPnlPct)} hold=${row.avgHoldMins == null ? 'n/a' : `${row.avgHoldMins.toFixed(1)}m`}`;

  const topWins = [...summary.breakdown.entryQuality].sort((a, b) => b.avgPnlPct - a.avgPnlPct).slice(0, 2);
  const weak = [...summary.breakdown.entryQuality].sort((a, b) => a.avgPnlPct - b.avgPnlPct).slice(0, 2);

  return [
    'trade lifecycle analytics',
    `• trades=${summary.totals.trades} winRate=${pct(summary.totals.winRate)} avgPnl=${pct(summary.totals.avgPnlPct)} pnlSum=${pct(summary.totals.pnlSumPct)} medianHold=${summary.totals.medianHoldMins == null ? 'n/a' : `${summary.totals.medianHoldMins.toFixed(1)}m`}`,
    '',
    'entry quality buckets:',
    ...summary.breakdown.entryQuality.map(lineFor),
    '',
    'hold time buckets:',
    ...summary.breakdown.holdTime.map(lineFor),
    '',
    'exit reasons:',
    ...summary.breakdown.exitReason.map(lineFor),
    '',
    'slippage buckets:',
    ...summary.breakdown.slippage.map(lineFor),
    '',
    'actionable takeaways:',
    ...(topWins.length ? topWins.map((r) => `• Lean into ${r.bucket} entries (avg ${pct(r.avgPnlPct)} over ${r.trades} trades).`) : ['• Not enough data yet.']),
    ...(weak.length ? weak.map((r) => `• De-risk ${r.bucket} entries (avg ${pct(r.avgPnlPct)}).`) : []),
    `• Slippage note: ${summary.notes.slippageMethod}`,
  ].join('\n');
}
