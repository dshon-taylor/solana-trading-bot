#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, 'state');
const CAND_DIR = path.join(STATE_DIR, 'candidates');
const TRACK_DIR = path.join(STATE_DIR, 'track');
const ATTEMPTS_FILE = path.join(STATE_DIR, 'paper_live_attempts.jsonl');
const ANALYSIS_DIR = path.join(ROOT, 'analysis');

const now = new Date();
const nowMs = now.getTime();
const lookbackDays = Number(process.env.CARL_LOOKBACK_DAYS || 7);
const windowStartMs = nowMs - lookbackDays * 24 * 60 * 60_000;

const cfg = {
  entryRet15: Number(process.env.PAPER_ENTRY_RET_15M_PCT || 0.03),
  entryRet5: Number(process.env.PAPER_ENTRY_RET_5M_PCT || 0.01),
  greensLast5: Number(process.env.PAPER_ENTRY_GREEN_LAST5 || 2),
  cooldownMs: Number(process.env.PAPER_ENTRY_COOLDOWN_MS || 180000),
  stopEntryBufferPct: Number(process.env.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT || 0.0005),
  trailActivatePct: Number(process.env.LIVE_MOMO_TRAIL_ACTIVATE_PCT || 0.12),
  trailDistancePct: Number(process.env.LIVE_MOMO_TRAIL_DISTANCE_PCT || 0.12),
  horizonMs: Number(process.env.CARL_SIM_HORIZON_MS || (24 * 60 * 60_000)),
};

const REASON = {
  ROUTE_QUOTE_UNAVAILABLE: 'route/quote unavailable',
  MOMENTUM_DRIFT: 'momentum gate not live at tick (sampling drift)',
  COOLDOWN_COLLISION: 'cooldown collision',
  EXEC_OR_RISK_PAUSED: 'execution gate/risk gate paused',
  SLIPPAGE_IMPACT: 'slippage/impact constraint likely',
  UNKNOWN: 'data insufficiency/unknown',
};

