import { maybeSendScanCycleVisibilityPing } from './stage_visibility.mjs';
import { buildPairFetchQueue } from './stage_route_prefilter.mjs';
import { runPairFetchStage } from './stage_pair_fetch.mjs';
import { buildShortlistAndGates } from './stage_shortlist.mjs';

export function createScanPipeline(deps) {
  async function runScanPipeline({
    t,
    solUsdNow,
    boostedRaw,
    boosted,
    counters,
    scanPhase,
    scanRateLimitedStart,
    scanState,
    pushScanCompactEvent,
  }) {
    await maybeSendScanCycleVisibilityPing({ state: deps.state, cfg: deps.cfg, t, tgSend: deps.tgSend, boostedRaw, boosted });

    const routePrep = await buildPairFetchQueue({
      deps,
      cfg: deps.cfg,
      state: deps.state,
      t,
      solUsdNow,
      boosted,
      counters,
      scanPhase,
      scanState,
      pushScanCompactEvent,
    });

    if (routePrep.dexHit429) {
      return {
        skipCycle: true,
        scanState: routePrep.scanState,
      };
    }

    const pairFetch = await runPairFetchStage({
      deps,
      cfg: deps.cfg,
      state: deps.state,
      t,
      solUsdNow,
      counters,
      scanPhase,
      scanRateLimitedStart,
      scanState: routePrep.scanState,
      pairFetchQueue: routePrep.pairFetchQueue,
      noPairTemporary: routePrep.noPairTemporary,
      noPairDeadMints: routePrep.noPairDeadMints,
      pushScanCompactEvent,
    });

    const shortlist = await buildShortlistAndGates({
      deps,
      cfg: deps.cfg,
      state: deps.state,
      t,
      solUsdNow,
      counters,
      scanPhase,
      preCandidates: pairFetch.preCandidates,
      scanState: pairFetch.scanState,
    });

    return {
      skipCycle: false,
      preCandidates: shortlist.preCandidates,
      probeEnabled: shortlist.probeEnabled,
      probeShortlist: shortlist.probeShortlist,
      executionAllowed: shortlist.executionAllowed,
      executionAllowedReason: shortlist.executionAllowedReason,
      routeAvailableImmediateRows: pairFetch.routeAvailableImmediateRows,
      scanState: shortlist.scanState,
    };
  }

  return { runScanPipeline };
}
