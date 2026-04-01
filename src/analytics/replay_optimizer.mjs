import fs from 'node:fs';
import path from 'node:path';
import { computeTrailPct } from '../signals/trailing.mjs';
import { computePreTrailStopPrice } from '../signals/stop_policy.mjs';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRangeSpec(spec) {
  if (Array.isArray(spec)) return spec.map(Number).filter(Number.isFinite);
  const s = String(spec || '').trim();
  if (!s) return [];

  if (s.includes(',')) {
    return s
      .split(',')
      .map((x) => Number(x.trim()))
      .filter(Number.isFinite);
  }

  const parts = s.split(':').map((x) => Number(x.trim()));
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return [];

  const [start, end, step] = parts;
  if (step <= 0 || end < start) return [];

  const out = [];
  for (let x = start; x <= end + step / 10; x += step) {
    out.push(Number(x.toFixed(10)));
  }
  return out;
}

function listDayDirs(trackDir) {
  try {
    return fs
      .readdirSync(trackDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readJsonl(filePath) {
  let txt = '';
  try {
    txt = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  if (!txt.trim()) return [];
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }
  return out;
}

export function loadTrackedSeries({ trackDir = './state/track', days = 7, nowMs = Date.now() } = {}) {
  const dayDirs = listDayDirs(trackDir);
  const cutoffMs = nowMs - Number(days) * 24 * 60 * 60_000;

  const selected = dayDirs.filter((d) => Date.parse(`${d}T00:00:00Z`) >= cutoffMs - 24 * 60 * 60_000);
  const seriesSet = [];

  for (const day of selected) {
    const dayPath = path.join(trackDir, day);
    let files = [];
    try {
      files = fs
        .readdirSync(dayPath, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f) => f.name)
        .sort();
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dayPath, file);
      const rows = readJsonl(filePath);
      const points = rows
        .map((r) => ({
          t: r?.t || null,
          tMs: Date.parse(r?.t || ''),
          price: toNum(r?.priceUsd),
          entryPrice: toNum(r?.entryPrice),
          mint: r?.mint || file.replace(/\.jsonl$/, ''),
          symbol: r?.symbol || null,
        }))
        .filter((p) => Number.isFinite(p.tMs) && Number.isFinite(p.price) && p.price > 0)
        .sort((a, b) => a.tMs - b.tMs);

      if (!points.length) continue;
      if (points[0].tMs < cutoffMs) continue;

      const entryPrice = points.find((p) => Number.isFinite(p.entryPrice) && p.entryPrice > 0)?.entryPrice || points[0].price;
      seriesSet.push({
        key: `${day}/${file}`,
        mint: points[0].mint,
        symbol: points[0].symbol,
        startedAtMs: points[0].tMs,
        entryPrice,
        series: points.map((p) => ({ t: p.t, tMs: p.tMs, price: p.price })),
      });
    }
  }

  seriesSet.sort((a, b) => a.startedAtMs - b.startedAtMs || a.key.localeCompare(b.key));
  return seriesSet;
}

export function simulateReplayPosition({ entryPrice, series, rules, windowHours = null }) {
  const out = {
    entryPrice,
    exitPrice: null,
    exitT: null,
    exitReason: null,
    pnlPct: null,
    maxRunupPct: null,
    maxDrawdownPct: null,
  };

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Array.isArray(series) || !series.length) return out;

  const windowMs = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0
    ? Number(windowHours) * 60 * 60_000
    : null;
  const horizonEndMs = windowMs ? series[0].tMs + windowMs : null;
  const points = horizonEndMs
    ? series.filter((p) => Number.isFinite(p.tMs) && p.tMs <= horizonEndMs)
    : series.slice();
  if (!points.length) return out;

  const stopEntryBufferPct = Number(rules?.stopEntryBufferPct ?? 0.0005);
  const stopArmDelayMs = Math.max(0, Number(rules?.stopArmDelayMs ?? 75_000));
  const prearmCatastrophicStopPct = Math.max(0, Number(rules?.prearmCatastrophicStopPct ?? 0.07));
  const breakevenOnTrailActivate = rules?.breakevenOnTrailActivate !== false;

  const entryAtMs = Number(points?.[0]?.tMs || series?.[0]?.tMs || Date.now());
  let stopPx = Number(computePreTrailStopPrice({
    entryPriceUsd: entryPrice,
    entryAtMs,
    nowMs: entryAtMs,
    armDelayMs: stopArmDelayMs,
    prearmCatastrophicStopPct,
    stopAtEntryBufferPct: stopEntryBufferPct,
  }) || (entryPrice * (1 - stopEntryBufferPct)));
  let trailActivated = false;
  let trailHigh = null;
  let trailStop = null;
  let activeTrailPct = null;

  let maxP = entryPrice;
  let minP = entryPrice;

  for (const pt of points) {
    const p = Number(pt?.price);
    if (!Number.isFinite(p) || p <= 0) continue;

    if (p > maxP) maxP = p;
    if (p < minP) minP = p;

    const ptMs = Number.isFinite(Number(pt?.tMs)) ? Number(pt.tMs) : entryAtMs;
    const profitPct = (p - entryPrice) / entryPrice;
    const desiredTrailPct = computeTrailPct(profitPct);

    if (!trailActivated && desiredTrailPct == null) {
      const preTrailStop = computePreTrailStopPrice({
        entryPriceUsd: entryPrice,
        entryAtMs,
        nowMs: ptMs,
        armDelayMs: stopArmDelayMs,
        prearmCatastrophicStopPct,
        stopAtEntryBufferPct: stopEntryBufferPct,
      });
      if (Number.isFinite(Number(preTrailStop)) && preTrailStop > 0) {
        stopPx = Math.max(stopPx, Number(preTrailStop));
      }
    }

    if (p <= stopPx) {
      out.exitPrice = stopPx;
      out.exitT = pt?.t || null;
      out.exitReason = 'stopAtEntry';
      break;
    }

    if (!trailActivated) {
      if (desiredTrailPct != null) {
        trailActivated = true;
        activeTrailPct = desiredTrailPct;
        trailHigh = p;
        trailStop = trailHigh * (1 - activeTrailPct);
        if (breakevenOnTrailActivate) stopPx = Math.max(stopPx, entryPrice);
      }
    } else {
      if (desiredTrailPct != null && Number.isFinite(Number(activeTrailPct))) {
        activeTrailPct = Math.min(Number(activeTrailPct), Number(desiredTrailPct));
      }
      if (p > trailHigh) {
        trailHigh = p;
        trailStop = trailHigh * (1 - Number(activeTrailPct || 0));
      }
      if (p <= trailStop) {
        out.exitPrice = trailStop;
        out.exitT = pt?.t || null;
        out.exitReason = 'trailingStop';
        break;
      }
    }
  }

  out.maxRunupPct = (maxP - entryPrice) / entryPrice;
  out.maxDrawdownPct = (minP - entryPrice) / entryPrice;

  if (out.exitPrice == null) {
    const last = [...points].reverse().find((x) => Number.isFinite(Number(x?.price)) && Number(x?.price) > 0);
    if (last) {
      out.exitPrice = Number(last.price);
      out.exitT = last.t || null;
      out.exitReason = 'horizon';
    }
  }

  if (Number.isFinite(out.exitPrice)) out.pnlPct = (out.exitPrice - entryPrice) / entryPrice;
  return out;
}

