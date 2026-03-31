export function createGetDiagSnapshotMessage({
  state,
  getCounters,
  cfg,
  nowIso,
  fmtCt,
  runtime,
}) {
  void nowIso;
  void cfg;

  return function getDiagSnapshotMessage(nowMs = Date.now(), mode = 'full', windowHours = null) {
    const counters = getCounters();
    const updatedAtMs = Number(runtime.diagSnapshot.updatedAtMs || 0);
    const ageSec = updatedAtMs > 0 ? Math.max(0, Math.round((nowMs - updatedAtMs) / 1000)) : null;
    const updatedIso = fmtCt(updatedAtMs);

    if (mode !== 'full') {
      state.runtime ||= {};
      if (!Number.isFinite(Number(state.runtime.botStartTimeMs || 0))) state.runtime.botStartTimeMs = nowMs;
      const botStartTimeMs = Number(state.runtime.botStartTimeMs || nowMs);
      const useWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : null;
      const windowStartMs = useWindowHours ? (nowMs - (useWindowHours * 3_600_000)) : botStartTimeMs;
      const windowLabel = useWindowHours ? `${useWindowHours}h` : 'sinceStart';
      const wl = state.watchlist || {};
      const wlMints = wl?.mints && typeof wl.mints === 'object' ? wl.mints : {};
      const watchlistSize = Object.keys(wlMints).length;
      const hotDepth = Array.isArray(wl?.hotQueue) ? wl.hotQueue.length : 0;
      const providers = state.marketData?.providers || {};
      const providerRate = (p) => {
        const req = Number(p?.requests || 0);
        const hit = Number(p?.hits || 0);
        return req > 0 ? `${Math.round((hit / req) * 100)}%` : 'n/a';
      };
      const wlFunnel = counters?.watchlist?.funnelCumulative || {};

      return [
        `🧪 *Diag (${String(mode)})* window=${windowLabel} start=${fmtCt(windowStartMs)}`,
        'HEADER',
        `snapshotAt=${updatedIso} watchlistSize=${watchlistSize} hotDepth=${hotDepth}`,
        `providers: birdeye=${providerRate(providers?.birdeye)} jupiter=${providerRate(providers?.jupiter)} dex=${providerRate(providers?.dexscreener)}`,
        `pipeline: momentum=${Number(wlFunnel.momentumPassed || 0)} confirm=${Number(wlFunnel.confirmPassed || 0)} attempt=${Number(wlFunnel.attempted || 0)} fill=${Number(wlFunnel.filled || 0)}`,
        '',
        runtime.diagSnapshot.message,
      ].join('\n');
    }

    state.runtime ||= {};
    if (!Number.isFinite(Number(state.runtime.botStartTimeMs || 0))) state.runtime.botStartTimeMs = nowMs;
    const botStartTimeMs = Number(state.runtime.botStartTimeMs || nowMs);
    const useWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : null;
    const windowStartMs = useWindowHours ? (nowMs - (useWindowHours * 3_600_000)) : botStartTimeMs;
    const windowLabel = useWindowHours ? `${useWindowHours}h` : 'sinceStart';
    return [
      `🧪 *Diag Snapshot* window=${windowLabel} start=${fmtCt(windowStartMs)}`,
      `snapshotAt=${updatedIso} staleness=${ageSec == null ? 'n/a' : `${ageSec}s`} buildMs=${runtime.diagSnapshot.builtInMs}`,
      runtime.diagSnapshot.message,
    ].join('\n');
  };
}
