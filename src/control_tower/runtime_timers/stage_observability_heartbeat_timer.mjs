export function startObservabilityHeartbeatTimer({
  globalTimers,
  cfg,
  state,
  counters,
  birdseye,
  nowIso,
  pushDebug,
  saveState,
}) {
  if (globalTimers.heartbeatLoop) return;
  globalTimers.heartbeatLoop = setInterval(() => {
    try {
      const entriesMinute = (counters.watchlist && counters.watchlist.funnelMinute)
        ? counters.watchlist.funnelMinute.watchlistSeen
        : (counters.scanned || 0);
      const entriesHourEstimate = entriesMinute * 60;
      const queueSize = Number(state.exposure?.queue?.length || 0);
      const snapshotFailures = Number(state.marketData?.providers?.birdeye?.rejects || 0)
        + Number(state.marketData?.providers?.dexscreener?.rejects || 0)
        + Number(state.marketData?.providers?.jupiter?.rejects || 0);
      const cuStats = (birdseye && typeof birdseye.getStats === 'function')
        ? birdseye.getStats(Date.now())
        : null;
      const cuEstimate = cuStats ? Number(cuStats.projectedDailyCu || 0) : null;
      const regimeExposure = state.exposure?.activeRunnerCount || 0;
      const msg = `OBSERVABILITY ─ entries/hour≈${entriesHourEstimate} queueSize=${queueSize} snapshotFailures=${snapshotFailures} projectedDailyCu=${cuEstimate || 'n/a'} activeRunners=${regimeExposure}`;
      console.log(msg);
      pushDebug(state, { t: nowIso(), reason: 'observability', msg, counters: { entriesMinute, queueSize, snapshotFailures, cuEstimate, regimeExposure } });
      saveState(cfg.STATE_PATH, state);
    } catch (e) {
      console.warn('[observability] failed', e?.message || e);
    }
  }, 5 * 60_000);
  if (globalTimers.heartbeatLoop.unref) globalTimers.heartbeatLoop.unref();
}
