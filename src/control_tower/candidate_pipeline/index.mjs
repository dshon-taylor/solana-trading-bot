import { runSourceDiscoveryStage } from './stage_source_discovery.mjs';
import { runJupExpansionStage } from './stage_jup_expansion.mjs';
import { runFinalizeCandidatesStage } from './stage_finalize_candidates.mjs';

export function createCandidatePipeline({
  cfg,
  state,
  birdseye,
  streamingProvider,
  tgSend,
  saveState,
  markCallDuration = null,
}) {
  const cacheState = {
    jupTokens: null,
    jupTokensAt: 0,
    trendingTokens: [],
    trendingFetchedAt: 0,
    marketTrendingTokens: [],
    marketTrendingFetchedAt: 0,
    birdEyeBoostedTokens: [],
    birdEyeBoostedFetchedAt: 0,
  };

  async function fetchCandidateSources({ t, scanPhase, solUsdNow, counters }) {
    const sourceResult = await runSourceDiscoveryStage({
      cfg,
      state,
      birdseye,
      streamingProvider,
      tgSend,
      saveState,
      markCallDuration,
      cacheState,
      t,
      scanPhase,
      counters,
    });

    const jupExpandedRaw = await runJupExpansionStage({
      cfg,
      state,
      birdseye,
      tgSend,
      saveState,
      cacheState,
      t,
      scanPhase,
      solUsdNow,
      boostedRaw: sourceResult.boostedRaw,
    });

    const finalized = runFinalizeCandidatesStage({
      scanPhase,
      boostedRaw: jupExpandedRaw,
    });

    return {
      ...finalized,
      // Back-compat for existing scan pipeline caller contract.
      boosted: Array.isArray(finalized?.candidates) ? finalized.candidates : [],
      newDexCooldownUntil: sourceResult.newDexCooldownUntil,
    };
  }

  return { fetchCandidateSources };
}
