#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, 'state');
const CAND_DIR = path.join(STATE_DIR, 'candidates');
const TRACK_DIR = path.join(STATE_DIR, 'track');
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

async function main() {
  ensureDir(ANALYSIS_DIR);

  const candidateFiles = pickCandidatesFiles(windowStartMs);
  const perMint = new Map();
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
      const p = Number(row?.priceUsd);
      if (!mint || !Number.isFinite(p) || p <= 0) return;
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

  // Also inspect track files for backfill coverage stats.
  const trackFiles = pickTrackFiles(windowStartMs);
  let trackRowsUsed = 0;
  const trackDays = new Set();
  for (const fp of trackFiles) {
    await streamJsonl(fp, (row) => {
      const tMs = Date.parse(row?.t || '');
      const p = Number(row?.priceUsd);
      if (!Number.isFinite(tMs) || tMs < windowStartMs || tMs > nowMs) return;
      if (!Number.isFinite(p) || p <= 0) return;
      trackRowsUsed += 1;
      trackDays.add(dayFromTs(tMs));
    });
  }

  // Dedup/sort per mint.
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

  // Entry detection + simulation.
  const entries = [];
  let consideredMints = 0;
  for (const [mint, series] of perMint.entries()) {
    if (series.length < 3) continue;
    consideredMints += 1;
    let lastEntryMs = 0;

    for (let i = 0; i < series.length; i++) {
      const pt = series[i];
      if (lastEntryMs && (pt.tMs - lastEntryMs) < cfg.cooldownMs) continue;

      const ret15 = getRet(series, i, 15 * 60_000);
      const ret5 = getRet(series, i, 5 * 60_000);
      const greens = greensLastN(series, i, 5);
      if (ret15 == null || ret5 == null) continue;

      if (ret15 >= cfg.entryRet15 && ret5 >= cfg.entryRet5 && greens >= cfg.greensLast5) {
        lastEntryMs = pt.tMs;
        const horizonEnd = pt.tMs + cfg.horizonMs;
        const future = series.filter((x, idx) => idx > i && x.tMs <= horizonEnd);
        if (!future.length) continue;

        const sim = simulateExit(pt.price, future, {
          stopEntryBufferPct: cfg.stopEntryBufferPct,
          trailActivatePct: cfg.trailActivatePct,
          trailDistancePct: cfg.trailDistancePct,
        });
        const pnlPct = (sim.exitPrice - pt.price) / pt.price;

        entries.push({
          mint,
          symbol: pt.symbol,
          entryT: pt.tIso,
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
        });
      }
    }
  }

  entries.sort((a, b) => Date.parse(a.entryT) - Date.parse(b.entryT));

  const trades = entries.length;
  const pnlSum = entries.reduce((a, e) => a + e.pnlPct, 0);
  const avg = trades ? pnlSum / trades : 0;
  const wins = entries.filter((e) => e.pnlPct > 0).length;
  const hit = trades ? wins / trades : 0;
  const exits = entries.reduce((acc, e) => {
    acc[e.exitReason] = (acc[e.exitReason] || 0) + 1;
    return acc;
  }, {});

  const best = [...entries].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 10);
  const worst = [...entries].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 10);

  const ts = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const reportPath = path.join(ANALYSIS_DIR, `carl-backfill-counterfactual-${ts}.md`);

  const lines = [];
  lines.push('# Candle Carl backfill + 7-day counterfactual (best-effort)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Window start: ${new Date(windowStartMs).toISOString()}`);
  lines.push(`Window end: ${new Date(nowMs).toISOString()}`);
  lines.push('');
  lines.push('## Profile used (current loose momentum intent)');
  lines.push(`- entry: ret15 >= ${fmtPct(cfg.entryRet15)}, ret5 >= ${fmtPct(cfg.entryRet5)}, greensLast5 >= ${cfg.greensLast5}`);
  lines.push(`- cooldown: ${Math.round(cfg.cooldownMs / 1000)}s`);
  lines.push(`- exit: stop-at-entry buffer ${fmtPct(cfg.stopEntryBufferPct)}, trail activate ${fmtPct(cfg.trailActivatePct)}, trail distance ${fmtPct(cfg.trailDistancePct)}`);
  lines.push(`- simulation horizon per entry: ${Math.round(cfg.horizonMs / 3600000)}h`);
  lines.push('');
  lines.push('## Backfill / reconstruction coverage');
  lines.push(`- candidates files scanned: ${candidateFiles.length}`);
  lines.push(`- candidate rows scanned/usable: ${candRowsScanned.toLocaleString()} / ${candRowsUsed.toLocaleString()}`);
  lines.push(`- candidate days with usable data: ${[...candDays].sort().join(', ') || 'none'}`);
  lines.push(`- track files scanned: ${trackFiles.length}`);
  lines.push(`- track rows usable: ${trackRowsUsed.toLocaleString()}`);
  lines.push(`- track days with usable data: ${[...trackDays].sort().join(', ') || 'none'}`);
  lines.push(`- unique mints with candidate time-series in window: ${perMint.size.toLocaleString()}`);
  lines.push(`- mints with enough samples for momentum check: ${consideredMints.toLocaleString()}`);
  lines.push('');
  lines.push('## 7-day should-have-entered summary (counterfactual)');
  lines.push(`- candidate entries triggered: ${trades.toLocaleString()}`);
  lines.push(`- proxy PnL sum: ${fmtPct(pnlSum)} | avg/trade: ${fmtPct(avg)} | hit-rate: ${(hit * 100).toFixed(1)}%`);
  lines.push(`- exits: ${JSON.stringify(exits)}`);
  lines.push('');

  lines.push('### First 50 candidate entries (timestamp, mint, symbol, est pnl, exit)');
  lines.push('| entryT | mint | symbol | ret15 | ret5 | pnl | exitReason |');
  lines.push('|---|---|---:|---:|---:|---:|---|');
  for (const e of entries.slice(0, 50)) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.ret15)} | ${fmtPct(e.ret5)} | ${fmtPct(e.pnlPct)} | ${e.exitReason} |`);
  }
  lines.push('');

  lines.push('### Best 10 estimated outcomes');
  lines.push('| entryT | mint | symbol | pnl | maxRunup | exitReason |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const e of best) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.pnlPct)} | ${fmtPct(e.maxRunupPct)} | ${e.exitReason} |`);
  }
  lines.push('');

  lines.push('### Worst 10 estimated outcomes');
  lines.push('| entryT | mint | symbol | pnl | maxDrawdown | exitReason |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const e of worst) {
    lines.push(`| ${e.entryT} | ${e.mint} | ${e.symbol || ''} | ${fmtPct(e.pnlPct)} | ${fmtPct(e.maxDrawdownPct)} | ${e.exitReason} |`);
  }
  lines.push('');

  lines.push('## Limitations / caveats');
  lines.push('- Uses sampled candidate snapshots and track artifacts only; no full tick/trade tape.');
  lines.push('- Missing days in the 7-day window reduce continuity; results are best-effort, not complete market coverage.');
  lines.push('- Entry trigger inferred from sampled cadence, so trigger timing can drift vs live.');
  lines.push('- PnL is proxy (paper stop/trail logic) and excludes fees, slippage, liquidity constraints, failed fills, and execution latency.');
  lines.push('- Exit simulation uses observed future samples up to horizon; sparse series can over/under-estimate stop/trail interactions.');

  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');

  const summary = {
    reportPath,
    coverage: {
      candidateFiles: candidateFiles.length,
      candRowsScanned,
      candRowsUsed,
      candDays: [...candDays].sort(),
      trackFiles: trackFiles.length,
      trackRowsUsed,
      trackDays: [...trackDays].sort(),
      mints: perMint.size,
      consideredMints,
    },
    analysis: {
      trades,
      pnlSum,
      pnlAvg: avg,
      hitRate: hit,
      exits,
      firstEntry: entries[0]?.entryT || null,
      lastEntry: entries[entries.length - 1]?.entryT || null,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