export function evaluateReplay({ dataset, rules, windowHours = null }) {
  const trades = [];
  for (const item of dataset || []) {
    const sim = simulateReplayPosition({
      entryPrice: item.entryPrice,
      series: item.series,
      rules,
      windowHours,
    });
    if (sim.exitPrice == null || sim.pnlPct == null) continue;
    trades.push({ ...item, ...sim });
  }

  const exits = {};
  let pnlSumPct = 0;
  let wins = 0;
  let worstTradePct = null;
  let equity = 1;
  let equityPeak = 1;
  let maxDrawdown = 0;

  for (const t of trades) {
    pnlSumPct += t.pnlPct;
    if (t.pnlPct > 0) wins += 1;
    exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
    if (worstTradePct == null || t.pnlPct < worstTradePct) worstTradePct = t.pnlPct;

    equity *= 1 + t.pnlPct;
    if (equity > equityPeak) equityPeak = equity;
    const dd = (equity - equityPeak) / equityPeak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return {
    trades,
    metrics: {
      trades: trades.length,
      pnlSumPct,
      pnlAvgPct: trades.length ? pnlSumPct / trades.length : 0,
      hitRate: trades.length ? wins / trades.length : 0,
      drawdownProxyPct: maxDrawdown,
      worstTradePct: worstTradePct ?? 0,
      exits,
    },
  };
}

function stdDev(values) {
  if (!Array.isArray(values) || values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varMean = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(varMean);
}

export function computeRollingStability({ trades, windows = 4 }) {
  const n = Math.max(1, Number(windows) || 4);
  const ordered = [...(trades || [])].sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0) || String(a.key || '').localeCompare(String(b.key || '')));
  if (!ordered.length) {
    return {
      windows: n,
      windowTradeCounts: [],
      windowPnlAvgPct: [],
      windowHitRate: [],
      pnlAvgStdDev: 0,
      hitRateStdDev: 0,
      positiveWindowRate: 0,
      consistencyScore: 0,
    };
  }

  const buckets = Array.from({ length: n }, () => []);
  for (let i = 0; i < ordered.length; i++) {
    const idx = Math.min(n - 1, Math.floor((i * n) / ordered.length));
    buckets[idx].push(ordered[i]);
  }

  const windowTradeCounts = buckets.map((b) => b.length);
  const windowPnlAvgPct = buckets.map((b) => {
    if (!b.length) return 0;
    return b.reduce((acc, t) => acc + (Number(t.pnlPct) || 0), 0) / b.length;
  });
  const windowHitRate = buckets.map((b) => {
    if (!b.length) return 0;
    const wins = b.filter((t) => Number(t.pnlPct) > 0).length;
    return wins / b.length;
  });

  const pnlAvgStdDev = stdDev(windowPnlAvgPct);
  const hitRateStdDev = stdDev(windowHitRate);
  const positiveWindowRate = windowPnlAvgPct.filter((x) => x > 0).length / n;

  // Deterministic composite score: reward more positive windows, penalize dispersion.
  const consistencyScore = positiveWindowRate - (2 * pnlAvgStdDev) - hitRateStdDev;

  return {
    windows: n,
    windowTradeCounts,
    windowPnlAvgPct,
    windowHitRate,
    pnlAvgStdDev,
    hitRateStdDev,
    positiveWindowRate,
    consistencyScore,
  };
}

