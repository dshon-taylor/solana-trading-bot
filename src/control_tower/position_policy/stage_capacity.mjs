import { nowIso } from '../../logger.mjs';
import { pushDebug } from '../../debug_buffer.mjs';

export function positionCount(state) {
  return Object.values(state.positions || {}).filter(p => p?.status === 'open').length;
}

export function entryCapacityAvailable(state, cfg) {
  state.runtime ||= {};
  const open = positionCount(state);
  const maxPos = Math.max(0, Number(cfg.MAX_POSITIONS || 0));
  const resumeAt = Math.max(0, maxPos - 1);

  if (state.runtime.maxPosHaltActive) {
    if (open <= resumeAt) state.runtime.maxPosHaltActive = false;
  } else if (open >= maxPos) {
    state.runtime.maxPosHaltActive = true;
  }

  return !state.runtime.maxPosHaltActive && open < maxPos;
}

export function enforceEntryCapacityGate({ state, cfg, mint, symbol = null, tag = 'generic' }) {
  const nowMs = Date.now();
  const pauseUntilMs = Number(state?.exposure?.pausedUntilMs || 0);
  if (pauseUntilMs > nowMs) {
    pushDebug(state, {
      t: nowIso(),
      mint,
      symbol,
      reason: `ENTRY(blocked exposurePause ${tag} until=${new Date(pauseUntilMs).toISOString()})`,
    });
    return false;
  }
  if (entryCapacityAvailable(state, cfg)) return true;
  pushDebug(state, {
    t: nowIso(),
    mint,
    symbol,
    reason: `ENTRY(blocked preSwap maxPositionsHysteresis ${tag})`,
  });
  return false;
}
