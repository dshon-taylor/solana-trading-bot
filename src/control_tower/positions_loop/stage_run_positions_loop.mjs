import { processOpenPosition } from './stage_process_open_position.mjs';

/**
 * positions_loop.mjs
 *
 * Factory for the positions enforcement loop.
 * Owns the in-flight guard and delegates to the caller's lastPosRef for cross-loop
 * timestamp coordination.
 */
export function createPositionsLoop({
  cfg,
  state,
  cache,
  conn,
  wallet,
  birdseye,
  lastPosRef,
  closePosition,
  updateStops,
  tgSend,
  saveState,
  pushDebug,
  nowIso,
  computePreTrailStopPrice,
  conservativeExitMark,
  isStopSnapshotUsable,
  tokenDisplayName,
  getMarketSnapshot,
  getTokenPairs,
  pickBestPair,
  safeErr,
}) {
  let _positionsLoopInFlight = false;

  async function runPositionsLoop(t) {
    if (_positionsLoopInFlight) return;
    _positionsLoopInFlight = true;
    lastPosRef.value = t;
    try {
      for (const [mint, pos] of Object.entries(state.positions)) {
        if (pos.status !== 'open') continue;
        await processOpenPosition({
          cfg,
          state,
          cache,
          conn,
          wallet,
          birdseye,
          closePosition,
          updateStops,
          tgSend,
          saveState,
          pushDebug,
          nowIso,
          computePreTrailStopPrice,
          conservativeExitMark,
          isStopSnapshotUsable,
          tokenDisplayName,
          getMarketSnapshot,
          getTokenPairs,
          pickBestPair,
          safeErr,
          t,
          mint,
          pos,
        });
      }
    } catch (e) {
      console.warn('[positionsLoop] error', safeErr(e).message);
    } finally {
      _positionsLoopInFlight = false;
    }
  }

  return { runPositionsLoop };
}
