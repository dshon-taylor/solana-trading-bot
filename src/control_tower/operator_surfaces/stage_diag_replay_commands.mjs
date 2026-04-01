import { saveState } from '../../persistence/state.mjs';
import { safeErr } from '../../observability/logger.mjs';

export async function handleDiagReplayCommands(ctx) {
  const {
    cfg,
    state,
    tgSend,
    tgSendChunked,
    getDiagSnapshotMessage,
    runNodeScriptJson,
    appendLearningNote,
  } = ctx;

  if (state.flags?.sendDiag) {
    const rawMode = String(state.flags?.sendDiagMode || 'compact').toLowerCase();
    const mode = (rawMode === 'full' || rawMode === 'momentum' || rawMode === 'confirm' || rawMode === 'execution' || rawMode === 'scanner') ? rawMode : 'compact';
    const windowHours = Number(state.flags?.sendDiagWindowHours);
    const useHours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : null;
    state.flags.sendDiag = false;
    delete state.flags.sendDiagMode;
    delete state.flags.sendDiagWindowHours;
    await tgSendChunked(getDiagSnapshotMessage(Date.now(), mode, useHours));
  }

  if (state.flags?.runReplay) {
    const req = state.flags.runReplay;
    delete state.flags.runReplay;
    try { await saveState(cfg.STATE_PATH, state); } catch {}
    try {
      const args = ['scripts/replay_historical.mjs', '--json', '--days', String(req.days)];
      if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));
      if (req.trailActivatePct != null) args.push('--trail-activate-pct', String(req.trailActivatePct));
      if (req.trailDistancePct != null) args.push('--trail-distance-pct', String(req.trailDistancePct));
      if (req.stopEntryBufferPct != null) args.push('--stop-entry-buffer-pct', String(req.stopEntryBufferPct));

      const out = await runNodeScriptJson(args[0], args.slice(1), 90_000);
      await tgSend(
        cfg,
        [
          '🧪 *Historical Replay*',
          `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0}`,
          `rules: activate=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)}% distance=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)}% stopBuf=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}%`,
          `trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}%`,
          `exits=${JSON.stringify(out?.metrics?.exits || {})}`,
        ].join('\n')
      );
      appendLearningNote?.(`Replay run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}% rules[a=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}].`);
    } catch (e) {
      await tgSend(cfg, `❌ Replay failed: ${safeErr(e).message}`);
    }
  }

  if (state.flags?.runOptimize) {
    const req = state.flags.runOptimize;
    delete state.flags.runOptimize;
    try { await saveState(cfg.STATE_PATH, state); } catch {}
    try {
      const args = [
        'scripts/optimize_replay.mjs',
        '--json',
        '--days',
        String(req.days),
        '--top',
        String(req.top),
        '--trail-activate-range',
        String(req.trailActivateRange),
        '--trail-distance-range',
        String(req.trailDistanceRange),
        '--stop-entry-buffer-range',
        String(req.stopEntryBufferRange),
      ];
      if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));

      const out = await runNodeScriptJson(args[0], args.slice(1), 120_000);
      const ranked = Array.isArray(out?.ranked) ? out.ranked : [];
      const lines = ranked.slice(0, Math.min(5, ranked.length)).map((row, i) => {
        const r = row.rules || {};
        const m = row.metrics || {};
        return `#${i + 1} a=${(Number(r.trailActivatePct || 0) * 100).toFixed(2)}% d=${(Number(r.trailDistancePct || 0) * 100).toFixed(2)}% sb=${(Number(r.stopEntryBufferPct || 0) * 100).toFixed(4)}% | pnl=${(Number(m.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(m.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(m.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(m.trades || 0)}`;
      });

      await tgSend(
        cfg,
        [
          '⚙️ *Replay Optimizer*',
          `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0} top=${out?.config?.top}`,
          `preset=${req.preset} grid: activate=${req.trailActivateRange} distance=${req.trailDistanceRange} stopbuf=${req.stopEntryBufferRange}`,
          '',
          ...(lines.length ? lines : ['No optimization rows returned.']),
        ].join('\n')
      );
      const best = ranked[0] || {};
      const br = best.rules || {};
      const bm = best.metrics || {};
      appendLearningNote?.(`Optimize run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} top=${out?.config?.top} grid[a=${req.trailActivateRange} d=${req.trailDistanceRange} sb=${req.stopEntryBufferRange}] best[a=${(Number(br.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(br.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(br.stopEntryBufferPct || 0) * 100).toFixed(4)}] pnl=${(Number(bm.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(bm.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(bm.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(bm.trades || 0)}.`);
    } catch (e) {
      await tgSend(cfg, `❌ Optimizer failed: ${safeErr(e).message}`);
    }
  }
}
