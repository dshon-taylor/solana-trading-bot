export function registerGracefulShutdown({
  cfg,
  state,
  globalTimers,
  clearAllTimers,
  saveState,
  birdEyeWs,
  healthServer,
  getStreamingProvider,
}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn('[shutdown] signal=' + signal);
    try { clearAllTimers(globalTimers); } catch {}
    try { saveState(cfg.STATE_PATH, state); } catch {}
    try { getStreamingProvider?.()?.stop?.(); } catch {}
    try { birdEyeWs?.stop?.(); } catch {}
    try { healthServer?.close?.(); } catch {}
    try {
      const { closeTimescaleDB } = await import('../../analytics/timeseries_db.mjs');
      await closeTimescaleDB();
    } catch {}
    setTimeout(() => process.exit(0), 250).unref();
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  return { shutdown, isShuttingDown: () => shuttingDown };
}
