#!/usr/bin/env node
import { evaluateReplay, loadTrackedSeries } from '../../src/analytics/replay_optimizer.mjs';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const days = Number(getArg('--days', '7'));
const windowHours = getArg('--window-hours', null);
const trackDir = getArg('--track-dir', './state/track');
const trailActivatePct = Number(getArg('--trail-activate-pct', process.env.LIVE_MOMO_TRAIL_ACTIVATE_PCT ?? '0.1'));
const trailDistancePct = Number(getArg('--trail-distance-pct', process.env.LIVE_MOMO_TRAIL_DISTANCE_PCT ?? '0.12'));
const stopEntryBufferPct = Number(getArg('--stop-entry-buffer-pct', process.env.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT ?? '0.0005'));
const asJson = process.argv.includes('--json');

const dataset = loadTrackedSeries({ trackDir, days });
const rules = { trailActivatePct, trailDistancePct, stopEntryBufferPct, breakevenOnTrailActivate: true };
const replay = evaluateReplay({ dataset, rules, windowHours: windowHours == null ? null : Number(windowHours) });

const out = {
  config: {
    days,
    windowHours: windowHours == null ? null : Number(windowHours),
    trackDir,
    rules,
  },
  dataset: {
    trackedSeries: dataset.length,
    firstStartedAt: dataset[0]?.series?.[0]?.t || null,
    lastStartedAt: dataset[dataset.length - 1]?.series?.[0]?.t || null,
  },
  metrics: replay.metrics,
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('=== Replay (historical tracked data) ===');
  console.log(`days=${out.config.days} windowHours=${out.config.windowHours ?? 'full'} trackDir=${out.config.trackDir}`);
  console.log(
    `rules: trailActivate=${(trailActivatePct * 100).toFixed(2)}% trailDistance=${(trailDistancePct * 100).toFixed(2)}% stopEntryBuffer=${(stopEntryBufferPct * 100).toFixed(4)}%`
  );
  console.log(`series=${out.dataset.trackedSeries} trades=${out.metrics.trades}`);
  console.log(
    `PnL proxy sum=${(out.metrics.pnlSumPct * 100).toFixed(2)}% avg=${(out.metrics.pnlAvgPct * 100).toFixed(2)}% hitRate=${(out.metrics.hitRate * 100).toFixed(1)}%`
  );
  console.log(
    `drawdown proxy=${(out.metrics.drawdownProxyPct * 100).toFixed(2)}% worstTrade=${(out.metrics.worstTradePct * 100).toFixed(2)}%`
  );
  console.log(`exits=${JSON.stringify(out.metrics.exits)}`);
}
