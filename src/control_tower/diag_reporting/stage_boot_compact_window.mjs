import { getCompactWindowForDiagRequest } from './diag_event_store.mjs';

export function bootstrapCompactWindowState({ state, counters, cfg }) {
  state.runtime ||= {};
  state.runtime.compactWindow ||= {};
  counters.watchlist ||= {};
  counters.watchlist.compactWindow = state.runtime.compactWindow;
  state.runtime.confirmTxCarryByMint ||= {};

  try {
    const compactHasData = Array.isArray(counters?.watchlist?.compactWindow?.momentumAgeSamples)
      && counters.watchlist.compactWindow.momentumAgeSamples.length > 0;
    if (!compactHasData) {
      const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
      const nowMsForHydrate = Date.now();
      state.runtime.compactWindow = getCompactWindowForDiagRequest({
        statePath: cfg.STATE_PATH,
        mode: 'compact',
        nowMs: nowMsForHydrate,
        windowStartMs: nowMsForHydrate - retainMs,
        retainMs,
      });
      counters.watchlist.compactWindow = state.runtime.compactWindow;
    }
  } catch {}

  try {
    const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};
    for (const [mint, row] of Object.entries(wlMints)) {
      const c = row?.meta?.confirmTxCarry || null;
      if (c && Number(c?.atMs || 0) > 0) state.runtime.confirmTxCarryByMint[mint] = { ...c };
    }
  } catch {}
}
