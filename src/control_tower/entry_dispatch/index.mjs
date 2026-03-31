import { handleWatchlistTriggerMode } from './stage_watchlist_mode.mjs';
import { processProbeShortlistEntries } from './stage_candidate_entries.mjs';

export function createEntryDispatch(deps) {
  async function runEntryDispatch({
    t,
    solUsdNow,
    sol,
    counters,
    scanPhase,
    probeShortlist,
    probeEnabled,
    executionAllowed,
    executionAllowedReason,
    routeAvailableImmediateRows,
  }) {
    const watchlistResult = await handleWatchlistTriggerMode({
      deps,
      cfg: deps.cfg,
      state: deps.state,
      t,
      counters,
      scanPhase,
      solUsdNow,
      routeAvailableImmediateRows,
      probeShortlist,
      executionAllowed,
      executionAllowedReason,
    });

    if (watchlistResult?.handled) {
      return { continueCycle: true };
    }

    await processProbeShortlistEntries({
      deps,
      cfg: deps.cfg,
      state: deps.state,
      t,
      solUsdNow,
      sol,
      counters,
      probeShortlist,
      probeEnabled,
      executionAllowed,
    });

    return { continueCycle: false };
  }

  return { runEntryDispatch };
}
