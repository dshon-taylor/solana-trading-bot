/**
 * Timer-based safety net: ensures stops/trailing enforcement continues
 * even when the main scan loop is slow.
 */
export function startPositionsLoopTimer({ globalTimers, cfg, runPositionsLoop, lastPosRef }) {
  if (globalTimers.positionsLoop) return;
  const everyMs = Math.max(500, Math.min(2_000, Math.floor(cfg.POSITIONS_EVERY_MS / 4) || 1_000));
  globalTimers.positionsLoop = setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
      runPositionsLoop(nowMs).catch(() => {});
    }
  }, everyMs);
  if (globalTimers.positionsLoop.unref) globalTimers.positionsLoop.unref();
}
