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
