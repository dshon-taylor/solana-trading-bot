import { runRowPreflightStage } from './stage_row_preflight.mjs';
import { runMomentumEvalStage } from './stage_momentum_eval.mjs';
import { runConfirmContinuationStage } from './stage_confirm_continuation.mjs';
import { runAttemptPolicyAndEntryStage } from './stage_attempt_policy_and_entry.mjs';
import { runPostAttemptOutcomesStage } from './stage_post_attempt_outcomes.mjs';
import { appendDiagEvent } from '../diag_reporting/diag_event_store.mjs';
export { runWatchlistTriggerLane } from './stage_watchlist_trigger_lane.mjs';

export async function evaluateWatchlistRowsRuntime({
  rows,
  cfg,
  state,
  counters,
  nowMs,
  executionAllowed,
  executionAllowedReason = null,
  solUsdNow,
  conn,
  pub,
  wallet,
  birdseye = null,
  immediateMode = false,
  canary = null,
  deps = {},
  runtimeDeps = {},
}) {
  const {
    confirmQualityGate,
    confirmContinuationGate,
    recordConfirmCarryTrace,
    resolveConfirmTxMetrics,
    resolveMintCreatedAtFromRpc,
    computeMcapUsd,
    openPosition,
    wsmgr,
  } = deps;
  const {
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
  } = runtimeDeps;

  const hotBypassTracePath = path.join(path.dirname(cfg.STATE_PATH || 'state/state.json'), 'hot_bypass_trace.jsonl');
  const paperModeActive = isPaperModeActive({ state, cfg, nowMs });
  const pushBypassTraceSummary = (evt) => {
    counters.watchlist.hotBypassTraceFinalReason ||= {};
    if (evt?.nextStageReached === 'momentum') {
      if (!Array.isArray(counters.watchlist.momentumRecentLast5)) counters.watchlist.momentumRecentLast5 = [];
      counters.watchlist.momentumRecentLast5.push({
        t: evt?.timestamp,
        mint: evt?.mint,
        liq: evt?.liquidityUsd ?? null,
        mcap: evt?.mcapValueSeenByHot ?? null,
        final: evt?.finalPreMomentumRejectReason || null,
      });
      if (counters.watchlist.momentumRecentLast5.length > 5) {
        counters.watchlist.momentumRecentLast5 = counters.watchlist.momentumRecentLast5.slice(-5);
      }
    }
    const r = String(evt?.finalPreMomentumRejectReason || 'none');
    counters.watchlist.hotBypassTraceFinalReason[r] = Number(counters.watchlist.hotBypassTraceFinalReason[r] || 0) + 1;

    if (r === 'momentum.momentumFailed') {
      counters.watchlist.momentumFailedChecksTop ||= {};
      counters.watchlist.momentumFailedMintsTop ||= {};
      counters.watchlist.momentumFailedCheckExamples ||= [];
      const mint = String(evt?.mint || 'unknown');
      counters.watchlist.momentumFailedMintsTop[mint] = Number(counters.watchlist.momentumFailedMintsTop[mint] || 0) + 1;
      const failedChecks = Array.isArray(evt?.failedChecks) ? evt.failedChecks.map((x) => String(x)) : [];
      for (const chk of failedChecks) {
        counters.watchlist.momentumFailedChecksTop[chk] = Number(counters.watchlist.momentumFailedChecksTop[chk] || 0) + 1;
      }
      counters.watchlist.momentumFailedCheckExamples.push({
        t: evt?.timestamp,
        mint,
        checks: failedChecks.slice(0, 6),
        observed: evt?.observedMetrics || null,
      });
      if (counters.watchlist.momentumFailedCheckExamples.length > 10) {
        counters.watchlist.momentumFailedCheckExamples = counters.watchlist.momentumFailedCheckExamples.slice(-10);
      }
    }

    counters.watchlist.hotBypassTraceLast10 ||= [];
    const short = {
      t: evt?.timestamp,
      mint: evt?.mint,
      decision: evt?.bypassDecision,
      next: evt?.nextStageReached,
      final: evt?.finalPreMomentumRejectReason || null,
      momentum: !!evt?.momentumCounterIncremented,
      confirm: !!evt?.confirmCounterIncremented,
      liq: evt?.liquidityUsd ?? null,
    };
    counters.watchlist.hotBypassTraceLast10.push(short);
    if (counters.watchlist.hotBypassTraceLast10.length > 10) {
      counters.watchlist.hotBypassTraceLast10 = counters.watchlist.hotBypassTraceLast10.slice(-10);
    }
  };
  const emitHotBypassTrace = (evt) => {
    appendJsonl(hotBypassTracePath, evt);
    pushBypassTraceSummary(evt);
  };

  const ensureCompactWindowState = () => {
    counters.watchlist ||= {};
    state.runtime ||= {};
    state.runtime.compactWindow ||= counters.watchlist.compactWindow || {};
    counters.watchlist.compactWindow = state.runtime.compactWindow;
    const w = counters.watchlist.compactWindow;
    if (!Array.isArray(w.momentumRecent)) w.momentumRecent = [];
    if (!Array.isArray(w.momentumScoreSamples)) w.momentumScoreSamples = [];
    if (!Array.isArray(w.momentumInputSamples)) w.momentumInputSamples = [];
    if (!Array.isArray(w.momentumAgeSamples)) w.momentumAgeSamples = [];
    if (!Array.isArray(w.blockers)) w.blockers = [];
    if (!Array.isArray(w.watchlistSeen)) w.watchlistSeen = [];
    if (!Array.isArray(w.watchlistEvaluated)) w.watchlistEvaluated = [];
    if (!Array.isArray(w.momentumEval)) w.momentumEval = [];
    if (!Array.isArray(w.momentumPassed)) w.momentumPassed = [];
    if (!Array.isArray(w.momentumFailChecks)) w.momentumFailChecks = [];
    if (!Array.isArray(w.confirmReached)) w.confirmReached = [];
    if (!Array.isArray(w.confirmPassed)) w.confirmPassed = [];
    if (!Array.isArray(w.attempt)) w.attempt = [];
    if (!Array.isArray(w.fill)) w.fill = [];
    if (!Array.isArray(w.postMomentumFlow)) w.postMomentumFlow = [];
    if (!Array.isArray(w.momentumLiqValues)) w.momentumLiqValues = [];
    if (!Array.isArray(w.stalkableSeen)) w.stalkableSeen = [];
    if (!Array.isArray(w.scanCycles)) w.scanCycles = [];
    if (!Array.isArray(w.candidateSeen)) w.candidateSeen = [];
    if (!Array.isArray(w.candidateRouteable)) w.candidateRouteable = [];
    if (!Array.isArray(w.candidateLiquiditySeen)) w.candidateLiquiditySeen = [];
    if (!Array.isArray(w.repeatSuppressed)) w.repeatSuppressed = [];
    if (!Array.isArray(w.providerHealth)) w.providerHealth = [];
    if (!Array.isArray(w.hotBypass)) w.hotBypass = [];
    return w;
  };
  const pushCompactWindowEvent = (kind, reason = null, extra = null, opts = {}) => {
    const w = ensureCompactWindowState();
    const now = Number(opts?.tMs || nowMs || Date.now());
    const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
    const cutoff = now - retainMs;
    const shouldPersist = opts?.persist !== false;
    if (shouldPersist) {
      try {
        const persistKinds = new Set([
          'watchlistSeen',
          'watchlistEvaluated',
          'momentumEval',
          'momentumPassed',
          'momentumFailChecks',
          'momentumLiq',
          'momentumRecent',
          'momentumScoreSample',
          'momentumInputSample',
          'momentumAgeSample',
          'repeatSuppressed',
          'confirmReached',
          'confirmPassed',
          'attempt',
          'fill',
          'postMomentumFlow',
          'blocker',
          'stalkableSeen',
          'hotBypass',
          'providerHealth',
          'scanCycle',
          'candidateSeen',
          'candidateRouteable',
          'candidateLiquiditySeen',
        ]);
        if (persistKinds.has(String(kind || ''))) {
          appendDiagEvent({
            appendJsonl,
            statePath: cfg.STATE_PATH,
            event: { tMs: now, kind, reason: reason || null, extra: extra || null },
          });
        }
      } catch {}
    }
    const pushTs = (arr) => {
      arr.push(now);
      while (arr.length && Number(arr[0] || 0) < cutoff) arr.shift();
    };
    if (kind === 'blocker') {
      w.blockers.push({ tMs: now, reason: String(reason || 'unknown'), mint: String(extra?.mint || 'unknown'), stage: String(extra?.stage || 'unknown') });
      while (w.blockers.length && Number(w.blockers[0]?.tMs || 0) < cutoff) w.blockers.shift();
      return;
    }
    if (kind === 'momentumFailChecks') {
      w.momentumFailChecks.push({ tMs: now, checks: Array.isArray(extra?.checks) ? extra.checks.slice(0, 16) : [], mint: String(extra?.mint || 'unknown') });
      while (w.momentumFailChecks.length && Number(w.momentumFailChecks[0]?.tMs || 0) < cutoff) w.momentumFailChecks.shift();
      return;
    }
    if (kind === 'momentumLiq') {
      w.momentumLiqValues.push({ tMs: now, liqUsd: Number(extra?.liqUsd || 0) });
      while (w.momentumLiqValues.length && Number(w.momentumLiqValues[0]?.tMs || 0) < cutoff) w.momentumLiqValues.shift();
      return;
    }
    if (kind === 'stalkableSeen') {
      w.stalkableSeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
      while (w.stalkableSeen.length && Number(w.stalkableSeen[0]?.tMs || 0) < cutoff) w.stalkableSeen.shift();
      return;
    }
    if (kind === 'candidateSeen') {
      w.candidateSeen ||= [];
      w.candidateSeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
      while (w.candidateSeen.length && Number(w.candidateSeen[0]?.tMs || 0) < cutoff) w.candidateSeen.shift();
      return;
    }
    if (kind === 'candidateRouteable') {
      w.candidateRouteable ||= [];
      w.candidateRouteable.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
      while (w.candidateRouteable.length && Number(w.candidateRouteable[0]?.tMs || 0) < cutoff) w.candidateRouteable.shift();
      return;
    }
    if (kind === 'candidateLiquiditySeen') {
      w.candidateLiquiditySeen ||= [];
      w.candidateLiquiditySeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
      while (w.candidateLiquiditySeen.length && Number(w.candidateLiquiditySeen[0]?.tMs || 0) < cutoff) w.candidateLiquiditySeen.shift();
      return;
    }
    if (kind === 'scanCycle') {
      w.scanCycles.push({
        tMs: now,
        intervalMs: Number.isFinite(Number(extra?.intervalMs)) ? Number(extra.intervalMs) : null,
        durationMs: Number.isFinite(Number(extra?.durationMs)) ? Number(extra.durationMs) : null,
        candidatesFound: Number(extra?.candidatesFound || 0),
        watchlistIngest: Number(extra?.watchlistIngest || 0),
        pairFetchCalls: Number(extra?.pairFetchCalls || 0),
        birdeyeCalls: Number(extra?.birdeyeCalls || 0),
        rpcCalls: Number(extra?.rpcCalls || 0),
        maxSingleCallDurationMs: Number(extra?.maxSingleCallDurationMs || 0),
        candidateDiscoveryMs: Number(extra?.candidateDiscoveryMs || 0),
        candidateSourcePollingMs: Number(extra?.candidateSourcePollingMs || 0),
        candidateSourceMergingMs: Number(extra?.candidateSourceMergingMs || 0),
        candidateSourceTransformsMs: Number(extra?.candidateSourceTransformsMs || 0),
        candidateStreamDrainMs: Number(extra?.candidateStreamDrainMs || 0),
        candidateTokenlistFetchMs: Number(extra?.candidateTokenlistFetchMs || 0),
        candidateTokenlistPoolBuildMs: Number(extra?.candidateTokenlistPoolBuildMs || 0),
        candidateTokenlistSamplingMs: Number(extra?.candidateTokenlistSamplingMs || 0),
        candidateTokenlistQuoteabilityChecksMs: Number(extra?.candidateTokenlistQuoteabilityChecksMs || 0),
        tokenlistCandidatesFilteredByLiquidity: Number(extra?.tokenlistCandidatesFilteredByLiquidity || 0),
        tokenlistQuoteChecksPerformed: Number(extra?.tokenlistQuoteChecksPerformed || 0),
        tokenlistQuoteChecksSkipped: Number(extra?.tokenlistQuoteChecksSkipped || 0),
        candidateDedupeMs: Number(extra?.candidateDedupeMs || 0),
        candidateIterationMs: Number(extra?.candidateIterationMs || 0),
        candidateStateLookupMs: Number(extra?.candidateStateLookupMs || 0),
        candidateCacheReadsMs: Number(extra?.candidateCacheReadsMs || 0),
        candidateCacheWritesMs: Number(extra?.candidateCacheWritesMs || 0),
        candidateFilterLoopsMs: Number(extra?.candidateFilterLoopsMs || 0),
        candidateAsyncWaitUnclassifiedMs: Number(extra?.candidateAsyncWaitUnclassifiedMs || 0),
        candidateCooldownFilteringMs: Number(extra?.candidateCooldownFilteringMs || 0),
        candidateShortlistPrefilterMs: Number(extra?.candidateShortlistPrefilterMs || 0),
        candidateRouteabilityChecksMs: Number(extra?.candidateRouteabilityChecksMs || 0),
        candidateOtherMs: Number(extra?.candidateOtherMs || 0),
        snapshotBuildMs: Number(extra?.snapshotBuildMs || 0),
        snapshotBirdseyeFetchMs: Number(extra?.snapshotBirdseyeFetchMs || 0),
        snapshotPairEnrichmentMs: Number(extra?.snapshotPairEnrichmentMs || 0),
        snapshotLiqMcapNormalizationMs: Number(extra?.snapshotLiqMcapNormalizationMs || 0),
        snapshotValidationMs: Number(extra?.snapshotValidationMs || 0),
        snapshotWatchlistRowConstructionMs: Number(extra?.snapshotWatchlistRowConstructionMs || 0),
        snapshotOtherMs: Number(extra?.snapshotOtherMs || 0),
        totalWorkMs: Number(extra?.totalWorkMs || 0),
        totalCycleMs: Number(extra?.totalCycleMs || 0),
        scanAggregateTaskMs: Number(extra?.scanAggregateTaskMs || 0),
        scanWallClockMs: Number(extra?.scanWallClockMs || 0),
      });
      while (w.scanCycles.length && Number(w.scanCycles[0]?.tMs || 0) < cutoff) w.scanCycles.shift();
      return;
    }
    if (kind === 'repeatSuppressed') {
      w.repeatSuppressed.push({ tMs: now, mint: String(extra?.mint || 'unknown'), reason: String(extra?.reason || 'unknown') });
      while (w.repeatSuppressed.length && Number(w.repeatSuppressed[0]?.tMs || 0) < cutoff) w.repeatSuppressed.shift();
      return;
    }
    if (kind === 'providerHealth') {
      w.providerHealth.push({ tMs: now, provider: String(extra?.provider || 'unknown'), outcome: String(extra?.outcome || 'unknown') });
      while (w.providerHealth.length && Number(w.providerHealth[0]?.tMs || 0) < cutoff) w.providerHealth.shift();
      return;
    }
    if (kind === 'hotBypass') {
      w.hotBypass.push({ tMs: now, mint: String(extra?.mint || 'unknown'), decision: String(extra?.decision || 'unknown'), primary: String(extra?.primary || 'unknown') });
      while (w.hotBypass.length && Number(w.hotBypass[0]?.tMs || 0) < cutoff) w.hotBypass.shift();
      return;
    }
    if (kind === 'momentumRecent') {
      w.momentumRecent.push({
        tMs: now,
        mint: String(extra?.mint || 'unknown'),
        liq: Number(extra?.liq || 0),
        mcap: Number(extra?.mcap || 0),
        ageMin: Number.isFinite(extra?.ageMin) ? Number(extra.ageMin) : null,
        agePresent: !!extra?.agePresent,
        early: !!extra?.early,
        branch: String(extra?.branch || 'mature_3_of_4'),
        v5: Number.isFinite(Number(extra?.v5)) ? Number(extra.v5) : null,
        v30: Number.isFinite(Number(extra?.v30)) ? Number(extra.v30) : null,
        volStrength: Number.isFinite(Number(extra?.volStrength)) ? Number(extra.volStrength) : null,
        volumeSource: String(extra?.volumeSource || 'unknown'),
        volumeFallback: !!extra?.volumeFallback,
        walletExpansion: Number.isFinite(Number(extra?.walletExpansion)) ? Number(extra.walletExpansion) : null,
        buyers1m: Number.isFinite(Number(extra?.buyers1m)) ? Number(extra.buyers1m) : null,
        buyers5mAvg: Number.isFinite(Number(extra?.buyers5mAvg)) ? Number(extra.buyers5mAvg) : null,
        hardRejects: Array.isArray(extra?.hardRejects) ? extra.hardRejects.slice(0, 6).map(String) : [],
        tx1m: Number.isFinite(Number(extra?.tx1m)) ? Number(extra.tx1m) : null,
        tx5mAvg: Number.isFinite(Number(extra?.tx5mAvg)) ? Number(extra.tx5mAvg) : null,
        tx30mAvg: Number.isFinite(Number(extra?.tx30mAvg)) ? Number(extra.tx30mAvg) : null,
        momentumScore: Number.isFinite(Number(extra?.momentumScore)) ? Number(extra.momentumScore) : null,
        momentumScoreThreshold: Number.isFinite(Number(extra?.momentumScoreThreshold)) ? Number(extra.momentumScoreThreshold) : null,
        momentumScoreBand: String(extra?.momentumScoreBand || 'unknown'),
        topScoreContributors: Array.isArray(extra?.topScoreContributors) ? extra.topScoreContributors.slice(0, 5).map((x) => ({ name: String(x?.name || 'unknown'), score: Number(x?.score || 0) })) : [],
        topPenaltyContributors: Array.isArray(extra?.topPenaltyContributors) ? extra.topPenaltyContributors.slice(0, 5).map((x) => ({ name: String(x?.name || 'unknown'), penalty: Number(x?.penalty || 0) })) : [],
        final: String(extra?.final || 'passed'),
      });
      while (w.momentumRecent.length && Number(w.momentumRecent[0]?.tMs || 0) < cutoff) w.momentumRecent.shift();
      return;
    }
    if (kind === 'momentumScoreSample') {
      w.momentumScoreSamples.push({
        tMs: now,
        mint: String(extra?.mint || 'unknown'),
        momentumScore: Number.isFinite(Number(extra?.momentumScore)) ? Number(extra.momentumScore) : null,
        momentumScoreThreshold: Number.isFinite(Number(extra?.momentumScoreThreshold)) ? Number(extra.momentumScoreThreshold) : null,
        momentumScoreBand: String(extra?.momentumScoreBand || 'unknown'),
        topScoreContributors: Array.isArray(extra?.topScoreContributors) ? extra.topScoreContributors.slice(0, 5).map((x) => ({ name: String(x?.name || 'unknown'), score: Number(x?.score || 0) })) : [],
        topPenaltyContributors: Array.isArray(extra?.topPenaltyContributors) ? extra.topPenaltyContributors.slice(0, 5).map((x) => ({ name: String(x?.name || 'unknown'), penalty: Number(x?.penalty || 0) })) : [],
        final: String(extra?.final || 'unknown'),
      });
      while (w.momentumScoreSamples.length && Number(w.momentumScoreSamples[0]?.tMs || 0) < cutoff) w.momentumScoreSamples.shift();
      return;
    }
    if (kind === 'momentumInputSample') {
      w.momentumInputSamples.push({
        tMs: now,
        mint: String(extra?.mint || 'unknown'),
        liq: Number(extra?.liq || 0),
        v5: Number(extra?.v5 || 0),
        v30: Number(extra?.v30 || 0),
        volStrength: Number.isFinite(Number(extra?.volStrength)) ? Number(extra.volStrength) : null,
        volumeSource: String(extra?.volumeSource || 'unknown'),
        volumeFallback: !!extra?.volumeFallback,
        walletExpansion: Number.isFinite(Number(extra?.walletExpansion)) ? Number(extra.walletExpansion) : null,
        buyers1m: Number.isFinite(Number(extra?.buyers1m)) ? Number(extra.buyers1m) : null,
        buyers5mAvg: Number.isFinite(Number(extra?.buyers5mAvg)) ? Number(extra.buyers5mAvg) : null,
        bsr: Number(extra?.bsr || 0),
        tx1m: Number(extra?.tx1m || 0),
        tx5mAvg: Number(extra?.tx5mAvg || 0),
        tx30mAvg: Number(extra?.tx30mAvg || 0),
        txThreshold: Number.isFinite(Number(extra?.txThreshold)) ? Number(extra.txThreshold) : null,
        volThreshold: Number.isFinite(Number(extra?.volThreshold)) ? Number(extra.volThreshold) : null,
        walletThreshold: Number.isFinite(Number(extra?.walletThreshold)) ? Number(extra.walletThreshold) : null,
        hardRejects: Array.isArray(extra?.hardRejects) ? extra.hardRejects.slice(0, 6).map(String) : [],
        fail: String(extra?.fail || 'none'),
      });
      while (w.momentumInputSamples.length && Number(w.momentumInputSamples[0]?.tMs || 0) < cutoff) w.momentumInputSamples.shift();
      return;
    }
    if (kind === 'momentumAgeSample') {
      w.momentumAgeSamples.push({
        tMs: now,
        mint: String(extra?.mint || 'unknown'),
        ageMin: Number.isFinite(extra?.ageMin) ? Number(extra.ageMin) : null,
        early: !!extra?.early,
        source: String(extra?.source || 'missing'),
        branch: String(extra?.branch || 'mature_3_of_4'),
        fail: String(extra?.fail || 'none'),
      });
      while (w.momentumAgeSamples.length && Number(w.momentumAgeSamples[0]?.tMs || 0) < cutoff) w.momentumAgeSamples.shift();
      return;
    }
    if (kind === 'postMomentumFlow') {
      w.postMomentumFlow.push({
        tMs: now,
        mint: String(extra?.mint || 'unknown'),
        liq: Number(extra?.liq || 0),
        mcap: Number(extra?.mcap || 0),
        ageMin: Number.isFinite(extra?.ageMin) ? Number(extra.ageMin) : null,
        freshnessMs: Number.isFinite(Number(extra?.freshnessMs)) ? Number(extra.freshnessMs) : null,
        priceImpactPct: Number.isFinite(Number(extra?.priceImpactPct)) ? Number(extra.priceImpactPct) : null,
        slippageBps: Number.isFinite(Number(extra?.slippageBps)) ? Number(extra.slippageBps) : null,
        sendToFillMs: Number.isFinite(Number(extra?.sendToFillMs)) ? Number(extra.sendToFillMs) : null,
        totalAttemptToFillMs: Number.isFinite(Number(extra?.totalAttemptToFillMs)) ? Number(extra.totalAttemptToFillMs) : null,
        quoteAgeMs: Number.isFinite(Number(extra?.quoteAgeMs)) ? Number(extra.quoteAgeMs) : null,
        txAccelObserved: Number.isFinite(Number(extra?.txAccelObserved)) ? Number(extra.txAccelObserved) : null,
        txAccelThreshold: Number.isFinite(Number(extra?.txAccelThreshold)) ? Number(extra.txAccelThreshold) : null,
        txAccelMissDistance: Number.isFinite(Number(extra?.txAccelMissDistance)) ? Number(extra.txAccelMissDistance) : null,
        tx1m: Number.isFinite(Number(extra?.tx1m)) ? Number(extra.tx1m) : null,
        tx5mAvg: Number.isFinite(Number(extra?.tx5mAvg)) ? Number(extra.tx5mAvg) : null,
        tx30mAvg: Number.isFinite(Number(extra?.tx30mAvg)) ? Number(extra.tx30mAvg) : null,
        buySellRatioObserved: Number.isFinite(Number(extra?.buySellRatioObserved)) ? Number(extra.buySellRatioObserved) : null,
        buySellThreshold: Number.isFinite(Number(extra?.buySellThreshold)) ? Number(extra.buySellThreshold) : null,
        txMetricSource: String(extra?.txMetricSource || 'unknown'),
        txMetricMissing: !!extra?.txMetricMissing,
        carryPresent: !!extra?.carryPresent,
        carryTx1m: Number.isFinite(Number(extra?.carryTx1m)) ? Number(extra.carryTx1m) : null,
        carryTx5mAvg: Number.isFinite(Number(extra?.carryTx5mAvg)) ? Number(extra.carryTx5mAvg) : null,
        carryTx30mAvg: Number.isFinite(Number(extra?.carryTx30mAvg)) ? Number(extra.carryTx30mAvg) : null,
        carryBuySellRatio: Number.isFinite(Number(extra?.carryBuySellRatio)) ? Number(extra.carryBuySellRatio) : null,
        continuationMode: !!extra?.continuationMode,
        continuationPassReason: String(extra?.continuationPassReason || 'none'),
        continuationStartPrice: Number.isFinite(Number(extra?.continuationStartPrice)) ? Number(extra.continuationStartPrice) : null,
        continuationHighPrice: Number.isFinite(Number(extra?.continuationHighPrice)) ? Number(extra.continuationHighPrice) : null,
        continuationLowPrice: Number.isFinite(Number(extra?.continuationLowPrice)) ? Number(extra.continuationLowPrice) : null,
        continuationFinalPrice: Number.isFinite(Number(extra?.continuationFinalPrice)) ? Number(extra.continuationFinalPrice) : null,
        continuationMaxRunupPct: Number.isFinite(Number(extra?.continuationMaxRunupPct)) ? Number(extra.continuationMaxRunupPct) : null,
        continuationMaxDipPct: Number.isFinite(Number(extra?.continuationMaxDipPct)) ? Number(extra.continuationMaxDipPct) : null,
        continuationTimeToRunupPassMs: Number.isFinite(Number(extra?.continuationTimeToRunupPassMs)) ? Number(extra.continuationTimeToRunupPassMs) : null,
        continuationTimeoutWasFlatOrNegative: !!extra?.continuationTimeoutWasFlatOrNegative,
        continuationConfirmStartLiqUsd: Number.isFinite(Number(extra?.continuationConfirmStartLiqUsd)) ? Number(extra.continuationConfirmStartLiqUsd) : null,
        continuationCurrentLiqUsd: Number.isFinite(Number(extra?.continuationCurrentLiqUsd)) ? Number(extra.continuationCurrentLiqUsd) : null,
        continuationLiqChangePct: Number.isFinite(Number(extra?.continuationLiqChangePct)) ? Number(extra.continuationLiqChangePct) : null,
        continuationPriceSource: String(extra?.continuationPriceSource || 'unknown'),
        continuationInitialSourceUsed: String(extra?.continuationInitialSourceUsed || 'unknown'),
        continuationDominantSourceUsed: String(extra?.continuationDominantSourceUsed || 'unknown'),
        continuationConfirmStartedAtMs: Number.isFinite(Number(extra?.continuationConfirmStartedAtMs)) ? Number(extra.continuationConfirmStartedAtMs) : null,
        continuationWsUpdateCountWithinWindow: Number(extra?.continuationWsUpdateCountWithinWindow || 0) || 0,
        continuationUniqueOhlcvTicksWithinWindow: Number(extra?.continuationUniqueOhlcvTicksWithinWindow || 0) || 0,
        continuationTradeUpdateCountWithinWindow: Number(extra?.continuationTradeUpdateCountWithinWindow || 0) || 0,
        continuationUniqueTradeTicksWithinWindow: Number(extra?.continuationUniqueTradeTicksWithinWindow || 0) || 0,
        continuationRunupSourceUsed: String(extra?.continuationRunupSourceUsed || 'no_runup'),
        continuationTradeSequenceSourceUsed: String(extra?.continuationTradeSequenceSourceUsed || 'ws_trade'),
        continuationTradeTickCountAtRunupMoment: Number(extra?.continuationTradeTickCountAtRunupMoment || 0) || 0,
        continuationTradeSequenceEligibleAtRunup: !!extra?.continuationTradeSequenceEligibleAtRunup,
        continuationMaxConsecutiveTradeUpticks: Number(extra?.continuationMaxConsecutiveTradeUpticks || 0) || 0,
        continuationMinConsecutiveTradeUpticks: Number(extra?.continuationMinConsecutiveTradeUpticks || 0) || 0,
        continuationRequireTradeUpticks: !!extra?.continuationRequireTradeUpticks,
        continuationSelectedTradeReads: Number(extra?.continuationSelectedTradeReads || 0) || 0,
        continuationSelectedOhlcvReads: Number(extra?.continuationSelectedOhlcvReads || 0) || 0,
        continuationWsUpdateTimestamps: Array.isArray(extra?.continuationWsUpdateTimestamps) ? extra.continuationWsUpdateTimestamps.slice(0, 24) : [],
        continuationWsUpdatePrices: Array.isArray(extra?.continuationWsUpdatePrices) ? extra.continuationWsUpdatePrices.slice(0, 24) : [],
        continuationTradeUpdateTimestamps: Array.isArray(extra?.continuationTradeUpdateTimestamps) ? extra.continuationTradeUpdateTimestamps.slice(0, 24) : [],
        continuationTradeUpdatePrices: Array.isArray(extra?.continuationTradeUpdatePrices) ? extra.continuationTradeUpdatePrices.slice(0, 24) : [],
        stage: String(extra?.stage || 'unknown'),
        outcome: String(extra?.outcome || 'unknown'),
        reason: String(extra?.reason || 'none'),
      });
      while (w.postMomentumFlow.length && Number(w.postMomentumFlow[0]?.tMs || 0) < cutoff) w.postMomentumFlow.shift();
      return;
    }
    if (Array.isArray(w[kind])) pushTs(w[kind]);
  };

  const repeatFailWindowSec = 180;
  const repeatFailCooldownSec = 120;
  const repeatEscalationWindowSec = 900;
  const repeatEscalationHits = 3;
  const repeatEscalationCooldownSec = 900;
  const repeatImprovementDelta = 0.02;
  state.runtime ||= {};
  state.runtime.momentumRepeatFail ||= {};
  pruneMomentumRepeatFailMap(state.runtime.momentumRepeatFail, {
    nowMs,
    staleAfterMs: Math.max(30 * 60_000, repeatEscalationWindowSec * 2 * 1000),
    maxEntries: 5000,
  });

  for (const [mint, row, isHot] of rows) {
    const isCanary = canary?.enabled === true && canary?.mint === mint;
    const canaryLog = (stage, detail) => {
      if (!isCanary || !canary?.verbose) return;
      pushDebug(state, { t: nowIso(), mint, symbol: row?.pair?.baseToken?.symbol || null, reason: `canary:${stage}${detail ? `(${detail})` : ''}` });
    };
    const canaryRecord = (stage, reason, meta = null) => {
      if (!isCanary) return;
      if (typeof canary?.record === 'function') return canary.record(stage, reason, mint, meta);
      if (typeof canary?.recordOnce === 'function') return canary.recordOnce(stage, reason, mint, meta);
    };

    const ctx = {
      cfg,
      state,
      counters,
      nowMs,
      executionAllowed,
      executionAllowedReason,
      solUsdNow,
      conn,
      pub,
      wallet,
      birdseye,
      immediateMode,
      canary,
      deps: {
        confirmQualityGate,
        confirmContinuationGate,
        recordConfirmCarryTrace,
        resolveConfirmTxMetrics,
        resolveMintCreatedAtFromRpc,
        computeMcapUsd,
        openPosition,
        wsmgr,
      },
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
      paperModeActive,
      hotBypassTracePath,
      emitHotBypassTrace,
      pushCompactWindowEvent,
      mint,
      row,
      isHot,
      isCanary,
      canaryLog,
      canaryRecord,
      repeatFailWindowSec,
      repeatFailCooldownSec,
      repeatEscalationWindowSec,
      repeatEscalationHits,
      repeatEscalationCooldownSec,
      repeatImprovementDelta,
      momentumPassedThisEval: false,
      confirmReachedThisEval: false,
      attemptReachedThisEval: false,
      pair: row?.pair || null,
      snapshot: row?.snapshot || null,
      birdseyeSnapshot: null,
      hotBypassTraceCtx: null,
      enrichedRefreshUsed: false,
      enrichedRetryUsed: false,
      wasRouteAvailableOnly: false,
      hotMomentumMinLiqUsd: Number(cfg.HOT_MOMENTUM_MIN_LIQ_USD || 40_000),
      mcapHot: null,
      mcapSourceUsed: 'missing',
      liqUsd: null,
      agePicked: { value: null, source: 'missing' },
      tokenAgeMinutes: null,
      agePresent: false,
      matureTokenMode: false,
      earlyTokenMode: false,
      breakoutBranchUsed: 'mature_3_of_4',
      report: null,
      mcap: { ok: true, reason: 'skipped', mcapUsd: null, decimals: null },
      mcapComputed: { ok: false, reason: 'not_attempted', mcapUsd: null, decimals: null },
      preConfirmMcapSourceUsed: 'missing',
      expectedOutAmount: null,
      expectedInAmount: null,
      confirmPriceImpactPct: null,
      confirmSlippageBps: Number(cfg.DEFAULT_SLIPPAGE_BPS || 0),
      usedRouteCacheForAttempt: false,
      finalUsdTarget: null,
      solLamportsFinal: null,
      routeMeta: null,
      carryObj: null,
      carryPresent: false,
      confirmSigReasons: null,
      confirmGate: null,
      continuationActive: false,
      retryImprovedThisPass: false,
      retryGate: null,
      liqForEntry: null,
      liqForAttempt: null,
      mcapForEntry: null,
      attemptMinLiqUsd: null,
      attemptOutcome: null,
      attemptEnteredAtMs: null,
      swapSubmittedAtMs: null,
      quoteAgeMs: null,
      quoteBuilt: false,
      quoteRefreshed: false,
      routeSource: 'unknown',
      pushExecutionPath: () => {},
      pushAttemptBranchDebug: () => {},
    };

    const isDataThinSnapshot = (snap) => {
      const source = String(snap?.source || row?.latest?.marketDataSource || '').toLowerCase();
      const freshnessMs = Number(snap?.freshnessMs ?? row?.latest?.marketDataFreshnessMs ?? NaN);
      const hasLiq = Number(snap?.liquidityUsd ?? row?.latest?.liqUsd ?? 0) > 0;
      const hasMcap = Number(snap?.marketCapUsd ?? row?.latest?.mcapUsd ?? 0) > 0;
      const hasAge = Number(snap?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0) > 0;
      const stale = Number.isFinite(freshnessMs) && freshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000);
      return source === 'routeavailableonly' || !hasLiq || !hasMcap || !hasAge || stale;
    };

    ctx.finalizeHotBypassTrace = ({ nextStageReached, finalPreMomentumRejectReason = null, momentumCounterIncremented = false, confirmCounterIncremented = false, extra = null }) => {
      if (!ctx.hotBypassTraceCtx) return;
      emitHotBypassTrace({
        ...ctx.hotBypassTraceCtx,
        ...(extra && typeof extra === 'object' ? extra : {}),
        nextStageReached,
        finalPreMomentumRejectReason,
        momentumCounterIncremented,
        confirmCounterIncremented,
      });
      ctx.hotBypassTraceCtx = null;
    };
    ctx.tryHotEnrichedRefresh = async (reasonKey) => {
      if (ctx.enrichedRetryUsed) return false;
      if (!(birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function')) return false;
      if (!isDataThinSnapshot(ctx.snapshot)) return false;

      ctx.enrichedRetryUsed = true;
      counters.watchlist.hotEnrichedRefreshAttempted = Number(counters.watchlist.hotEnrichedRefreshAttempted || 0) + 1;
      counters.watchlist.hotEnrichedRefreshReason ||= {};
      counters.watchlist.hotEnrichedRefreshReason[reasonKey] = Number(counters.watchlist.hotEnrichedRefreshReason[reasonKey] || 0) + 1;

      try {
        const bird = await birdseye.getTokenSnapshot(mint);
        const birdSnap = snapshotFromBirdseye(bird, Date.now());
        if (!birdSnap) return false;
        ctx.snapshot = birdSnap;
        row.snapshot = birdSnap;
        applySnapshotToLatest({ row, snapshot: birdSnap });
        ctx.enrichedRefreshUsed = true;
        return true;
      } catch {
        return false;
      }
    };
    ctx.bumpPostBypassReject = (k) => {
      if (!row?.meta?.hotMomentumOnlyLiquidityBypass) return;
      counters.watchlist.hotPostBypassRejected ||= {};
      counters.watchlist.hotPostBypassRejected[k] = Number(counters.watchlist.hotPostBypassRejected[k] || 0) + 1;
    };
    ctx.fail = (reason, { stage = 'gate', breakLoop = false, cooldownMs = 0, meta = null } = {}) => {
      const reasonCode = `${stage}.${reason}`;
      bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: reasonCode });
      pushCompactWindowEvent('blocker', reasonCode, { mint, stage });
      if (ctx.momentumPassedThisEval && !ctx.confirmReachedThisEval) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(ctx.snapshot?.liquidityUsd ?? ctx.pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(ctx.mcapHot ?? row?.latest?.mcapUsd ?? ctx.snapshot?.marketCapUsd ?? ctx.pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(ctx.snapshot?.pairCreatedAt ?? ctx.snapshot?.pair?.pairCreatedAt ?? ctx.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
          stage: 'preConfirm',
          outcome: 'rejected',
          reason: reasonCode,
          ...(meta && typeof meta === 'object' ? meta : {}),
        });
      } else if (ctx.confirmReachedThisEval && !ctx.attemptReachedThisEval && ['confirm', 'attempt', 'swap'].includes(String(stage || ''))) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(ctx.snapshot?.liquidityUsd ?? ctx.pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(ctx.mcapHot ?? row?.latest?.mcapUsd ?? ctx.snapshot?.marketCapUsd ?? ctx.pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(ctx.snapshot?.pairCreatedAt ?? ctx.snapshot?.pair?.pairCreatedAt ?? ctx.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
          stage,
          outcome: 'rejected',
          reason: reasonCode,
          ...(meta && typeof meta === 'object' ? meta : {}),
        });
      } else if (ctx.attemptReachedThisEval && ['attempt', 'swap'].includes(String(stage || ''))) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(ctx.snapshot?.liquidityUsd ?? ctx.pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(ctx.mcapHot ?? row?.latest?.mcapUsd ?? ctx.snapshot?.marketCapUsd ?? ctx.pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(ctx.snapshot?.pairCreatedAt ?? ctx.snapshot?.pair?.pairCreatedAt ?? ctx.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
          stage: 'attempt',
          outcome: 'rejected',
          reason: reasonCode,
          ...(meta && typeof meta === 'object' ? meta : {}),
        });
      }
      if (reasonCode === 'momentum.momentumFailed') pushCompactWindowEvent('momentumEval');
      if (immediateMode) bumpImmediateBlockedReason(counters, reasonCode);
      if (cooldownMs > 0) row.cooldownUntilMs = nowMs + cooldownMs;
      canaryLog('blocked', reasonCode);
      canaryRecord(stage, reason, meta);
      return breakLoop ? 'break' : 'continue';
    };

    const preflightAction = await runRowPreflightStage(ctx);
    if (preflightAction === 'break') break;
    if (preflightAction === 'continue') continue;

    const momentumAction = await runMomentumEvalStage(ctx);
    if (momentumAction === 'break') break;
    if (momentumAction === 'continue') continue;

    const confirmAction = await runConfirmContinuationStage(ctx);
    if (confirmAction === 'break') break;
    if (confirmAction === 'continue') continue;

    const attemptAction = await runAttemptPolicyAndEntryStage(ctx);
    if (attemptAction === 'break') break;
    if (attemptAction === 'continue') continue;
    if (attemptAction === 'postAttempt') {
      await runPostAttemptOutcomesStage(ctx);
    }
  }
}
