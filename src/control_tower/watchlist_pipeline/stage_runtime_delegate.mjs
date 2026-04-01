import path from 'node:path';

import cache from '../../lib/cache/global_cache.mjs';
import { getRugcheckReport, isTokenSafe } from '../../providers/rugcheck.mjs';
import { getSolBalanceLamports } from '../../trading/portfolio.mjs';
import { passesBaseFilters, evaluateMomentumSignal } from '../../trading/strategy.mjs';
import { paperComputeMomentumWindows } from '../../analytics/paper_momentum.mjs';
import { toBaseUnits, DECIMALS } from '../../trading/trader.mjs';
import { nowIso } from '../../observability/logger.mjs';
import { bump, bumpWatchlistFunnel } from '../../observability/metrics.mjs';
import { pushDebug } from '../../observability/debug_buffer.mjs';
import { safeMsg } from '../../analytics/ai.mjs';
import { appendJsonl } from '../../trading/candidates_ledger.mjs';
import { jupQuote } from '../../providers/jupiter/client.mjs';
import { saveState } from '../../persistence/state.mjs';
import { getSnapshotStatus, isEntrySnapshotSafe, getWatchlistEntrySnapshotUnsafeReason, snapshotFromBirdseye } from '../../market_data/router.mjs';
import { canOpenNewEntry, recordEntryOpened, applySoftReserveToUsdTarget } from '../../trading/capital_guardrails.mjs';
import { isMicroFreshEnough, applyMomentumPassHysteresis, getCachedMintCreatedAt, scheduleMintCreatedAtLookup } from '../../signals/momentum_gate_controls.mjs';
import {
  CORE_MOMO_CHECKS,
  canaryMomoShouldSample,
  recordCanaryMomoFailChecks,
  coreMomentumProgress,
  decideMomentumBranch,
  normalizeEpochMs,
  applySnapshotToLatest,
  buildNormalizedMomentumInput,
  pruneMomentumRepeatFailMap,
} from './watchlist_eval_helpers.mjs';
import {
  ensureWatchlistState,
  readPct,
  queueHotWatchlistMint,
  resolvePairCreatedAtGlobal,
  resolveWatchlistRouteMeta,
  cacheRouteReadyMint,
  bumpImmediateBlockedReason,
} from '../watchlist_control.mjs';
import {
  holdersGateCheck,
  isPaperModeActive,
  ensureForceAttemptPolicyState,
  pruneForceAttemptPolicyWindows,
  evaluateForceAttemptPolicyGuards,
  recordForceAttemptPolicyAttempt,
} from '../route_control.mjs';
import { entryCapacityAvailable, enforceEntryCapacityGate } from '../position_policy.mjs';

export async function evaluateWatchlistRows({ args, deps }) {
  return (await import('../watchlist_pipeline_runtime.mjs')).evaluateWatchlistRowsRuntime({
    ...args,
    deps,
    runtimeDeps: {
      path,
      cache,
      getRugcheckReport,
      isTokenSafe,
      getSolBalanceLamports,
      passesBaseFilters,
      evaluateMomentumSignal,
      paperComputeMomentumWindows,
      toBaseUnits,
      DECIMALS,
      nowIso,
      bump,
      bumpWatchlistFunnel,
      pushDebug,
      safeMsg,
      appendJsonl,
      jupQuote,
      saveState,
      getSnapshotStatus,
      isEntrySnapshotSafe,
      getWatchlistEntrySnapshotUnsafeReason,
      snapshotFromBirdseye,
      canOpenNewEntry,
      recordEntryOpened,
      applySoftReserveToUsdTarget,
      isMicroFreshEnough,
      applyMomentumPassHysteresis,
      getCachedMintCreatedAt,
      scheduleMintCreatedAtLookup,
      CORE_MOMO_CHECKS,
      canaryMomoShouldSample,
      recordCanaryMomoFailChecks,
      coreMomentumProgress,
      decideMomentumBranch,
      normalizeEpochMs,
      applySnapshotToLatest,
      buildNormalizedMomentumInput,
      pruneMomentumRepeatFailMap,
      ensureWatchlistState,
      readPct,
      queueHotWatchlistMint,
      resolvePairCreatedAtGlobal,
      resolveWatchlistRouteMeta,
      cacheRouteReadyMint,
      bumpImmediateBlockedReason,
      holdersGateCheck,
      isPaperModeActive,
      ensureForceAttemptPolicyState,
      pruneForceAttemptPolicyWindows,
      evaluateForceAttemptPolicyGuards,
      recordForceAttemptPolicyAttempt,
      entryCapacityAvailable,
      enforceEntryCapacityGate,
    },
  });
}
