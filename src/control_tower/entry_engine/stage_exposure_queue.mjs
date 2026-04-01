import { nowIso } from '../../observability/logger.mjs';
import { pushDebug } from '../../observability/debug_buffer.mjs';
import { saveState } from '../../persistence/state.mjs';
import { isPaperModeActive } from '../route_control.mjs';
import { enforceEntryCapacityGate } from '../position_policy.mjs';
import { openPosition } from './stage_open_position.mjs';

export async function processExposureQueue(cfg, conn, wallet, state) {
  state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
  const maxActive = Math.max(1, Number(cfg.MAX_ACTIVE_RUNNERS || 3));
  const openCount = Object.values(state.positions || {}).filter((p) => p?.status === 'open').length;
  state.exposure.activeRunnerCount = Math.max(0, Math.min(openCount, maxActive));
  const nowMs = Date.now();
  state.exposure.queue = (state.exposure.queue || []).filter(q => Number(q.expiryMs || 0) > nowMs);
  if (Number(state.exposure.pausedUntilMs || 0) > nowMs) return;
  while (state.exposure.queue.length && Number(state.exposure.activeRunnerCount || 0) < maxActive) {
    const q = state.exposure.queue.shift();
    try {
      const tradeCfg = q.tradeCfg || {};
      const paperModeActive = isPaperModeActive({ state, cfg, nowMs: Date.now() });
      if (!enforceEntryCapacityGate({ state, cfg, mint: q.mint, symbol: q.symbol, tag: 'queue' })) continue;
      const entryRes = await openPosition(cfg, conn, wallet, state, q.solUsdNow || 0, q.pair, q.mcap || 0, q.decimals || null, q.report || null, q.sigReasons || null, { ...tradeCfg, paperOnly: paperModeActive });
      if (!entryRes?.blocked) {
        const openAfter = Object.values(state.positions || {}).filter((p) => p?.status === 'open').length;
        state.exposure.activeRunnerCount = Math.max(0, Math.min(openAfter, maxActive));
        pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: 'QUEUE(executed)' });
      } else {
        pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: `QUEUE(blocked:${entryRes.reason})` });
      }
    } catch (e) {
      pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: `QUEUE(execError:${String(e?.message || e)})` });
    }
  }
  saveState(cfg.STATE_PATH, state);
}