function fmtPct(x) {
  if (!Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(2)}%`;
}

function fmtIso(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return new Date(ms).toISOString();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function dayFromTs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

async function streamJsonl(filePath, onRow) {
  const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = parseLine(line);
    if (!row) continue;
    await onRow(row);
  }
}

function pickCandidatesFiles(startMs) {
  const out = [];
  if (!fs.existsSync(CAND_DIR)) return out;
  const names = fs.readdirSync(CAND_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const startDay = dayFromTs(startMs);
  for (const n of names) {
    const day = n.replace(/\.jsonl$/, '');
    if (day >= startDay) out.push(path.join(CAND_DIR, n));
  }
  return out;
}

function pickTrackFiles(startMs) {
  const out = [];
  if (!fs.existsSync(TRACK_DIR)) return out;
  const dayDirs = fs.readdirSync(TRACK_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const startDay = dayFromTs(startMs);
  for (const day of dayDirs) {
    if (day < startDay) continue;
    const full = path.join(TRACK_DIR, day);
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.jsonl')) out.push(path.join(full, f));
    }
  }
  return out;
}

function getRet(series, idx, windowMs) {
  const t = series[idx].tMs;
  const cutoff = t - windowMs;
  let base = null;
  for (let i = 0; i <= idx; i++) {
    if (series[i].tMs >= cutoff) {
      base = series[i];
      break;
    }
  }
  if (!base || !Number.isFinite(base.price) || base.price <= 0) return null;
  return (series[idx].price - base.price) / base.price;
}

function greensLastN(series, idx, n = 5) {
  const start = Math.max(0, idx - n + 1);
  let g = 0;
  for (let i = start + 1; i <= idx; i++) {
    if (series[i].price > series[i - 1].price) g += 1;
  }
  return g;
}

function simulateExit(entryPrice, points, rules) {
  let stopPx = entryPrice * (1 - rules.stopEntryBufferPct);
  let trailActivated = false;
  let trailHigh = null;
  let trailStop = null;
  let maxP = entryPrice;
  let minP = entryPrice;

  for (const pt of points) {
    const p = pt.price;
    if (!Number.isFinite(p) || p <= 0) continue;
    if (p > maxP) maxP = p;
    if (p < minP) minP = p;

    if (p <= stopPx) {
      return { exitPrice: stopPx, exitT: pt.tIso, exitReason: 'stopAtEntry', maxRunupPct: (maxP - entryPrice) / entryPrice, maxDrawdownPct: (minP - entryPrice) / entryPrice };
    }

    if (!trailActivated) {
      if (p >= entryPrice * (1 + rules.trailActivatePct)) {
        trailActivated = true;
        trailHigh = p;
        trailStop = trailHigh * (1 - rules.trailDistancePct);
        stopPx = Math.max(stopPx, entryPrice);
      }
    } else {
      if (p > trailHigh) {
        trailHigh = p;
        trailStop = trailHigh * (1 - rules.trailDistancePct);
      }
      if (p <= trailStop) {
        return { exitPrice: trailStop, exitT: pt.tIso, exitReason: 'trailingStop', maxRunupPct: (maxP - entryPrice) / entryPrice, maxDrawdownPct: (minP - entryPrice) / entryPrice };
      }
    }
  }

  const last = points[points.length - 1];
  const exitPrice = last?.price ?? entryPrice;
  return { exitPrice, exitT: last?.tIso || null, exitReason: 'horizon', maxRunupPct: (maxP - entryPrice) / entryPrice, maxDrawdownPct: (minP - entryPrice) / entryPrice };
}

function findNearest(rows, tMs, maxDeltaMs) {
  if (!rows || !rows.length) return null;
  let best = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const dt = Math.abs(r.tMs - tMs);
    if (dt <= maxDeltaMs && dt < bestAbs) {
      best = r;
      bestAbs = dt;
    }
  }
  return best;
}

function inferReason(event, context) {
  const evidence = [];

  if (event.cooldownCollision) {
    evidence.push(`prev event ${Math.round((event.tMs - event.prevEventMs) / 1000)}s ago (< cooldown ${Math.round(cfg.cooldownMs / 1000)}s)`);
    return { reason: REASON.COOLDOWN_COLLISION, confidence: 'high', evidence: evidence.join('; ') };
  }

  const nearCand = context.nearCand;
  const nearAttempt = context.nearAttempt;

  if (nearAttempt && (nearAttempt.liveEnabled === false || nearAttempt.tradingEnabled === false)) {
    evidence.push('paper_live_attempts shows live/trading disabled near signal');
    return { reason: REASON.EXEC_OR_RISK_PAUSED, confidence: 'high', evidence: evidence.join('; ') };
  }

  const rtxt = String(nearCand?.reason || '');
  const otxt = String(nearCand?.outcome || '');

  if (/noPair|routeUnavailable|quote/i.test(rtxt) || /noPair/i.test(otxt)) {
    evidence.push(`candidate reason=${rtxt || 'n/a'} outcome=${otxt || 'n/a'}`);
    return { reason: REASON.ROUTE_QUOTE_UNAVAILABLE, confidence: 'medium', evidence: evidence.join('; ') };
  }

  if (/momentum\(false\)/i.test(rtxt)) {
    evidence.push(`candidate reason=${rtxt}`);
    return { reason: REASON.MOMENTUM_DRIFT, confidence: 'medium', evidence: evidence.join('; ') };
  }

  if (/marketData\(lowConfidence\)|marketData\(lowScore/i.test(rtxt)) {
    evidence.push(`candidate reason=${rtxt}`);
    return { reason: REASON.UNKNOWN, confidence: 'medium', evidence: evidence.join('; ') };
  }

  if (event.sampleGapPrevMs > 90_000 || event.sampleGapNextMs > 90_000) {
    evidence.push(`large sample gap prev=${Math.round(event.sampleGapPrevMs / 1000)}s next=${Math.round(event.sampleGapNextMs / 1000)}s`);
    return { reason: REASON.MOMENTUM_DRIFT, confidence: 'low', evidence: evidence.join('; ') };
  }

  const adverse = Number.isFinite(event.minFuture2mPct) && event.minFuture2mPct <= -0.08;
  const parabolic = event.ret5 >= 0.12 || event.ret15 >= 0.25;
  if (adverse || parabolic) {
    evidence.push(`ret5=${fmtPct(event.ret5)} ret15=${fmtPct(event.ret15)} minFuture2m=${fmtPct(event.minFuture2mPct)}`);
    return { reason: REASON.SLIPPAGE_IMPACT, confidence: adverse ? 'medium' : 'low', evidence: evidence.join('; ') };
  }

  if (!nearCand || !nearCand.reason) {
    evidence.push('no nearby candidate decision row');
  } else {
    evidence.push(`nearby reason=${nearCand.reason}`);
  }
  return { reason: REASON.UNKNOWN, confidence: 'low', evidence: evidence.join('; ') };
}

async function main() {
  ensureDir(ANALYSIS_DIR);

  const candidateFiles = pickCandidatesFiles(windowStartMs);
  const perMint = new Map();
  const candMetaByMint = new Map();
  let candRowsScanned = 0;
  let candRowsUsed = 0;
  const candDays = new Set();

  for (const fp of candidateFiles) {
    await streamJsonl(fp, (row) => {
      candRowsScanned += 1;
      if (row?.bot !== 'candle-carl') return;
      const tIso = row?.t || row?.t_audit;
      const tMs = Date.parse(tIso || '');
      if (!Number.isFinite(tMs) || tMs < windowStartMs || tMs > nowMs) return;
      const mint = row?.mint;
      if (!mint) return;

      let metaArr = candMetaByMint.get(mint);
      if (!metaArr) {
        metaArr = [];
        candMetaByMint.set(mint, metaArr);
      }
      metaArr.push({
        tMs,
        tIso: new Date(tMs).toISOString(),
        reason: row?.reason || null,
        outcome: row?.outcome || null,
      });

      const p = Number(row?.priceUsd);
      if (!Number.isFinite(p) || p <= 0) return;
      const symbol = row?.symbol || null;
      candRowsUsed += 1;
      candDays.add(dayFromTs(tMs));
      let arr = perMint.get(mint);
      if (!arr) {
        arr = [];
        perMint.set(mint, arr);
      }
      arr.push({ tMs, tIso: new Date(tMs).toISOString(), price: p, symbol });
    });
  }

  const trackFiles = pickTrackFiles(windowStartMs);
  let trackRowsUsed = 0;
  const trackDays = new Set();
  const trackedMintDays = new Set();
  for (const fp of trackFiles) {
    const day = fp.split(path.sep).slice(-2)[0];
    const mint = path.basename(fp, '.jsonl');
    trackedMintDays.add(`${day}|${mint}`);
    await streamJsonl(fp, (row) => {
      const tMs = Date.parse(row?.t || '');
      const p = Number(row?.priceUsd);
      if (!Number.isFinite(tMs) || tMs < windowStartMs || tMs > nowMs) return;
      if (!Number.isFinite(p) || p <= 0) return;
      trackRowsUsed += 1;
      trackDays.add(dayFromTs(tMs));
    });
  }

  // Attempt logs for execution paused inference.
  const attemptsByMint = new Map();
  if (fs.existsSync(ATTEMPTS_FILE)) {
    await streamJsonl(ATTEMPTS_FILE, (row) => {
      if (row?.kind !== 'paper_entry') return;
      const tMs = Date.parse(row?.t || '');
      if (!Number.isFinite(tMs) || tMs < windowStartMs || tMs > nowMs) return;
      const mint = row?.mint;
      if (!mint) return;
      let arr = attemptsByMint.get(mint);
      if (!arr) {
        arr = [];
        attemptsByMint.set(mint, arr);
      }
      arr.push({
        tMs,
        liveEnabled: row?.liveEnabled,
        tradingEnabled: row?.tradingEnabled,
      });
    });
  }

  for (const arr of [ ...perMint.values(), ...candMetaByMint.values(), ...attemptsByMint.values() ]) {
    arr.sort((a, b) => a.tMs - b.tMs);
  }

  // Dedup/sort per mint price series.
  for (const [mint, arr] of perMint.entries()) {
    arr.sort((a, b) => a.tMs - b.tMs || a.price - b.price);
    const dedup = [];
    let lastKey = '';
    for (const pt of arr) {
      const k = `${pt.tMs}|${pt.price}`;
      if (k === lastKey) continue;
      dedup.push(pt);
      lastKey = k;
    }
    perMint.set(mint, dedup);
  }

  const rawEvents = [];
  let consideredMints = 0;

  for (const [mint, series] of perMint.entries()) {
    if (series.length < 3) continue;
    consideredMints += 1;

    let prevRawEventMs = null;

    for (let i = 0; i < series.length; i++) {
      const pt = series[i];
      const ret15 = getRet(series, i, 15 * 60_000);
      const ret5 = getRet(series, i, 5 * 60_000);
      const greens = greensLastN(series, i, 5);
      if (ret15 == null || ret5 == null) continue;
      if (!(ret15 >= cfg.entryRet15 && ret5 >= cfg.entryRet5 && greens >= cfg.greensLast5)) continue;

      const horizonEnd = pt.tMs + cfg.horizonMs;
      const future = series.filter((x, idx) => idx > i && x.tMs <= horizonEnd);
      if (!future.length) continue;

      const sim = simulateExit(pt.price, future, {
        stopEntryBufferPct: cfg.stopEntryBufferPct,
        trailActivatePct: cfg.trailActivatePct,
        trailDistancePct: cfg.trailDistancePct,
      });
      const pnlPct = (sim.exitPrice - pt.price) / pt.price;

      const window2mEnd = pt.tMs + 120_000;
      const future2m = series.filter((x, idx) => idx > i && x.tMs <= window2mEnd);
      const minFuture2m = future2m.length ? Math.min(...future2m.map((x) => x.price)) : null;
      const minFuture2mPct = Number.isFinite(minFuture2m) ? (minFuture2m - pt.price) / pt.price : null;

      const sampleGapPrevMs = i > 0 ? (pt.tMs - series[i - 1].tMs) : Number.POSITIVE_INFINITY;
      const sampleGapNextMs = i + 1 < series.length ? (series[i + 1].tMs - pt.tMs) : Number.POSITIVE_INFINITY;

      rawEvents.push({
        mint,
        symbol: pt.symbol,
        entryT: pt.tIso,
        tMs: pt.tMs,
        entryPrice: pt.price,
        ret15,
        ret5,
        greens,
        exitT: sim.exitT,
        exitPrice: sim.exitPrice,
        exitReason: sim.exitReason,
        pnlPct,
        maxRunupPct: sim.maxRunupPct,
        maxDrawdownPct: sim.maxDrawdownPct,
        sampleGapPrevMs,
        sampleGapNextMs,
        minFuture2mPct,
        cooldownCollision: prevRawEventMs != null && (pt.tMs - prevRawEventMs) < cfg.cooldownMs,
        prevEventMs: prevRawEventMs,
      });
      prevRawEventMs = pt.tMs;
    }
  }

  rawEvents.sort((a, b) => a.tMs - b.tMs);

  const enriched = rawEvents.map((ev) => {
    const nearCand = findNearest(candMetaByMint.get(ev.mint), ev.tMs, 90_000);
    const nearAttempt = findNearest(attemptsByMint.get(ev.mint), ev.tMs, 120_000);
    const mintDayKey = `${dayFromTs(ev.tMs)}|${ev.mint}`;
    const trackedSameDay = trackedMintDays.has(mintDayKey);

    const inf = inferReason(ev, { nearCand, nearAttempt, trackedSameDay });

    // Route/quote unavailable fallback when mint/day has no track artifact and no better evidence.
    if (inf.reason === REASON.UNKNOWN && !trackedSameDay) {
      inf.reason = REASON.ROUTE_QUOTE_UNAVAILABLE;
      inf.confidence = 'low';
      inf.evidence = `${inf.evidence}; no track artifact for mint/day`;
    }

    return {
      ...ev,
      nearCandReason: nearCand?.reason || null,
      nearCandOutcome: nearCand?.outcome || null,
      trackedSameDay,
      likelyNonFillReason: inf.reason,
      confidence: inf.confidence,
      confidenceNotes: inf.evidence,
    };
  });

  const allReasonLabels = Object.values(REASON);
  const reasonCounts = Object.fromEntries(allReasonLabels.map((k) => [k, 0]));
  for (const e of enriched) {
    reasonCounts[e.likelyNonFillReason] = (reasonCounts[e.likelyNonFillReason] || 0) + 1;
  }

  const confidenceByReason = Object.fromEntries(allReasonLabels.map((k) => [k, { high: 0, medium: 0, low: 0 }]));
  for (const e of enriched) {
    const key = e.likelyNonFillReason;
    confidenceByReason[key][e.confidence] = (confidenceByReason[key][e.confidence] || 0) + 1;
  }

  const ts = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const reportPath = path.join(ANALYSIS_DIR, `carl-backfill-counterfactual-v2-${ts}.md`);
  const csvPath = path.join(ANALYSIS_DIR, `carl-backfill-counterfactual-v2-${ts}.csv`);

  const csvHeaders = [
    'entryT', 'mint', 'symbol', 'entryPrice', 'ret15', 'ret5', 'greensLast5',
    'cooldownCollision', 'sampleGapPrevMs', 'sampleGapNextMs', 'minFuture2mPct',
    'trackedSameDay', 'nearCandOutcome', 'nearCandReason',
    'likelyNonFillReason', 'confidence', 'confidenceNotes',
    'proxyExitReason', 'proxyPnlPct', 'maxRunupPct', 'maxDrawdownPct',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const e of enriched) {
    const row = [
      e.entryT, e.mint, e.symbol || '', e.entryPrice, e.ret15, e.ret5, e.greens,
      e.cooldownCollision, Math.round(e.sampleGapPrevMs), Math.round(e.sampleGapNextMs), e.minFuture2mPct,
      e.trackedSameDay, e.nearCandOutcome || '', e.nearCandReason || '',
      e.likelyNonFillReason, e.confidence, e.confidenceNotes,
      e.exitReason, e.pnlPct, e.maxRunupPct, e.maxDrawdownPct,
    ].map(csvEscape);
    csvLines.push(row.join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf8');

  const topByPnl = [...enriched].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 10);
  const bottomByPnl = [...enriched].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 10);

  const lines = [];
  lines.push('# Candle Carl backfill counterfactual v2 (non-fill reason inference)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Window start: ${new Date(windowStartMs).toISOString()}`);
  lines.push(`Window end: ${new Date(nowMs).toISOString()}`);
  lines.push('');
  lines.push('## Profile used (same trigger as v1)');
  lines.push(`- entry: ret15 >= ${fmtPct(cfg.entryRet15)}, ret5 >= ${fmtPct(cfg.entryRet5)}, greensLast5 >= ${cfg.greensLast5}`);
  lines.push(`- cooldown considered for collision flag: ${Math.round(cfg.cooldownMs / 1000)}s`);
  lines.push(`- exit proxy (for context only): stop-at-entry ${fmtPct(cfg.stopEntryBufferPct)}, trail activate ${fmtPct(cfg.trailActivatePct)}, trail distance ${fmtPct(cfg.trailDistancePct)}`);
  lines.push(`- horizon: ${Math.round(cfg.horizonMs / 3600000)}h`);
  lines.push('');
  lines.push('## Coverage');
  lines.push(`- candidate files scanned: ${candidateFiles.length}`);
  lines.push(`- candidate rows scanned / usable-price rows: ${candRowsScanned.toLocaleString()} / ${candRowsUsed.toLocaleString()}`);
  lines.push(`- candidate days in window: ${[...candDays].sort().join(', ') || 'none'}`);
  lines.push(`- track files scanned: ${trackFiles.length} | usable track rows: ${trackRowsUsed.toLocaleString()}`);
  lines.push(`- track days in window: ${[...trackDays].sort().join(', ') || 'none'}`);
  lines.push(`- unique mints with candidate price series: ${perMint.size.toLocaleString()}`);
  lines.push(`- mints with enough samples for momentum check: ${consideredMints.toLocaleString()}`);
  lines.push(`- would-enter events (raw, before skipping cooldown): ${enriched.length.toLocaleString()}`);
  lines.push('');
  lines.push('## Non-fill reason summary (inferred)');
  lines.push('| reason | count | confidence split (H/M/L) |');
  lines.push('|---|---:|---|');
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    const c = confidenceByReason[reason] || { high: 0, medium: 0, low: 0 };
    lines.push(`| ${reason} | ${count.toLocaleString()} | ${c.high}/${c.medium}/${c.low} |`);
  }
  lines.push('');
  lines.push('### Confidence notes');
  lines.push('- **High**: direct rule evidence (e.g., cooldown collision, explicit gate-disabled record near timestamp).');
  lines.push('- **Medium**: nearby candidate reason hints (e.g., noPair/momentum(false)/marketData low confidence) or strong adverse micro-move evidence.');
  lines.push('- **Low**: heuristic fallback (sampling gaps, missing track artifact, limited contextual records).');
  lines.push('');

  lines.push('## First 60 would-enter events with inferred non-fill reason');
  lines.push('| entryT | mint | symbol | ret15 | ret5 | cooldown? | inferred reason | conf | notes |');
  lines.push('|---|---|---:|---:|---:|---:|---|---|---|');
  for (const e of enriched.slice(0, 60)) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.ret15)} | ${fmtPct(e.ret5)} | ${e.cooldownCollision ? 'yes' : 'no'} | ${e.likelyNonFillReason} | ${e.confidence} | ${e.confidenceNotes.replaceAll('|', '/')} |`);
  }
  lines.push('');

  lines.push('## Context: proxy best/worst outcomes (not fill-realized)');
  lines.push('### Best 10 by proxy PnL');
  lines.push('| entryT | mint | symbol | proxy pnl | inferred reason | conf |');
  lines.push('|---|---|---:|---:|---|---|');
  for (const e of topByPnl) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.pnlPct)} | ${e.likelyNonFillReason} | ${e.confidence} |`);
  }
  lines.push('');

  lines.push('### Worst 10 by proxy PnL');
  lines.push('| entryT | mint | symbol | proxy pnl | inferred reason | conf |');
  lines.push('|---|---|---:|---:|---|---|');
  for (const e of bottomByPnl) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.pnlPct)} | ${e.likelyNonFillReason} | ${e.confidence} |`);
  }
  lines.push('');

  lines.push('## Reproducibility');
  lines.push('```bash');
  lines.push('cd /home/dshontaylor/.openclaw/workspace/trading-bot');
  lines.push('CARL_LOOKBACK_DAYS=7 node scripts/backfill/carl_backfill_counterfactual_v2.mjs');
  lines.push('```');
  lines.push('');
  lines.push('## Caveats');
  lines.push('- Inference is best-effort from sampled candidate/track artifacts; no full orderbook or exact quote/fill telemetry.');
  lines.push('- Reason assignment is single-label per event for readability; multiple contributing factors can coexist.');
  lines.push('- execution gate/risk gate paused only reaches high confidence when explicit nearby gate-disabled records exist.');
  lines.push('- Slippage/impact category is heuristic and may over/under-tag highly volatile tokens.');

  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');

  const summary = {
    reportPath,
    csvPath,
    totals: {
      events: enriched.length,
      reasonCounts,
      confidenceByReason,
    },
    coverage: {
      candidateFiles: candidateFiles.length,
      candRowsScanned,
      candRowsUsed,
      trackFiles: trackFiles.length,
      trackRowsUsed,
      mints: perMint.size,
      consideredMints,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
