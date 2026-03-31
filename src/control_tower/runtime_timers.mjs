export function startWatchlistCleanupTimer({ globalTimers, cfg, wsmgr }) {
  if (globalTimers.watchlistCleanup) return;
  globalTimers.watchlistCleanup = setInterval(async () => {
    try {
      const now = Date.now();
      let anyStale = false;
      for (const [mint] of wsmgr.live.entries()) {
        const d = wsmgr.diag[mint] || {};
        const last = Number(d.last_ws_ts || 0);
        if (last && (now - last) > (wsmgr.staleMs || 1200)) {
          anyStale = true;
          break;
        }
      }
      if (anyStale) await wsmgr.restResync();
    } catch {}
  }, Math.max(300, Number(process.env.BIRDEYE_WS_STALE_POLL_MS || 500)));
}

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
