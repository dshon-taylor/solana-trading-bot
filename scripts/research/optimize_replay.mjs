#!/usr/bin/env node
import { loadTrackedSeries, optimizeReplay } from '../../src/replay_optimizer.mjs';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const days = Number(getArg('--days', '7'));
const windowHours = getArg('--window-hours', null);
const trackDir = getArg('--track-dir', './state/track');
const top = Number(getArg('--top', '10'));
const rollingWindows = Number(getArg('--rolling-windows', '4'));
const asJson = process.argv.includes('--json');

const grid = {
  trailDistancePct: getArg('--trail-distance-range', '0.08:0.20:0.02'),
  trailActivatePct: getArg('--trail-activate-range', '0.05:0.20:0.01'),
  stopEntryBufferPct: getArg('--stop-entry-buffer-range', '0.0003:0.003:0.0003'),
};

const dataset = loadTrackedSeries({ trackDir, days });
const ranked = optimizeReplay({
  dataset,
  windowHours: windowHours == null ? null : Number(windowHours),
  grid,
  top,
  rollingWindows,
});

if (asJson) {
  console.log(
    JSON.stringify(
      {
        config: { days, windowHours: windowHours == null ? null : Number(windowHours), trackDir, grid, top, rollingWindows },
        dataset: { trackedSeries: dataset.length },
        ranked,
      },
      null,
      2
    )
  );
} else {
  console.log('=== Replay optimizer (grid search) ===');
  console.log(`days=${days} windowHours=${windowHours ?? 'full'} trackDir=${trackDir}`);
  console.log(
    `grid: trailDistance=${grid.trailDistancePct} trailActivate=${grid.trailActivatePct} stopEntryBuffer=${grid.stopEntryBufferPct}`
  );
  console.log(`dataset series=${dataset.length} top=${top} rollingWindows=${rollingWindows}`);

  ranked.forEach((row, idx) => {
    const r = row.rules;
    const m = row.metrics;
    const s = m.stability || {};
    console.log(
      [
        `#${idx + 1}`,
        `activate=${(r.trailActivatePct * 100).toFixed(2)}%`,
        `distance=${(r.trailDistancePct * 100).toFixed(2)}%`,
        `stopBuf=${(r.stopEntryBufferPct * 100).toFixed(4)}%`,
        `trades=${m.trades}`,
        `pnlSum=${(m.pnlSumPct * 100).toFixed(2)}%`,
        `hitRate=${(m.hitRate * 100).toFixed(1)}%`,
        `ddProxy=${(m.drawdownProxyPct * 100).toFixed(2)}%`,
        `consistency=${Number(s.consistencyScore || 0).toFixed(4)}`,
        `pnlDisp=${(Number(s.pnlAvgStdDev || 0) * 100).toFixed(2)}%`,
        `winWindowRate=${(Number(s.positiveWindowRate || 0) * 100).toFixed(1)}%`,
        `exits=${JSON.stringify(m.exits)}`,
      ].join(' | ')
    );
  });
}