export function optimizeReplay({ dataset, windowHours = null, grid, top = 10, rollingWindows = 4 }) {
  const scored = [];

  const trailDistances = parseRangeSpec(grid?.trailDistancePct);
  const trailActivations = parseRangeSpec(grid?.trailActivatePct);
  const stopBuffers = parseRangeSpec(grid?.stopEntryBufferPct);

  for (const trailDistancePct of trailDistances) {
    for (const trailActivatePct of trailActivations) {
      for (const stopEntryBufferPct of stopBuffers) {
        const rules = {
          trailDistancePct,
          trailActivatePct,
          stopEntryBufferPct,
          breakevenOnTrailActivate: true,
        };
        const { trades, metrics } = evaluateReplay({ dataset, rules, windowHours });
        const stability = computeRollingStability({ trades, windows: rollingWindows });
        scored.push({ rules, metrics: { ...metrics, stability } });
      }
    }
  }

  scored.sort((a, b) => {
    const sa = Number(a.metrics?.stability?.consistencyScore || 0);
    const sb = Number(b.metrics?.stability?.consistencyScore || 0);
    if (sb !== sa) return sb - sa;

    if (b.metrics.pnlSumPct !== a.metrics.pnlSumPct) return b.metrics.pnlSumPct - a.metrics.pnlSumPct;
    if (b.metrics.hitRate !== a.metrics.hitRate) return b.metrics.hitRate - a.metrics.hitRate;
    if (b.metrics.drawdownProxyPct !== a.metrics.drawdownProxyPct) return b.metrics.drawdownProxyPct - a.metrics.drawdownProxyPct;
    if (b.metrics.trades !== a.metrics.trades) return b.metrics.trades - a.metrics.trades;

    // stable deterministic tie-break across runtimes
    return JSON.stringify(a.rules).localeCompare(JSON.stringify(b.rules));
  });

  return scored.slice(0, Math.max(1, Number(top) || 10));
}
