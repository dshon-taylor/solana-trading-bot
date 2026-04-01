#!/usr/bin/env node
import 'dotenv/config';
import { getConfig } from '../src/config.mjs';
import { tgSend } from '../src/telegram/index.mjs';
import { loadTrackedSeries, evaluateReplay, optimizeReplay } from '../src/replay_optimizer.mjs';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function pct(v, digits = 2) {
  return `${(Number(v || 0) * 100).toFixed(digits)}%`;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function confidenceScore({ deltaPnlAvg, consistencyDelta, trades }) {
  const edge = clamp01((deltaPnlAvg * 100) / 2.5); // +2.5pp avg pnl ~= strong
  const stability = clamp01((consistencyDelta + 0.25) / 0.5);
  const sample = clamp01((Number(trades || 0) - 8) / 30);
  return clamp01((0.45 * edge) + (0.35 * stability) + (0.20 * sample));
}

function confidenceLabel(v) {
  if (v >= 0.75) return 'High';
  if (v >= 0.5) return 'Medium';
  return 'Low';
}

function expectedDeltaRangePct({ deltaPnlAvg, stabilityPnlStdDev }) {
  const center = Number(deltaPnlAvg || 0);
  const noise = Math.max(0.0025, Number(stabilityPnlStdDev || 0));
  return {
    lo: center - noise,
    hi: center + noise,
  };
}

function nextSunday9ChicagoIso(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const baseMs = Math.floor(now.getTime() / 60_000) * 60_000; // minute-aligned

  // brute force minute-step search, bounded to 14 days
  for (let i = 1; i <= 14 * 24 * 60; i++) {
    const d = new Date(baseMs + i * 60_000);
    const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
    if (parts.weekday === 'Sun' && parts.hour === '09' && parts.minute === '00') {
      return d.toISOString();
    }
  }
  return null;
}

async function main() {
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');

  const days = Number(getArg('--days', '7'));
  const windowHours = Number(getArg('--window-hours', '24'));
  const dailyDays = Number(getArg('--daily-days', '1'));
  const top = Number(getArg('--top', '3'));
  const rollingWindows = Number(getArg('--rolling-windows', '4'));
  const trackDir = getArg('--track-dir', cfg.TRACK_DIR || './state/track');

  const grid = {
    trailDistancePct: getArg('--trail-distance-range', '0.08:0.20:0.02'),
    trailActivatePct: getArg('--trail-activate-range', '0.05:0.20:0.01'),
    stopEntryBufferPct: getArg('--stop-entry-buffer-range', '0.0003:0.003:0.0003'),
  };

  const weeklyDataset = loadTrackedSeries({ trackDir, days });
  const dailyDataset = loadTrackedSeries({ trackDir, days: dailyDays });

  const currentRules = {
    trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
    trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
    stopEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    breakevenOnTrailActivate: true,
  };

  const baselineWeekly = evaluateReplay({ dataset: weeklyDataset, rules: currentRules, windowHours });
  const baselineDaily = evaluateReplay({ dataset: dailyDataset, rules: currentRules, windowHours });

  const ranked = optimizeReplay({
    dataset: weeklyDataset,
    windowHours,
    grid,
    top: Math.max(top + 2, 6),
    rollingWindows,
  });

  const proposals = ranked
    .filter(r => JSON.stringify(r.rules) !== JSON.stringify(currentRules))
    .slice(0, top)
    .map((row, idx) => {
      const deltaPnlAvg = Number(row.metrics.pnlAvgPct || 0) - Number(baselineWeekly.metrics.pnlAvgPct || 0);
      const consistencyDelta = Number(row.metrics?.stability?.consistencyScore || 0) - Number(baselineWeekly.metrics?.stability?.consistencyScore || 0);
      const conf = confidenceScore({ deltaPnlAvg, consistencyDelta, trades: row.metrics.trades });
      const range = expectedDeltaRangePct({
        deltaPnlAvg,
        stabilityPnlStdDev: row.metrics?.stability?.pnlAvgStdDev,
      });

      return {
        idx: idx + 1,
        rules: row.rules,
        trades: row.metrics.trades,
        deltaPnlAvg,
        consistencyDelta,
        confidence: conf,
        expectedRange: range,
      };
    });

  const nextRunIso = nextSunday9ChicagoIso(new Date());
  const weeklyFrame = [
    `Weekly baseline (${days}d, ${windowHours}h horizon): trades=${baselineWeekly.metrics.trades}, avgPnL=${pct(baselineWeekly.metrics.pnlAvgPct)}, hitRate=${pct(baselineWeekly.metrics.hitRate)}, consistency=${Number(baselineWeekly.metrics?.stability?.consistencyScore || 0).toFixed(3)}.`,
    `Current live params: activate=${pct(currentRules.trailActivatePct)} distance=${pct(currentRules.trailDistancePct)} stopBuffer=${pct(currentRules.stopEntryBufferPct, 3)}.`,
  ].join(' ');

  const dailyNotes = `Daily context (${dailyDays}d): trades=${baselineDaily.metrics.trades}, avgPnL=${pct(baselineDaily.metrics.pnlAvgPct)}, hitRate=${pct(baselineDaily.metrics.hitRate)}. Used only as secondary context; weekly trend remains primary.`;

  const proposalLines = proposals.length
    ? proposals.map((p) => [
      `${p.idx}) tweak: activate ${pct(p.rules.trailActivatePct)} | distance ${pct(p.rules.trailDistancePct)} | stopBuffer ${pct(p.rules.stopEntryBufferPct, 3)}`,
      `   confidence: ${confidenceLabel(p.confidence)} (${pct(p.confidence, 1)})`,
      `   expected delta range (avg trade PnL): ${pct(p.expectedRange.lo)} to ${pct(p.expectedRange.hi)} vs current`,
      `   weekly consistency delta: ${p.consistencyDelta >= 0 ? '+' : ''}${p.consistencyDelta.toFixed(3)} | sample trades=${p.trades}`,
    ].join('\n')).join('\n')
    : 'No distinct rule tweaks found in this run.';

  const report = [
    '📬 Candle Carl — Weekly Optimizer Proposals (Propose-Only)',
    '',
    `🗓️ Schedule: Sundays at 9:00 AM America/Chicago`,
    nextRunIso ? `⏭️ Next scheduled run (UTC): ${nextRunIso}` : null,
    '',
    '🔒 Safety: This is a propose-only report. No automatic parameter changes will be made.',
    '',
    `📈 Weekly trend framing (primary): ${weeklyFrame}`,
    '',
    `📝 Daily context notes (secondary): ${dailyNotes}`,
    '',
    'Top 3 rule tweak proposals:',
    proposalLines,
  ].filter(Boolean).join('\n');

  if (dryRun) {
    console.log(report);
    return;
  }

  await tgSend(cfg, report);
  console.log(report);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
