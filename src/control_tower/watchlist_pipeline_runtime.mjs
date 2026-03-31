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
      const failedChecks = Array.isArray(evt?.failedChecks) ? evt.failedChecks.map(x => String(x)) : [];
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
          'scanCycle',
          'candidateSeen',
          'candidateRouteable',
          'candidateLiquiditySeen',
        ]);
        if (persistKinds.has(String(kind || ''))) {
          appendJsonl(path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl'), { tMs: now, kind, reason: reason || null, extra: extra || null });
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
  const repeatImprovementDelta = 0.05;
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

    canaryLog('seen', immediateMode ? 'immediate' : 'scheduled');
    if (isHot) counters.watchlist.hotConsumed += 1;
    bumpWatchlistFunnel(counters, 'watchlistSeen', { nowMs });
    pushCompactWindowEvent('watchlistSeen');

    const lastEvalMs = Number(row?.lastEvaluatedAtMs || 0);
    const preRunnerFastMinMs = Number(cfg.PRE_RUNNER_EVAL_MIN_MS || 500);
    const preRunnerFastMaxMs = Number(cfg.PRE_RUNNER_EVAL_MAX_MS || preRunnerFastMinMs);
    const preRunnerMeta = row?.meta?.preRunner || null;
    const burstMeta = row?.meta?.burst || null;
    const preRunnerFastActive = !!(preRunnerMeta?.active && Number(preRunnerMeta?.fastUntilMs || 0) > nowMs);
    const burstFastMinMs = Number(cfg.BURST_EVAL_MIN_MS || 500);
    const burstFastMaxMs = Number(cfg.BURST_EVAL_MAX_MS || burstFastMinMs);
    const burstFastActive = !!(burstMeta?.active && Number(burstMeta?.fastUntilMs || 0) > nowMs);
    if (preRunnerMeta?.active && Number(preRunnerMeta?.fastUntilMs || 0) > 0 && Number(preRunnerMeta?.fastUntilMs || 0) <= nowMs) {
      row.meta.preRunner.active = false;
      counters.watchlist.preRunnerExpired = Number(counters.watchlist.preRunnerExpired || 0) + 1;
    }
    if (burstMeta?.active && Number(burstMeta?.fastUntilMs || 0) > 0 && Number(burstMeta?.fastUntilMs || 0) <= nowMs) {
      row.meta.burst.active = false;
      counters.watchlist.burstExpired = Number(counters.watchlist.burstExpired || 0) + 1;
    }
    const minGapMs = (preRunnerFastActive || burstFastActive)
      ? Math.max(500, Math.round((preRunnerFastActive ? preRunnerFastMinMs : burstFastMinMs) + (Math.random() * ((preRunnerFastActive ? preRunnerFastMaxMs : burstFastMaxMs) - (preRunnerFastActive ? preRunnerFastMinMs : burstFastMinMs)))))
      : (isHot
        ? Math.max(500, Math.round(cfg.HOT_EVAL_MIN_MS + (Math.random() * (Math.max(cfg.HOT_EVAL_MAX_MS, cfg.HOT_EVAL_MIN_MS) - cfg.HOT_EVAL_MIN_MS))))
        : Math.max(15_000, Math.round(cfg.COLD_EVAL_MIN_MS + (Math.random() * (Math.max(cfg.COLD_EVAL_MAX_MS, cfg.COLD_EVAL_MIN_MS) - cfg.COLD_EVAL_MIN_MS)))));
    if (lastEvalMs && (nowMs - lastEvalMs) < minGapMs) {
      continue;
    }

    counters.watchlist.evals += 1;
    row.lastEvaluatedAtMs = nowMs;
    row.staleCycles = Number(row.staleCycles || 0) + 1;

    let momentumPassedThisEval = false;
    let confirmReachedThisEval = false;
    let attemptReachedThisEval = false;

    const fail = (reason, { stage = 'gate', breakLoop = false, cooldownMs = 0, meta = null } = {}) => {
      const reasonCode = `${stage}.${reason}`;
      bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: reasonCode });
      pushCompactWindowEvent('blocker', reasonCode, { mint, stage });
      if (momentumPassedThisEval && !confirmReachedThisEval) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(snapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(mcapHot ?? row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(snapshot?.pairCreatedAt ?? snapshot?.pair?.pairCreatedAt ?? pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
          stage: 'preConfirm',
          outcome: 'rejected',
          reason: reasonCode,
          ...(meta && typeof meta === 'object' ? meta : {}),
        });
      } else if (confirmReachedThisEval && !attemptReachedThisEval && ['confirm', 'attempt', 'swap'].includes(String(stage || ''))) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(snapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(mcapHot ?? row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(snapshot?.pairCreatedAt ?? snapshot?.pair?.pairCreatedAt ?? pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
          stage,
          outcome: 'rejected',
          reason: reasonCode,
          ...(meta && typeof meta === 'object' ? meta : {}),
        });
      } else if (attemptReachedThisEval && ['attempt', 'swap'].includes(String(stage || ''))) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(snapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0),
          mcap: Number(mcapHot ?? row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? 0),
          ageMin: (() => {
            const created = normalizeEpochMs(snapshot?.pairCreatedAt ?? snapshot?.pair?.pairCreatedAt ?? pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0);
            return created ? Math.max(0, (nowMs - created) / 60_000) : null;
          })(),
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
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

    if (Number(row.cooldownUntilMs || 0) > nowMs) {
      if (!(cfg.CONVERSION_CANARY_MODE && isCanary)) {
        if (fail('cooldown', { stage: 'precheck' }) === 'break') break;
        continue;
      }
    }
    if (executionAllowed && !entryCapacityAvailable(state, cfg)) {
      if (fail('maxPositions', { stage: 'precheck', breakLoop: true }) === 'break') break;
      continue;
    }
    if (state.positions[mint]?.status === 'open') {
      if (fail('alreadyOpen', { stage: 'precheck' }) === 'break') break;
      continue;
    }

    let pair = row.pair || null;
    let snapshot = row.snapshot || null;
    const wasRouteAvailableOnly = String(row?.latest?.marketDataSource || row?.snapshot?.source || '').toLowerCase() === 'routeavailableonly';
    const hotMomentumMinLiqUsd = Number(cfg.HOT_MOMENTUM_MIN_LIQ_USD || 40_000);
    let hotBypassTraceCtx = null;
    const finalizeHotBypassTrace = ({ nextStageReached, finalPreMomentumRejectReason = null, momentumCounterIncremented = false, confirmCounterIncremented = false, extra = null }) => {
      if (!hotBypassTraceCtx) return;
      emitHotBypassTrace({
        ...hotBypassTraceCtx,
        ...(extra && typeof extra === 'object' ? extra : {}),
        nextStageReached,
        finalPreMomentumRejectReason,
        momentumCounterIncremented,
        confirmCounterIncremented,
      });
      hotBypassTraceCtx = null;
    };
    row.meta ||= {};
    row.meta.hotMomentumOnlyLiquidityBypass = false;
    let enrichedRefreshUsed = false;
    let enrichedRetryUsed = false;

    const isDataThinSnapshot = (snap) => {
      const source = String(snap?.source || row?.latest?.marketDataSource || '').toLowerCase();
      const freshnessMs = Number(snap?.freshnessMs ?? row?.latest?.marketDataFreshnessMs ?? NaN);
      const hasLiq = Number(snap?.liquidityUsd ?? row?.latest?.liqUsd ?? 0) > 0;
      const hasMcap = Number(snap?.marketCapUsd ?? row?.latest?.mcapUsd ?? 0) > 0;
      const hasAge = Number(snap?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0) > 0;
      const stale = Number.isFinite(freshnessMs) && freshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000);
      return source === 'routeavailableonly' || !hasLiq || !hasMcap || !hasAge || stale;
    };

    const tryHotEnrichedRefresh = async (reasonKey) => {
      if (enrichedRetryUsed) return false;
      if (!(birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function')) return false;
      if (!isDataThinSnapshot(snapshot)) return false;

      enrichedRetryUsed = true;
      counters.watchlist.hotEnrichedRefreshAttempted = Number(counters.watchlist.hotEnrichedRefreshAttempted || 0) + 1;
      counters.watchlist.hotEnrichedRefreshReason ||= {};
      counters.watchlist.hotEnrichedRefreshReason[reasonKey] = Number(counters.watchlist.hotEnrichedRefreshReason[reasonKey] || 0) + 1;

      try {
        const bird = await birdseye.getTokenSnapshot(mint);
        const birdSnap = snapshotFromBirdseye(bird, Date.now());
        if (!birdSnap) return false;
        snapshot = birdSnap;
        row.snapshot = birdSnap;
        applySnapshotToLatest({ row, snapshot: birdSnap });
        enrichedRefreshUsed = true;
        return true;
      } catch {
        return false;
      }
    };

    let birdseyeSnapshot = null;
    const snapshotLooksUnsafe = !snapshot?.priceUsd || !isEntrySnapshotSafe(snapshot);
    if (snapshotLooksUnsafe && birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
      try {
        const bird = await birdseye.getTokenSnapshot(mint);
        const birdSnap = snapshotFromBirdseye(bird, nowMs);
        if (birdSnap) {
          birdseyeSnapshot = birdSnap;
          snapshot = birdSnap;
          row.snapshot = birdSnap;
        }
      } catch {}
    }

    let snapshotStatus = getSnapshotStatus({ snapshot, birdseyeSnapshot });
    if (snapshotStatus.snapshotStatus !== 'safe') {
      let unsafeReason = getWatchlistEntrySnapshotUnsafeReason({ snapshot, birdseyeSnapshot });
      const shouldEnrich = unsafeReason === 'unsafeSnapshot.liquidityBelowThreshold' || unsafeReason === 'unsafeSnapshot.birdeyeStale';
      if (shouldEnrich) {
        const refreshed = await tryHotEnrichedRefresh(unsafeReason === 'unsafeSnapshot.liquidityBelowThreshold' ? 'liquidity' : 'staleData');
        if (refreshed) {
          snapshotStatus = getSnapshotStatus({ snapshot, birdseyeSnapshot: snapshot });
          unsafeReason = getWatchlistEntrySnapshotUnsafeReason({ snapshot, birdseyeSnapshot: snapshot });
          if (snapshotStatus.snapshotStatus === 'safe') {
            counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
          } else {
            counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
          }
        }
      }
      if (snapshotStatus.snapshotStatus !== 'safe') {
        const unsafeReasons = Array.isArray(snapshotStatus.unsafeReasons) ? snapshotStatus.unsafeReasons : [];
        const reasonsSet = new Set(unsafeReasons);
        const liqNow = Number(snapshot?.liquidityUsd ?? row?.latest?.liqUsd ?? 0) || 0;
        const fullLiqFloorNow = Number(cfg.MIN_LIQUIDITY_FLOOR_USD);
        const mcapNow = Number(row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || 0;
        const hasMissingSnapshot = reasonsSet.has('missingSnapshot');
        const hasMissingPrice = reasonsSet.has('missingPrice');
        const hasLiqUnsafe = reasonsSet.has('liquidityBelowThreshold');
        const hasStale = reasonsSet.has('staleTimestamp');
        const hasOnlyLiq = (unsafeReasons.length === 1 && hasLiqUnsafe);
        const hasLiqPlusStaleOnly = (unsafeReasons.length === 2 && hasLiqUnsafe && hasStale);
        const hasUnknownHardUnsafe = unsafeReasons.some(r => !['liquidityBelowThreshold', 'staleTimestamp'].includes(String(r || '')));
        const hasMcapMissing = !(mcapNow > 0);

        if (isHot && hasLiqUnsafe) {
          counters.watchlist.hotLiqBypassUnsafeCombo ||= {};
          const comboKey = unsafeReasons.slice().sort().join('+') || 'none';
          counters.watchlist.hotLiqBypassUnsafeCombo[comboKey] = Number(counters.watchlist.hotLiqBypassUnsafeCombo[comboKey] || 0) + 1;

          const liqInBypassBand = (liqNow < fullLiqFloorNow) && (liqNow >= hotMomentumMinLiqUsd);
          const reasonsAllowedSubset = !hasUnknownHardUnsafe && (hasOnlyLiq || hasLiqPlusStaleOnly);
          const bypassEligible = liqInBypassBand && reasonsAllowedSubset && !hasMissingPrice && !hasMissingSnapshot;

          const mcapTraceValue = Number(row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || null;
          const mcapTraceSource = (Number(row?.latest?.mcapUsd || 0) > 0) ? 'row.latest'
            : (Number(snapshot?.marketCapUsd || 0) > 0) ? 'snapshot.marketCapUsd'
            : (Number(pair?.marketCap || 0) > 0) ? 'pair.marketCap'
            : (Number(pair?.fdv || 0) > 0) ? 'pair.fdv'
            : 'missing';
          const pairCreatedAtTrace = Number(snapshot?.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? pair?.pairCreatedAt ?? 0) || 0;
          const ageHoursTrace = pairCreatedAtTrace > 0 ? Math.max(0, (nowMs - pairCreatedAtTrace) / 3600000) : null;
          const holderSummaryTrace = {
            holders: Number(snapshot?.entryHints?.participation?.holders ?? row?.latest?.holders ?? pair?.participation?.holders ?? 0) || null,
            topHolderPct: Number(row?.latest?.topHolderPct ?? snapshot?.topHolderPct ?? NaN),
            top10Pct: Number(row?.latest?.top10Pct ?? snapshot?.top10HoldersPct ?? snapshot?.top10Pct ?? NaN),
            bundleClusterPct: Number(row?.latest?.bundleClusterPct ?? snapshot?.bundleClusterPct ?? NaN),
          };
          const traceBase = {
            timestamp: nowIso(),
            mint,
            liquidityUsd: liqNow,
            HOT_MOMENTUM_MIN_LIQ_USD: hotMomentumMinLiqUsd,
            MIN_LIQUIDITY_FLOOR_USD: fullLiqFloorNow,
            unsafeReasonsBeforeBypass: unsafeReasons,
            freshnessMs: Number(snapshot?.freshnessMs ?? row?.latest?.marketDataFreshnessMs ?? null),
            ageHours: ageHoursTrace,
            holderSummary: holderSummaryTrace,
            mcapValueSeenByHot: mcapTraceValue,
            mcapSourceUsed: mcapTraceSource,
          };

          if (bypassEligible) {
            counters.watchlist.hotLiqMomentumBypassAllowed = Number(counters.watchlist.hotLiqMomentumBypassAllowed || 0) + 1;
            row.meta.hotMomentumOnlyLiquidityBypass = true;
            row.meta.hotMomentumBypassLiquidityUsd = liqNow;
            row.meta.hotMomentumBypassAtMs = nowMs;
            hotBypassTraceCtx = {
              ...traceBase,
              bypassDecision: 'allowed',
              bypassPrimaryRejectReason: null,
              bypassSecondaryTags: [],
            };
            snapshotStatus = { snapshotStatus: 'safe', unsafeReasons: [], confidenceScore: snapshotStatus.confidenceScore };
          } else {
            counters.watchlist.hotLiqMomentumBypassRejected = Number(counters.watchlist.hotLiqMomentumBypassRejected || 0) + 1;
            counters.watchlist.hotLiqBypassPrimaryRejectReason ||= {};
            counters.watchlist.hotLiqBypassSecondaryTags ||= {};
            const bumpPrimary = (k) => { counters.watchlist.hotLiqBypassPrimaryRejectReason[k] = Number(counters.watchlist.hotLiqBypassPrimaryRejectReason[k] || 0) + 1; };
            const bumpSecondary = (k) => { counters.watchlist.hotLiqBypassSecondaryTags[k] = Number(counters.watchlist.hotLiqBypassSecondaryTags[k] || 0) + 1; };

            let primary = null;
            if (hasMissingSnapshot) primary = 'missingSnapshot';
            else if (hasMissingPrice) primary = 'missingPrice';
            else if (hasUnknownHardUnsafe) primary = 'disallowedUnsafeReason';
            else if (!liqInBypassBand) primary = (liqNow < hotMomentumMinLiqUsd) ? 'belowHotStalkingFloor' : 'atOrAboveFullFloor';
            else primary = 'other';
            bumpPrimary(primary);

            const secondaryTags = [];
            if (hasMcapMissing) { bumpSecondary('mcapMissing(diagnostic)'); secondaryTags.push('mcapMissing(diagnostic)'); }
            if (hasLiqPlusStaleOnly) { bumpSecondary('liq+stale'); secondaryTags.push('liq+stale'); }
            if (hasOnlyLiq) { bumpSecondary('liqOnly'); secondaryTags.push('liqOnly'); }
            if (hasLiqUnsafe) { bumpSecondary('liqUnsafe'); secondaryTags.push('liqUnsafe'); }
            if (hasStale) { bumpSecondary('stale'); secondaryTags.push('stale'); }

            emitHotBypassTrace({
              ...traceBase,
              bypassDecision: 'rejected',
              bypassPrimaryRejectReason: primary,
              bypassSecondaryTags: secondaryTags,
              nextStageReached: 'snapshotGateReject',
              finalPreMomentumRejectReason: `snapshot.${unsafeReason || 'unsafe'}`,
              momentumCounterIncremented: false,
              confirmCounterIncremented: false,
            });
          }
        }
      }
      if (snapshotStatus.snapshotStatus !== 'safe') {
        const providerStatus = state.marketData?.providers?.birdeye?.status || (state.streaming?.health?.providerStatus || null);
        const meta = {
          unsafeReasons: snapshotStatus.unsafeReasons,
          confidenceScore: snapshotStatus.confidenceScore,
          providerStatus,
          snapshotAgeMs: snapshot?.freshnessMs ?? null,
        };
        if (fail(unsafeReason, { stage: 'snapshot', meta }) === 'break') break;
        continue;
      }
    }

    if (!pair) {
      pair = {
        baseToken: { address: mint, symbol: row?.pair?.baseToken?.symbol || null },
        liquidity: { usd: Number(snapshot?.liquidityUsd || 0) },
        volume: { h1: Number(snapshot?.volume?.h1 || 0), h4: 0 },
        txns: { h1: { buys: Number(snapshot?.txns?.h1?.buys || 0), sells: Number(snapshot?.txns?.h1?.sells || 0) } },
        priceChange: { h1: 0, h4: 0 },
        pairCreatedAt: Number(row?.latest?.pairCreatedAt || 0) || null,
        pairAddress: null,
        dexId: snapshot?.source || 'birdseye',
        priceUsd: Number(snapshot?.priceUsd || 0) || null,
      };
    }

    const hotMinMcap = Number(state?.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD ?? 0);
    const hotMinAgeHours = Number(state?.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS ?? 0);
    const mcapRefreshRetries = Number(cfg.HOT_MCAP_REFRESH_RETRIES || 2);
    const mcapRefreshDelayMs = Number(cfg.HOT_MCAP_REFRESH_DELAY_MS || 220);
    const mcapRefreshWindowMs = Number(cfg.HOT_MCAP_REFRESH_WINDOW_MS || 1800);
    const resolveMcapHot = () => {
      const mcapFromRow = Number(row?.latest?.mcapUsd ?? 0);
      const mcapFromSnap = Number(snapshot?.marketCapUsd ?? 0);
      const mcapFromPairMcap = Number(pair?.marketCap ?? 0);
      const mcapFromPairFdv = Number(pair?.fdv ?? 0);
      if (Number.isFinite(mcapFromRow) && mcapFromRow > 0) return { value: mcapFromRow, source: 'row.latest' };
      if (Number.isFinite(mcapFromSnap) && mcapFromSnap > 0) return { value: mcapFromSnap, source: 'snapshot.marketCapUsd' };
      if (Number.isFinite(mcapFromPairMcap) && mcapFromPairMcap > 0) return { value: mcapFromPairMcap, source: 'pair.marketCap' };
      if (Number.isFinite(mcapFromPairFdv) && mcapFromPairFdv > 0) return { value: mcapFromPairFdv, source: 'pair.fdv' };
      return { value: null, source: 'missing' };
    };
    let { value: mcapHot, source: mcapSourceUsed } = resolveMcapHot();

    const bumpPostBypassReject = (k) => {
      if (!row?.meta?.hotMomentumOnlyLiquidityBypass) return;
      counters.watchlist.hotPostBypassRejected ||= {};
      counters.watchlist.hotPostBypassRejected[k] = Number(counters.watchlist.hotPostBypassRejected[k] || 0) + 1;
    };

    if (!(mcapHot > 0)) {
      const enriched = await tryHotEnrichedRefresh('mcapMissing');
      if (enriched) {
        ({ value: mcapHot, source: mcapSourceUsed } = resolveMcapHot());
        if (mcapHot > 0) counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
        else counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
      }

      if (!(mcapHot > 0)) {
        if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
          row.meta.hotMomentumBypassMcapMissingAllowedAtMs = nowMs;
          mcapHot = null;
        } else {
          counters.watchlist.hotDeferredMissingMcap = Number(counters.watchlist.hotDeferredMissingMcap || 0) + 1;
          row.meta ||= {};
          row.meta.hotMcapDeferredAtMs = nowMs;
          row.meta.hotMcapDeferredRetries = Number(row.meta.hotMcapDeferredRetries || 0) + 1;

          const refreshStartMs = Date.now();
          for (let i = 0; i < mcapRefreshRetries; i++) {
            if ((Date.now() - refreshStartMs) > mcapRefreshWindowMs) break;
            try {
              if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
                const bird = await birdseye.getTokenSnapshot(mint);
                const birdSnap = snapshotFromBirdseye(bird, Date.now());
                if (birdSnap) {
                  snapshot = birdSnap;
                  row.snapshot = birdSnap;
                  applySnapshotToLatest({ row, snapshot: birdSnap });
                }
              }
            } catch {}

            ({ value: mcapHot, source: mcapSourceUsed } = resolveMcapHot());
            if (mcapHot > 0) break;
            if (i < (mcapRefreshRetries - 1)) await new Promise(r => setTimeout(r, mcapRefreshDelayMs));
          }

          if (!(mcapHot > 0)) {
            counters.watchlist.hotDeferredFailed = Number(counters.watchlist.hotDeferredFailed || 0) + 1;
            bumpPostBypassReject('mcapMissing');
            finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.mcapMissing', momentumCounterIncremented: false, confirmCounterIncremented: false });
            if (fail('mcapMissing', { stage: 'hot', cooldownMs: 30_000 }) === 'break') break;
            continue;
          }
          counters.watchlist.hotDeferredRecovered = Number(counters.watchlist.hotDeferredRecovered || 0) + 1;
        }
      }
    }

    counters.watchlist.hotMcapSourceUsed ||= {};
    counters.watchlist.hotMcapSourceUsed[mcapSourceUsed] = Number(counters.watchlist.hotMcapSourceUsed[mcapSourceUsed] || 0) + 1;
    if (mcapHot > 0) counters.watchlist.hotMcapNormalizedPresent = Number(counters.watchlist.hotMcapNormalizedPresent || 0) + 1;
    else counters.watchlist.hotMcapNormalizedMissing = Number(counters.watchlist.hotMcapNormalizedMissing || 0) + 1;

    let mcapFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
    if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
      const enriched = await tryHotEnrichedRefresh('staleData');
      if (enriched) {
        mcapFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
        if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
          counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
        } else {
          counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
        }
      }
      if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
        if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
          counters.watchlist.hotPostBypassAllowedStaleMcap = Number(counters.watchlist.hotPostBypassAllowedStaleMcap || 0) + 1;
        } else {
          bumpPostBypassReject('other');
          finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.mcapStaleData', momentumCounterIncremented: false, confirmCounterIncremented: false });
          if (fail('mcapStaleData', { stage: 'hot', cooldownMs: 30_000, meta: { mcapFreshnessMs } }) === 'break') break;
          continue;
        }
      }
    }

    function resolvePairCreatedAt({ pair, snapshot, row }) {
      const candidates = [
        { value: pair?.pairCreatedAt, source: 'pair.pairCreatedAt' },
        { value: snapshot?.pairCreatedAt, source: 'snapshot.pairCreatedAt' },
        { value: snapshot?.pair?.pairCreatedAt, source: 'snapshot.pair.pairCreatedAt' },
        { value: row?.latest?.pairCreatedAt, source: 'row.latest.pairCreatedAt' },
        { value: snapshot?.raw?.created_at ?? snapshot?.raw?.pair_created_at ?? snapshot?.pair?.birdeye?.created_at ?? snapshot?.pair?.created_at, source: 'snapshot.birdeyeCreated' },
      ];
      for (const c of candidates) {
        const n = normalizeEpochMs(c.value);
        if (n) return { pairCreatedAtMs: n, source: c.source };
      }
      return { pairCreatedAtMs: null, source: 'missing' };
    }
    const resolvedAgeKey = `resolvedPairCreatedAt:${mint}`;
    row.meta ||= {};
    if (!row.meta.resolvedPairCreatedAt) row.meta.resolvedPairCreatedAt = {};
    let resolved = row.meta.resolvedPairCreatedAt;
    if (!resolved || resolved?.mint !== mint) {
      const r = resolvePairCreatedAt({ pair, snapshot, row });
      resolved = { mint, pairCreatedAtMs: r.pairCreatedAtMs, source: r.source, tMs: nowMs };
      row.meta.resolvedPairCreatedAt = resolved;
    }
    const pairCreatedAtForHolders = Number(resolved?.pairCreatedAtMs || 0) || null;
    const poolAgeSecForHolders = pairCreatedAtForHolders ? Math.max(0, (nowMs - pairCreatedAtForHolders) / 1000) : null;

    if (mcapHot != null && mcapHot < hotMinMcap) {
      bumpPostBypassReject('other');
      finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: `hot.mcapLow(<${Math.round(hotMinMcap)})`, momentumCounterIncremented: false, confirmCounterIncremented: false });
      if (fail(`mcapLow(<${Math.round(hotMinMcap)})`, { stage: 'hot', cooldownMs: 30_000 }) === 'break') break;
      continue;
    }
    if (!(poolAgeSecForHolders != null)) {
      const HOT_ALLOW_AGE_PENDING = !!cfg.HOT_ALLOW_AGE_PENDING;
      const HOT_AGE_PENDING_MAX_EVALS = Number(cfg.HOT_AGE_PENDING_MAX_EVALS || 3);
      const HOT_AGE_PENDING_MAX_MS = Number(cfg.HOT_AGE_PENDING_MAX_MS || 180000);
      const HOT_AGE_PENDING_COOLDOWN_MS = Number(cfg.HOT_AGE_PENDING_COOLDOWN_MS || 300000);

      const snapshotUsable = getSnapshotStatus({ snapshot, latest: row?.latest })?.usable ?? true;
      const liquidityPasses = Number(pair?.liquidity?.usd || snapshot?.liquidityUsd || row?.latest?.liqUsd || 0) >= 0;
      const dataFresh = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? Infinity) <= Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000);
      const hardSafetyOk = !(row?.meta?.hardSafetyReject);

      if (row?.meta?.hotMomentumOnlyLiquidityBypass && Number(hotMinAgeHours || 0) <= 0) {
        counters.watchlist.hotPostBypassAllowedMissingAge = Number(counters.watchlist.hotPostBypassAllowedMissingAge || 0) + 1;
      } else if (HOT_ALLOW_AGE_PENDING && snapshotUsable && liquidityPasses && dataFresh && hardSafetyOk) {
        counters.watchlist.hotAgePendingAllowed = Number(counters.watchlist.hotAgePendingAllowed || 0) + 1;
        row.meta.agePendingHot ||= { tStartedMs: nowMs, evals: 0, lastEvalMs: nowMs };
        row.meta.agePendingHot.evals = Number(row.meta.agePendingHot.evals || 0) + 1;
        row.meta.agePendingHot.lastEvalMs = nowMs;
        counters.watchlist.momentumAgePendingSeen = Number(counters.watchlist.momentumAgePendingSeen || 0) + 1;
        row.meta.agePendingHot.status = 'allowed';
        if (Number(row.meta.agePendingHot.evals || 0) > HOT_AGE_PENDING_MAX_EVALS || (nowMs - Number(row.meta.agePendingHot.tStartedMs || nowMs)) > HOT_AGE_PENDING_MAX_MS) {
          row.meta.agePendingHot.status = 'expired';
          counters.watchlist.hotAgePendingExpired = Number(counters.watchlist.hotAgePendingExpired || 0) + 1;
          bumpPostBypassReject('agePendingExpired');
          if (fail('agePendingExpired', { stage: 'hot', cooldownMs: HOT_AGE_PENDING_COOLDOWN_MS }) === 'break') break;
          continue;
        }
      } else {
        bumpPostBypassReject('age');
        finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.ageMissingForHot', momentumCounterIncremented: false, confirmCounterIncremented: false });
        if (fail('ageMissingForHot', { stage: 'hot', cooldownMs: 30_000 }) === 'break') break;
        continue;
      }
    } else if (Number(hotMinAgeHours || 0) > 0 && poolAgeSecForHolders < (hotMinAgeHours * 3600)) {
      bumpPostBypassReject('age');
      finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: `hot.ageBelowHotMin(<${hotMinAgeHours}h)`, momentumCounterIncremented: false, confirmCounterIncremented: false });
      if (fail(`ageBelowHotMin(<${hotMinAgeHours}h)`, { stage: 'hot', cooldownMs: 30_000 }) === 'break') break;
      continue;
    }

    const holders = Number(snapshot?.entryHints?.participation?.holders ?? row?.latest?.holders ?? pair?.participation?.holders ?? 0) || null;
    const holdersGate = holdersGateCheck({ cfg, holders, poolAgeSec: poolAgeSecForHolders });
    if (!holdersGate.ok) {
      bumpPostBypassReject('holders');
      finalizeHotBypassTrace({ nextStageReached: 'holdersGate', finalPreMomentumRejectReason: `holders.${holdersGate.reason}`, momentumCounterIncremented: false, confirmCounterIncremented: false });
      if (fail(holdersGate.reason, { stage: 'holders', cooldownMs: 30_000 }) === 'break') break;
      continue;
    }

    bumpWatchlistFunnel(counters, 'watchlistEvaluated', { nowMs });
    pushCompactWindowEvent('watchlistEvaluated');
    canaryLog('trigger', 'watchlistEvaluated');
    applySnapshotToLatest({ row, snapshot });
    const liqUsd = Number(pair?.liquidity?.usd || snapshot?.liquidityUsd || row?.latest?.liqUsd || 0);
    pushCompactWindowEvent('stalkableSeen', null, { mint, liqUsd });
    const { normalized: momentumInput, presentFields: momentumInputPresentFields, sourceUsed: momentumInputSourceUsed, rawAvail: momentumRawAvail, microPresent: momentumMicroPresent, microSourceUsed: momentumMicroSourceUsed } = buildNormalizedMomentumInput({ snapshot, latest: row?.latest, pair });
    counters.watchlist.momentumInputSourceUsed ||= {};
    counters.watchlist.momentumInputSourceUsed[momentumInputSourceUsed] = Number(counters.watchlist.momentumInputSourceUsed[momentumInputSourceUsed] || 0) + 1;
    if (momentumInputPresentFields >= 4) counters.watchlist.momentumInputCompletenessPresent = Number(counters.watchlist.momentumInputCompletenessPresent || 0) + 1;
    else counters.watchlist.momentumInputCompletenessMissing = Number(counters.watchlist.momentumInputCompletenessMissing || 0) + 1;
    counters.watchlist.momentumMicroSourceUsed ||= {};
    counters.watchlist.momentumMicroSourceUsed[momentumMicroSourceUsed] = Number(counters.watchlist.momentumMicroSourceUsed[momentumMicroSourceUsed] || 0) + 1;
    if (Number(momentumMicroPresent || 0) >= 3) counters.watchlist.momentumMicroFieldsPresent = Number(counters.watchlist.momentumMicroFieldsPresent || 0) + 1;
    else counters.watchlist.momentumMicroFieldsMissing = Number(counters.watchlist.momentumMicroFieldsMissing || 0) + 1;

    const useStrict = !cfg.AGGRESSIVE_MODE && liqUsd > 0 && liqUsd < cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD;
    const sig = evaluateMomentumSignal(momentumInput, { profile: cfg.MOMENTUM_PROFILE, strict: useStrict });
    const zeroSignalFallback = Number(sig?.reasons?.volume5m || 0) === 0
      && Number(sig?.reasons?.buySellRatio || 0) === 0
      && Number(sig?.reasons?.tx_1m || 0) === 0
      && Number(sig?.reasons?.price || sig?.reasons?.priceUsd || 0) === 0;
    if (zeroSignalFallback) counters.watchlist.momentumZeroSignalFallbackCount = Number(counters.watchlist.momentumZeroSignalFallbackCount || 0) + 1;

    const momentumLiqGuardrail = Number(sig?.reasons?.momentumLiqGuardrailUsd || 60000);
    counters.watchlist.momentumLiqGuardrail = momentumLiqGuardrail;
    if (liqUsd >= momentumLiqGuardrail) counters.watchlist.momentumLiqCandidatesAboveGuardrail = Number(counters.watchlist.momentumLiqCandidatesAboveGuardrail || 0) + 1;
    else counters.watchlist.momentumLiqCandidatesBelowGuardrail = Number(counters.watchlist.momentumLiqCandidatesBelowGuardrail || 0) + 1;
    pushCompactWindowEvent('momentumLiq', null, { liqUsd });
    counters.watchlist.momentumLiqBand ||= { lt30: 0, b30_40: 0, b40_50: 0, b30_50: 0, b50_75: 0, gte75: 0 };
    if (liqUsd < 30_000) counters.watchlist.momentumLiqBand.lt30 += 1;
    else if (liqUsd < 40_000) { counters.watchlist.momentumLiqBand.b30_40 += 1; counters.watchlist.momentumLiqBand.b30_50 += 1; }
    else if (liqUsd < 50_000) { counters.watchlist.momentumLiqBand.b40_50 += 1; counters.watchlist.momentumLiqBand.b30_50 += 1; }
    else if (liqUsd < 75_000) counters.watchlist.momentumLiqBand.b50_75 += 1;
    else counters.watchlist.momentumLiqBand.gte75 += 1;

    const canaryBypassActive = isCanary
      && cfg.CONVERSION_CANARY_MODE
      && cfg.CANARY_BYPASS_MOMENTUM
      && (!cfg.CANARY_BYPASS_MOMENTUM_UNTIL_ISO || (Date.parse(cfg.CANARY_BYPASS_MOMENTUM_UNTIL_ISO) > nowMs));

    let agePicked = { value: null, source: 'missing' };
    if (resolved?.pairCreatedAtMs) {
      agePicked = { value: Number(resolved.pairCreatedAtMs), source: String(resolved.source || 'resolved') };
    } else {
      const cachedAge = getCachedMintCreatedAt({ state, mint, nowMs, maxAgeMs: 60 * 60_000 });
      if (cachedAge?.createdAtMs) {
        row.latest ||= {};
        row.latest.pairCreatedAt = Number(cachedAge.createdAtMs);
        agePicked = { value: Number(cachedAge.createdAtMs), source: String(cachedAge.source || 'cache.mintCreatedAt') };
        row.meta.resolvedPairCreatedAt = { mint, pairCreatedAtMs: agePicked.value, source: agePicked.source, tMs: nowMs };
      } else {
        scheduleMintCreatedAtLookup({
          state,
          mint,
          nowMs,
          minRetryMs: Number(cfg.MINT_AGE_LOOKUP_RETRY_MS || 30_000),
          lookupFn: () => resolveMintCreatedAtFromRpc?.({ state, conn, mint, nowMs: Date.now(), maxPages: 3 }),
        });
        agePicked = { value: null, source: 'pending_rpc' };
      }
    }
    counters.watchlist.hotAgeSourceUsed ||= {};
    counters.watchlist.hotAgeSourceUsed[agePicked.source || 'missing'] = Number(counters.watchlist.hotAgeSourceUsed[agePicked.source || 'missing'] || 0) + 1;

    const momentumPairCreatedAt = agePicked.value;
    const tokenAgeMinutes = momentumPairCreatedAt ? Math.max(0, (nowMs - momentumPairCreatedAt) / 60_000) : null;
    const { agePresent, matureTokenMode, earlyTokenMode, breakoutBranchUsed } = decideMomentumBranch(tokenAgeMinutes);
    counters.watchlist.momentumAgePresent = Number(counters.watchlist.momentumAgePresent || 0) + (agePresent ? 1 : 0);
    counters.watchlist.momentumAgeMissing = Number(counters.watchlist.momentumAgeMissing || 0) + (agePresent ? 0 : 1);
    counters.watchlist.momentumAgeSourceUsed ||= {};
    counters.watchlist.momentumAgeSourceUsed[agePicked.source] = Number(counters.watchlist.momentumAgeSourceUsed[agePicked.source] || 0) + 1;
    counters.watchlist.momentumEarlyTokenModeCount = Number(counters.watchlist.momentumEarlyTokenModeCount || 0) + (earlyTokenMode ? 1 : 0);
    counters.watchlist.momentumMatureTokenModeCount = Number(counters.watchlist.momentumMatureTokenModeCount || 0) + (matureTokenMode ? 1 : 0);
    const fallbackMeta = sig?.reasons?.fallbackMeta || {};
    const txEffective1m = Number(sig?.reasons?.tx_1m || 0);
    const txEffective5m = Number(sig?.reasons?.tx_5m_avg || 0);
    const volumeEffective5m = Number(sig?.reasons?.volume_5m || 0);
    const volumeEffective30m = Number(sig?.reasons?.volume_30m_avg || 0);
    counters.watchlist.momentumPathUsage ||= {
      tx: { normal: 0, fallback: 0, missing: 0 },
      volume: { normal: 0, fallback: 0, missing: 0 },
    };
    const txBucket = (txEffective1m > 0 || txEffective5m > 0) ? (fallbackMeta?.tx ? 'fallback' : 'normal') : 'missing';
    const volumeBucket = (volumeEffective5m > 0 || volumeEffective30m > 0) ? (fallbackMeta?.volume ? 'fallback' : 'normal') : 'missing';
    counters.watchlist.momentumPathUsage.tx[txBucket] = Number(counters.watchlist.momentumPathUsage.tx[txBucket] || 0) + 1;
    counters.watchlist.momentumPathUsage.volume[volumeBucket] = Number(counters.watchlist.momentumPathUsage.volume[volumeBucket] || 0) + 1;

    if (canaryBypassActive) {
      canaryLog('momentum', 'bypassed');
    } else {
      const dexFailedRaw = Array.isArray(sig?.reasons?.failedChecks) ? sig.reasons.failedChecks.map(String) : [];
      const dexFailed = earlyTokenMode
        ? dexFailedRaw.filter(x => x !== 'volumeExpansion' && x !== 'txAcceleration')
        : dexFailedRaw;

      const paperSeries = state.paper?.series?.[mint] || null;
      const paperWin = paperComputeMomentumWindows(paperSeries, nowMs);
      const paperThresholds = {
        ret15: cfg.PAPER_ENTRY_RET_15M_PCT,
        ret5: cfg.PAPER_ENTRY_RET_5M_PCT,
        greensLast5: cfg.PAPER_ENTRY_GREEN_LAST5,
      };
      const paperFailed = [];
      if (paperWin.ret15 == null) paperFailed.push('ret15Missing');
      else if (paperWin.ret15 < paperThresholds.ret15) paperFailed.push('ret15Low');
      if (paperWin.ret5 == null) paperFailed.push('ret5Missing');
      else if (paperWin.ret5 < paperThresholds.ret5) paperFailed.push('ret5Low');
      if (Number(paperWin.greensLast5 || 0) < Number(paperThresholds.greensLast5 || 0)) paperFailed.push('greensLow');

      const earlyPriceBreakPass = !dexFailed.includes('priceBreak');
      const earlyBuyPressurePass = !dexFailed.includes('buyPressure');
      const earlyWalletExpansionPass = !dexFailed.includes('walletExpansion');
      const earlyPassCount = [earlyPriceBreakPass, earlyBuyPressurePass, earlyWalletExpansionPass].filter(Boolean).length;
      const snapshotFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
      const wsPxForMicro = cache.get(`birdeye:ws:price:${mint}`) || null;
      const wsTsForMicro = Number(wsPxForMicro?.tsMs || 0);
      const wsFreshnessMsForMicro = wsTsForMicro > 0 ? Math.max(0, nowMs - wsTsForMicro) : NaN;
      const freshnessForMicroGate = Number.isFinite(wsFreshnessMsForMicro)
        ? Math.min(wsFreshnessMsForMicro, snapshotFreshnessMs)
        : snapshotFreshnessMs;
      const microFreshGate = isMicroFreshEnough({
        microPresentCount: momentumMicroPresent,
        freshnessMs: freshnessForMicroGate,
        maxAgeMs: Number(cfg.MOMENTUM_MICRO_MAX_AGE_MS || 10_000),
        requireFreshMicro: !!cfg.MOMENTUM_REQUIRE_FRESH_MICRO,
        minPresentForGate: Number(cfg.MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE || 3),
      });

      let momentumGateOk = !!sig.ok && !!microFreshGate.ok;
      const combinedFailed = Array.from(new Set([
        ...dexFailed.map(x => `dex.${x}`),
        ...(microFreshGate.ok ? [] : [`dex.${String(microFreshGate.reason || 'microStale')}`]),
      ]));

      const hysteresis = applyMomentumPassHysteresis({
        state,
        mint,
        nowMs,
        gatePassed: momentumGateOk,
        requiredStreak: Number(cfg.MOMENTUM_PASS_STREAK_REQUIRED || 1),
        streakResetMs: Number(cfg.MOMENTUM_PASS_STREAK_RESET_MS || (10 * 60_000)),
      });
      momentumGateOk = !!hysteresis.passed;
      if (hysteresis.warmup) combinedFailed.push('momentum.hysteresisWarmup');

      if (cfg.MOMENTUM_FILTER_ENABLED && !momentumGateOk) {
        const coreDexFailures = dexFailed.filter(x => ['volumeExpansion', 'buyPressure', 'txAcceleration', 'walletExpansion'].includes(x));
        const breakoutSignalsFailed = coreDexFailures.length;
        const breakoutSignalsPassed = Math.max(0, 4 - breakoutSignalsFailed);
        counters.watchlist.momentumBreakoutSignalsPassed = Number(counters.watchlist.momentumBreakoutSignalsPassed || 0) + breakoutSignalsPassed;
        counters.watchlist.momentumBreakoutSignalsFailed = Number(counters.watchlist.momentumBreakoutSignalsFailed || 0) + breakoutSignalsFailed;

        recordCanaryMomoFailChecks({ state, nowMs, failedChecks: combinedFailed, windowMin: cfg.MOMENTUM_DIAG_WINDOW_MIN, enabled: isCanary });
        pushCompactWindowEvent('momentumFailChecks', null, { checks: combinedFailed, mint });

        counters.watchlist.momentumFailedChecksTop ||= {};
        counters.watchlist.momentumFailedMintsTop ||= {};
        counters.watchlist.momentumFailedCheckExamples ||= [];
        counters.watchlist.momentumFailedMintsTop[mint] = Number(counters.watchlist.momentumFailedMintsTop[mint] || 0) + 1;
        for (const chk of combinedFailed) {
          counters.watchlist.momentumFailedChecksTop[chk] = Number(counters.watchlist.momentumFailedChecksTop[chk] || 0) + 1;
        }
        counters.watchlist.momentumFailedCheckExamples.push({
          t: nowIso(),
          mint,
          checks: combinedFailed.slice(0, 8),
          observed: {
            dex: sig.reasons || null,
            paper: paperWin,
          },
          thresholds: {
            dex: sig.thresholds || null,
            paper: paperThresholds,
          },
          liquidityUsd: liqUsd,
          mcapValueSeenByHot: mcapHot,
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? null),
          tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
          earlyTokenMode,
          breakoutBranchUsed,
          ageSource: agePicked.source,
        });
        if (counters.watchlist.momentumFailedCheckExamples.length > 20) {
          counters.watchlist.momentumFailedCheckExamples = counters.watchlist.momentumFailedCheckExamples.slice(-20);
        }
        counters.watchlist.momentumInputDebugLast ||= [];
        counters.watchlist.momentumInputDebugLast.push({
          t: nowIso(),
          mint,
          failedChecks: combinedFailed.slice(0, 8),
          raw: momentumRawAvail,
          normalizedUsed: {
            priceUsd: momentumInput?.priceUsd ?? null,
            liqUsd: momentumInput?.liquidity?.usd ?? null,
            mcapUsd: momentumInput?.marketCap ?? null,
            tx1m: momentumInput?.birdeye?.tx_1m ?? null,
            tx5mAvg: momentumInput?.birdeye?.tx_5m_avg ?? null,
            volume5m: momentumInput?.birdeye?.volume_5m ?? null,
            volume30mAvg: momentumInput?.birdeye?.volume_30m_avg ?? null,
            buySellRatio: momentumInput?.birdeye?.buySellRatio ?? null,
            rollingHigh5m: momentumInput?.birdeye?.rolling_high_5m ?? null,
          },
          tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
          earlyTokenMode,
          breakoutBranchUsed,
          ageSource: agePicked.source,
        });
        if (counters.watchlist.momentumInputDebugLast.length > 5) {
          counters.watchlist.momentumInputDebugLast = counters.watchlist.momentumInputDebugLast.slice(-5);
        }
        pushCompactWindowEvent('momentumInputSample', null, {
          mint,
          liq: Number(momentumInput?.liquidity?.usd || 0),
          v5: Number(sig?.reasons?.volume_5m ?? momentumInput?.birdeye?.volume_5m ?? 0),
          v30: Number(sig?.reasons?.volume_30m_avg ?? momentumInput?.birdeye?.volume_30m_avg ?? 0),
          volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
          volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
          volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
          bsr: Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0),
          walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
          buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
          buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
          tx1m: Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0),
          tx5mAvg: Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0),
          tx30mAvg: Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0),
          txThreshold: Number(cfg.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0),
          volThreshold: Number(cfg.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0),
          walletThreshold: Number(cfg.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25),
          hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
          fail: combinedFailed.join('|') || 'none',
        });
        pushCompactWindowEvent('momentumAgeSample', null, {
          mint,
          ageMin: tokenAgeMinutes,
          early: earlyTokenMode,
          source: agePicked.source,
          branch: breakoutBranchUsed,
          fail: combinedFailed.slice(0, 3).join('|') || 'none',
        });
        pushCompactWindowEvent('momentumRecent', null, {
          mint,
          liq: Number(liqUsd || 0),
          mcap: Number(mcapHot || 0),
          ageMin: tokenAgeMinutes,
          agePresent,
          early: earlyTokenMode,
          branch: breakoutBranchUsed,
          v5: Number(sig?.reasons?.volume_5m || 0) || null,
          v30: Number(sig?.reasons?.volume_30m_avg || 0) || null,
          volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
          volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
          volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
          walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
          buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
          buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
          hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
          tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
          tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
          tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
          momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
          momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
          momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
          topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 3) : [],
          topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 3) : [],
          final: 'momentum.momentumFailed',
        });
        pushCompactWindowEvent('momentumScoreSample', null, {
          mint,
          momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
          momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
          momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
          topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 5) : [],
          topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 5) : [],
          final: 'momentum.momentumFailed',
        });

        const coreFailedNow = combinedFailed.filter(x => CORE_MOMO_CHECKS.includes(x)).sort();
        const progressNow = coreMomentumProgress(sig);
        const prevRepeat = state.runtime.momentumRepeatFail[mint] || null;
        let repeatSuppressed = false;
        let repeatReason = null;
        if (prevRepeat && coreFailedNow.length > 0) {
          const withinWindow = (nowMs - Number(prevRepeat.tMs || 0)) <= (repeatFailWindowSec * 1000);
          const prevCore = Array.isArray(prevRepeat.coreFailed) ? prevRepeat.coreFailed.slice().sort() : [];
          const sameCore = prevCore.length === coreFailedNow.length && prevCore.every((v, i) => v === coreFailedNow[i]);
          if (withinWindow && sameCore) {
            let improvedChecks = 0;
            for (const chk of coreFailedNow) {
              const prevV = Number(prevRepeat.progress?.[chk] || 0);
              const nowV = Number(progressNow?.[chk] || 0);
              if (nowV >= (prevV + repeatImprovementDelta)) improvedChecks += 1;
            }
            if (improvedChecks === 0) {
              repeatSuppressed = true;
              repeatReason = 'sameCoreNoImprovement';
              row.cooldownUntilMs = Math.max(Number(row.cooldownUntilMs || 0), nowMs + (repeatFailCooldownSec * 1000));
              counters.watchlist.momentumRepeatFailSuppressed = Number(counters.watchlist.momentumRepeatFailSuppressed || 0) + 1;
              counters.watchlist.momentumRepeatFailMintsTop ||= {};
              counters.watchlist.momentumRepeatFailReasonTop ||= {};
              counters.watchlist.momentumRepeatFailMintsTop[mint] = Number(counters.watchlist.momentumRepeatFailMintsTop[mint] || 0) + 1;
              counters.watchlist.momentumRepeatFailReasonTop[repeatReason] = Number(counters.watchlist.momentumRepeatFailReasonTop[repeatReason] || 0) + 1;
              pushCompactWindowEvent('repeatSuppressed', null, { mint, reason: repeatReason });
            }
          }
        }
        const hist = Array.isArray(prevRepeat?.suppressionHistoryMs) ? prevRepeat.suppressionHistoryMs.filter(ts => (nowMs - Number(ts || 0)) <= (repeatEscalationWindowSec * 1000)) : [];
        if (repeatSuppressed) hist.push(nowMs);
        let appliedCooldownSec = repeatSuppressed ? repeatFailCooldownSec : 0;
        if (repeatSuppressed && hist.length >= repeatEscalationHits) {
          appliedCooldownSec = repeatEscalationCooldownSec;
          row.cooldownUntilMs = Math.max(Number(row.cooldownUntilMs || 0), nowMs + (repeatEscalationCooldownSec * 1000));
          counters.watchlist.momentumRepeatFailReasonTop.escalatedHoldout = Number(counters.watchlist.momentumRepeatFailReasonTop.escalatedHoldout || 0) + 1;
        }

        state.runtime.momentumRepeatFail[mint] = {
          tMs: nowMs,
          coreFailed: coreFailedNow,
          progress: progressNow,
          suppressionHistoryMs: hist,
        };

        const sampling = canaryMomoShouldSample({ state, nowMs, limitPerMin: cfg.CANARY_MOMO_FAIL_SAMPLE_PER_MIN });
        const meta = sampling.ok ? {
          momentum: {
            strict: useStrict,
            profile: cfg.MOMENTUM_PROFILE,
            freshnessGate: {
              ok: !!microFreshGate.ok,
              reason: String(microFreshGate.reason || 'unknown'),
            },
            hysteresis: {
              required: Number(hysteresis.required || 1),
              streak: Number(hysteresis.streak || 0),
              warmup: !!hysteresis.warmup,
            },
            liquidityBand: {
              liqUsd,
              lowLiqStrictUnderUsd: cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD,
              band: useStrict ? 'low' : 'normal',
            },
            dexscreener: {
              metrics: sig.reasons || null,
              thresholds: sig.thresholds || null,
            },
            paper: {
              windows: paperWin,
              thresholds: paperThresholds,
              failedChecks: paperFailed,
              seriesPoints: Array.isArray(paperSeries) ? paperSeries.length : 0,
            },
            failedChecks: combinedFailed,
          },
          sampled: { ok: true, limitPerMin: sampling.limitPerMin, usedThisMin: sampling.usedThisMin },
        } : {
          momentum: {
            strict: useStrict,
            profile: cfg.MOMENTUM_PROFILE,
            liquidityBand: { liqUsd, lowLiqStrictUnderUsd: cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD, band: useStrict ? 'low' : 'normal' },
            failedChecks: combinedFailed,
          },
          sampled: { ok: false, limitPerMin: sampling.limitPerMin, usedThisMin: sampling.usedThisMin },
        };

        finalizeHotBypassTrace({
          nextStageReached: 'momentum',
          finalPreMomentumRejectReason: 'momentum.momentumFailed',
          momentumCounterIncremented: false,
          confirmCounterIncremented: false,
          extra: {
            freshnessGate: {
              ok: !!microFreshGate.ok,
              reason: String(microFreshGate.reason || 'unknown'),
            },
            hysteresis: {
              required: Number(hysteresis.required || 1),
              streak: Number(hysteresis.streak || 0),
              warmup: !!hysteresis.warmup,
            },
            failedChecks: combinedFailed,
            thresholdValues: {
              dex: sig.thresholds || null,
              paper: paperThresholds,
            },
            observedMetrics: {
              dex: sig.reasons || null,
              paper: paperWin,
            },
            momentumRawAvailable: momentumRawAvail,
            momentumNormalizedUsed: {
              priceUsd: momentumInput?.priceUsd ?? null,
              liqUsd: momentumInput?.liquidity?.usd ?? null,
              mcapUsd: momentumInput?.marketCap ?? null,
              volume5m: momentumInput?.birdeye?.volume_5m ?? null,
              volume30mAvg: momentumInput?.birdeye?.volume_30m_avg ?? null,
              buySellRatio: momentumInput?.birdeye?.buySellRatio ?? null,
              tx1m: momentumInput?.birdeye?.tx_1m ?? null,
              tx5mAvg: momentumInput?.birdeye?.tx_5m_avg ?? null,
              rollingHigh5m: momentumInput?.birdeye?.rolling_high_5m ?? null,
            },
            repeatFailSuppressed: repeatSuppressed,
            repeatFailReason: repeatReason,
            repeatFailWindowSec: repeatFailWindowSec,
            repeatFailCooldownSecApplied: appliedCooldownSec,
            repeatFailEscalationHits: repeatEscalationHits,
            repeatFailEscalationWindowSec: repeatEscalationWindowSec,
            tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
            earlyTokenMode,
            breakoutBranchUsed,
            ageSource: agePicked.source,
          },
        });
        if (fail('momentumFailed', { stage: 'momentum', meta }) === 'break') break;
        continue;
      }
    }
    bumpWatchlistFunnel(counters, 'momentumPassed', { nowMs });
    pushCompactWindowEvent('momentumPassed');

    try {
      state.runtime ||= {};
      state.runtime.requalifyAfterStopByMint ||= {};
      const requalifyBlock = state.runtime.requalifyAfterStopByMint[mint] || null;
      if (requalifyBlock) {
        const nowMsLocal = Date.now();
        const fastStopActive = !!requalifyBlock.fastStopActive;
        const holdUntilMs = Number(requalifyBlock.holdUntilMs || 0);
        const holdExpired = !fastStopActive || !Number.isFinite(holdUntilMs) || holdUntilMs <= 0 || nowMsLocal >= holdUntilMs;
        if (holdExpired) {
          delete state.runtime.requalifyAfterStopByMint[mint];
          counters.watchlist.requalifyClearedOnMomentumPass = Number(counters.watchlist.requalifyClearedOnMomentumPass || 0) + 1;
        }
      }
    } catch {}
    pushCompactWindowEvent('momentumAgeSample', null, {
      mint,
      ageMin: tokenAgeMinutes,
      early: earlyTokenMode,
      source: agePicked.source,
      branch: breakoutBranchUsed,
      fail: 'none',
    });
    const momentumUsedTx1m = Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0) || 0;
    const momentumUsedTx5mAvg = Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0) || 0;
    const momentumUsedTx30mAvg = Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0) || 0;
    const momentumUsedBuySellRatio = Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0) || 0;
    row.meta ||= {};
    row.meta.confirmTxCarry = {
      tx1m: momentumUsedTx1m,
      tx5mAvg: momentumUsedTx5mAvg,
      tx30mAvg: momentumUsedTx30mAvg,
      buySellRatio: momentumUsedBuySellRatio,
      atMs: nowMs,
      source: 'momentum.signal',
    };
    state.runtime ||= {};
    state.runtime.confirmTxCarryByMint ||= {};
    state.runtime.confirmTxCarryByMint[mint] = { ...row.meta.confirmTxCarry };
    recordConfirmCarryTrace(state, mint, 'momentumPass', {
      carryPresent: true,
      carryTx1m: Number(row.meta.confirmTxCarry?.tx1m || 0) || null,
      carryTx5mAvg: Number(row.meta.confirmTxCarry?.tx5mAvg || 0) || null,
      carryTx30mAvg: Number(row.meta.confirmTxCarry?.tx30mAvg || 0) || null,
      carryBuySellRatio: Number(row.meta.confirmTxCarry?.buySellRatio || 0) || null,
      momentumSigTx1m: Number(sig?.reasons?.tx_1m || 0) || null,
      momentumSigTx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
      momentumSigTx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
      momentumSigBuySellRatio: Number(sig?.reasons?.buySellRatio || 0) || null,
      momentumInputTx1m: Number(momentumInput?.birdeye?.tx_1m || 0) || null,
      momentumInputTx5mAvg: Number(momentumInput?.birdeye?.tx_5m_avg || 0) || null,
      momentumInputTx30mAvg: Number(momentumInput?.birdeye?.tx_30m_avg || 0) || null,
      momentumInputBuySellRatio: Number(momentumInput?.birdeye?.buySellRatio || 0) || null,
      rowPath: `watchlist.mints.${mint}.meta.confirmTxCarry`,
      carryWriteBranchRan: true,
    });
    pushCompactWindowEvent('momentumInputSample', null, {
      mint,
      liq: Number(momentumInput?.liquidity?.usd || 0),
      v5: Number(sig?.reasons?.volume_5m ?? momentumInput?.birdeye?.volume_5m ?? 0),
      v30: Number(sig?.reasons?.volume_30m_avg ?? momentumInput?.birdeye?.volume_30m_avg ?? 0),
      volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
      volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
      volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
      bsr: Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0),
      walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
      buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
      buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
      tx1m: Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0),
      tx5mAvg: Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0),
      tx30mAvg: Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0),
      txThreshold: Number(cfg.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0),
      volThreshold: Number(cfg.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0),
      walletThreshold: Number(cfg.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25),
      hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
      fail: 'none',
    });
    pushCompactWindowEvent('momentumRecent', null, {
      mint,
      liq: Number(liqUsd || 0),
      mcap: Number(mcapHot || 0),
      ageMin: tokenAgeMinutes,
      agePresent,
      early: earlyTokenMode,
      branch: breakoutBranchUsed,
      v5: Number(sig?.reasons?.volume_5m || 0) || null,
      v30: Number(sig?.reasons?.volume_30m_avg || 0) || null,
      volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
      volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
      volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
      walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
      buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
      buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
      hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
      tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
      tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
      tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
      momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
      momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
      momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
      topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 3) : [],
      topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 3) : [],
      final: 'momentum.passed',
    });
    pushCompactWindowEvent('momentumScoreSample', null, {
      mint,
      momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
      momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
      momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
      topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 5) : [],
      topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 5) : [],
      final: 'momentum.passed',
    });
    if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
      counters.watchlist.hotLiqBypassReachedMomentum = Number(counters.watchlist.hotLiqBypassReachedMomentum || 0) + 1;
      counters.watchlist.hotPostBypassReachedMomentum = Number(counters.watchlist.hotPostBypassReachedMomentum || 0) + 1;
      if (hotBypassTraceCtx) hotBypassTraceCtx._momentumPassed = true;
    }
    if (enrichedRefreshUsed && wasRouteAvailableOnly) {
      counters.watchlist.hotEnrichedRouteOnlyReachedMomentum = Number(counters.watchlist.hotEnrichedRouteOnlyReachedMomentum || 0) + 1;
    }
    momentumPassedThisEval = true;
    if (row?.meta?.preRunner?.taggedAtMs) {
      counters.watchlist.preRunnerReachedMomentum = Number(counters.watchlist.preRunnerReachedMomentum || 0) + 1;
      counters.watchlist.preRunnerLast10 ||= [];
      for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
          counters.watchlist.preRunnerLast10[i].finalStageReached = 'momentum';
          break;
        }
      }
    }
    if (row?.meta?.burst?.taggedAtMs) {
      counters.watchlist.burstReachedMomentum = Number(counters.watchlist.burstReachedMomentum || 0) + 1;
      counters.watchlist.burstLast10 ||= [];
      for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.burstLast10[i]?.mint === mint) {
          counters.watchlist.burstLast10[i].finalStageReached = 'momentum';
          break;
        }
      }
    }
    canaryLog('momentum', 'passed');
    counters.watchlist.triggerHits += 1;
    row.lastTriggerHitAtMs = nowMs;
    row.staleCycles = 0;

    let report = null;
    let mcap = { ok: true, reason: 'skipped', mcapUsd: null, decimals: null };
    let mcapComputed = { ok: false, reason: 'not_attempted', mcapUsd: null, decimals: null };

    const mcapCandidates = [
      { source: 'row.latest.mcapUsd', value: Number(row?.latest?.mcapUsd ?? 0) || 0 },
      { source: 'snapshot.marketCapUsd', value: Number(snapshot?.marketCapUsd ?? 0) || 0 },
      { source: 'pair.marketCap', value: Number(pair?.marketCap ?? 0) || 0 },
      { source: 'pair.fdv', value: Number(pair?.fdv ?? 0) || 0 },
    ];
    let preConfirmMcapSourceUsed = 'missing';
    let mcapForFilters = null;
    for (const c of mcapCandidates) {
      if (Number.isFinite(Number(c.value)) && Number(c.value) > 0) {
        mcapForFilters = Number(c.value);
        preConfirmMcapSourceUsed = String(c.source);
        break;
      }
    }

    const needsMcapComputation = (cfg.MCAP_FILTER_ENABLED || cfg.LIQ_RATIO_FILTER_ENABLED) && !(mcapForFilters > 0);

    const parallelResults = await Promise.allSettled([
      cfg.RUGCHECK_ENABLED ? getRugcheckReport(mint).catch(err => ({ _error: err })) : Promise.resolve(null),
      needsMcapComputation ? computeMcapUsd(cfg, pair, cfg.SOLANA_RPC_URL).catch(err => ({ ok: false, reason: 'error', _error: err })) : Promise.resolve({ ok: false, reason: 'not_needed' }),
    ]);

    if (cfg.RUGCHECK_ENABLED) {
      if (parallelResults[0].status === 'fulfilled') {
        report = parallelResults[0].value;
        if (report && !report._error) {
          const safe = isTokenSafe(report);
          if (!safe.ok) {
            if (fail('rugUnsafe', { stage: 'safety', cooldownMs: Math.min(cfg.WATCHLIST_MINT_TTL_MS, 5 * 60_000) }) === 'break') break;
            continue;
          }
        } else {
          if (fail('rugcheckFetch', { stage: 'safety' }) === 'break') break;
          continue;
        }
      } else {
        if (fail('rugcheckFetch', { stage: 'safety' }) === 'break') break;
        continue;
      }
    }

    if (needsMcapComputation) {
      if (parallelResults[1].status === 'fulfilled') {
        mcapComputed = parallelResults[1].value;
        if (!mcapComputed._error) {
          mcap = mcapComputed;
          if (mcapComputed.ok && Number(mcapComputed.mcapUsd || 0) > 0) {
            mcapForFilters = Number(mcapComputed.mcapUsd);
            preConfirmMcapSourceUsed = 'computeMcapUsd';
          }
        } else {
          if (fail('mcapFetch', { stage: 'filters' }) === 'break') break;
          continue;
        }
      } else {
        if (fail('mcapFetch', { stage: 'filters' }) === 'break') break;
        continue;
      }
    }

    if (mcapForFilters > 0 && !(mcap?.mcapUsd > 0)) {
      mcap = { ok: true, reason: 'resolvedFromNormalized', mcapUsd: Number(mcapForFilters), decimals: mcap?.decimals ?? null };
    }

    counters.watchlist.preConfirmMcapSourceUsed ||= {};
    counters.watchlist.preConfirmMcapSourceUsed[preConfirmMcapSourceUsed] = Number(counters.watchlist.preConfirmMcapSourceUsed[preConfirmMcapSourceUsed] || 0) + 1;

    const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
    const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
    const base = passesBaseFilters({ pair, minLiquidityUsd: effLiqFloor, minAgeHours: effMinAge });
    if (cfg.BASE_FILTERS_ENABLED && !base.ok) {
      if (fail('baseFiltersFailed', { stage: 'filters', cooldownMs: 60_000 }) === 'break') break;
      continue;
    }

    const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
    if (cfg.MCAP_FILTER_ENABLED) {
      if (!(Number(mcapForFilters || 0) > 0)) {
        counters.watchlist.preConfirmMcapMissingRejected = Number(counters.watchlist.preConfirmMcapMissingRejected || 0) + 1;
        if (fail('mcapMissing', { stage: 'filters', meta: { mcapSourceUsed: preConfirmMcapSourceUsed, computedReason: mcapComputed?.reason || null } }) === 'break') break;
        continue;
      }
      if (Number(mcapForFilters || 0) < Number(effMinMcap || 0)) {
        counters.watchlist.preConfirmMcapLowRejected = Number(counters.watchlist.preConfirmMcapLowRejected || 0) + 1;
        if (fail('mcapLow', { stage: 'filters', meta: { mcapSourceUsed: preConfirmMcapSourceUsed, mcapForFilters, required: effMinMcap } }) === 'break') break;
        continue;
      }
    }

    const effRatio = state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO;
    const reqLiq = Math.max(effLiqFloor, effRatio * Number(mcapForFilters || 0));
    if (cfg.LIQ_RATIO_FILTER_ENABLED && liqUsd < reqLiq) {
      if (fail('liqRatioFailed', { stage: 'filters' }) === 'break') break;
      continue;
    }

    if (!solUsdNow) {
      if (fail('solUsdMissing', { stage: 'execution', cooldownMs: 15_000 }) === 'break') break;
      continue;
    }
    if (!executionAllowed) {
      const why = executionAllowedReason || 'unknown';
      if (fail(`executionDisabled.${why}`, { stage: 'execution', cooldownMs: 15_000 }) === 'break') break;
      continue;
    }

    const throttle = canOpenNewEntry({ state, nowMs, maxNewEntriesPerHour: cfg.MAX_NEW_ENTRIES_PER_HOUR });
    if (!throttle.ok) {
      if (fail('throttleBlocked', { stage: 'execution' }) === 'break') break;
      continue;
    }

    let solForReserve = 0;
    try {
      solForReserve = (await getSolBalanceLamports(conn, pub)) / 1e9;
    } catch {
      solForReserve = 0;
    }
    const softReserve = applySoftReserveToUsdTarget({
      solBalance: solForReserve,
      solUsd: solUsdNow,
      usdTarget: cfg.MAX_POSITION_USDC,
      minSolForFees: cfg.MIN_SOL_FOR_FEES,
      softReserveSol: cfg.CAPITAL_SOFT_RESERVE_SOL,
      retryBufferPct: cfg.CAPITAL_RETRY_BUFFER_PCT,
    });
    counters.watchlist.executionReserveObserved = Number(counters.watchlist.executionReserveObserved || 0) + 1;
    counters.watchlist.executionReserveReasons ||= {};
    const reserveReason = String(softReserve?.reason || 'unknown');
    counters.watchlist.executionReserveReasons[reserveReason] = Number(counters.watchlist.executionReserveReasons[reserveReason] || 0) + 1;
    counters.watchlist.executionReserveLast ||= [];
    counters.watchlist.executionReserveLast.push({
      t: nowIso(),
      mint,
      reserveRequired: Number(softReserve?.reserveSol || 0),
      reserveAvailable: Number(softReserve?.spendableSol || 0),
      walletBalanceUsed: Number(solForReserve || 0),
      reason: reserveReason,
      ok: !!softReserve?.ok,
    });
    if (counters.watchlist.executionReserveLast.length > 10) counters.watchlist.executionReserveLast = counters.watchlist.executionReserveLast.slice(-10);
    counters.watchlist.executionReserveTraceLast5 ||= [];
    const reserveOk = !!softReserve?.ok;
    const adjustedUsdTarget = Number(softReserve?.adjustedUsdTarget || 0);
    if (!reserveOk) {
      counters.watchlist.executionReserveBlocked = Number(counters.watchlist.executionReserveBlocked || 0) + 1;
      counters.watchlist.executionReserveBlockedReasons ||= {};
      counters.watchlist.executionReserveBlockedReasons[reserveReason] = Number(counters.watchlist.executionReserveBlockedReasons[reserveReason] || 0) + 1;
      counters.watchlist.executionReserveBlockedLast10 ||= [];
      counters.watchlist.executionReserveBlockedLast10.push({
        t: nowIso(),
        mint,
        reserveRequired: Number(softReserve?.reserveSol || 0),
        reserveAvailable: Number(softReserve?.spendableSol || 0),
        walletBalanceUsed: Number(solForReserve || 0),
        thresholdPolicyFailed: reserveReason,
        finalReserveRejectReason: 'execution.reserveBlocked',
      });
      if (counters.watchlist.executionReserveBlockedLast10.length > 10) counters.watchlist.executionReserveBlockedLast10 = counters.watchlist.executionReserveBlockedLast10.slice(-10);
      counters.watchlist.executionReserveTraceLast5.push({ t: nowIso(), mint, reserveOk, adjustedUsdTarget, branchTaken: 'reserve_policy_block', finalReason: 'execution.reserveBlocked' });
      if (counters.watchlist.executionReserveTraceLast5.length > 5) counters.watchlist.executionReserveTraceLast5 = counters.watchlist.executionReserveTraceLast5.slice(-5);
      if (fail('reserveBlocked', { stage: 'execution', meta: { reserveRequired: Number(softReserve?.reserveSol || 0), reserveAvailable: Number(softReserve?.spendableSol || 0), walletBalanceUsed: Number(solForReserve || 0), reserveReason } }) === 'break') break;
      continue;
    }
    if (adjustedUsdTarget < 1) {
      counters.watchlist.executionTargetUsdTooSmall = Number(counters.watchlist.executionTargetUsdTooSmall || 0) + 1;
      counters.watchlist.targetUsdTooSmallLast10 ||= [];
      counters.watchlist.targetUsdTooSmallLast10.push({
        t: nowIso(),
        mint,
        initialUsdTarget: Number(cfg.MAX_POSITION_USDC || 0),
        adjustedUsdTarget: Number(softReserve?.adjustedUsdTarget || 0),
        plannedSol: Number(softReserve?.plannedSol || 0),
        reserveRequired: Number(softReserve?.reserveSol || 0),
        reserveAvailable: Number(softReserve?.spendableSol || 0),
        retryBufferAppliedSol: Number((Number(softReserve?.plannedSol || 0) * Number(cfg.CAPITAL_RETRY_BUFFER_PCT || 0)) || 0),
        retryBufferPct: Number(cfg.CAPITAL_RETRY_BUFFER_PCT || 0),
        finalReason: 'execution.targetUsdTooSmall',
      });
      if (counters.watchlist.targetUsdTooSmallLast10.length > 10) counters.watchlist.targetUsdTooSmallLast10 = counters.watchlist.targetUsdTooSmallLast10.slice(-10);
      counters.watchlist.executionReserveTraceLast5.push({ t: nowIso(), mint, reserveOk, adjustedUsdTarget, branchTaken: 'target_usd_below_min', finalReason: 'execution.targetUsdTooSmall' });
      if (counters.watchlist.executionReserveTraceLast5.length > 5) counters.watchlist.executionReserveTraceLast5 = counters.watchlist.executionReserveTraceLast5.slice(-5);
      if (fail('targetUsdTooSmall', { stage: 'execution', meta: { adjustedUsdTarget, reserveReason } }) === 'break') break;
      continue;
    }
    counters.watchlist.executionReserveTraceLast5.push({ t: nowIso(), mint, reserveOk, adjustedUsdTarget, branchTaken: 'pass', finalReason: 'none' });
    if (counters.watchlist.executionReserveTraceLast5.length > 5) counters.watchlist.executionReserveTraceLast5 = counters.watchlist.executionReserveTraceLast5.slice(-5);

    const finalUsdTarget = softReserve.adjustedUsdTarget;
    const solLamportsFinal = toBaseUnits((finalUsdTarget / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);

    const routeMeta = await resolveWatchlistRouteMeta({
      cfg,
      state,
      mint,
      row,
      solUsdNow,
      nowMs,
      counters,
    });

    let expectedOutAmount = null;
    let expectedInAmount = null;
    let confirmPriceImpactPct = null;
    const confirmSlippageBps = Number(cfg.DEFAULT_SLIPPAGE_BPS || 0);
    let usedRouteCacheForAttempt = false;
    if (routeMeta.fromCache) {
      usedRouteCacheForAttempt = true;
      expectedOutAmount = Number(routeMeta?.quote?.outAmount || 0) || null;
      expectedInAmount = Number(routeMeta?.quote?.inAmount || 0) || null;
      confirmPriceImpactPct = Number(routeMeta?.quote?.priceImpactPct || 0) || null;
    } else {
      const confirmDelayMs = Math.max(200, Math.round(cfg.CONFIRM_DELAY_MIN_MS + (Math.random() * (Math.max(cfg.CONFIRM_DELAY_MAX_MS, cfg.CONFIRM_DELAY_MIN_MS) - cfg.CONFIRM_DELAY_MIN_MS))));
      await new Promise((r) => setTimeout(r, confirmDelayMs));

      let quoteFinal;
      try {
        quoteFinal = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: solLamportsFinal, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
      } catch {
        if (fail('quoteFailed', { stage: 'confirm' }) === 'break') break;
        continue;
      }
      const pi2 = Number(quoteFinal?.priceImpactPct || 0);
      confirmPriceImpactPct = pi2 || null;
      const confirmMaxPi = cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT;
      if (pi2 && pi2 > confirmMaxPi) {
        if (fail('confirmPriceImpact', { stage: 'confirm' }) === 'break') break;
        continue;
      }
      if (!quoteFinal?.routePlan?.length) {
        if (fail('confirmNoRoute', { stage: 'confirm' }) === 'break') break;
        continue;
      }
      expectedOutAmount = Number(quoteFinal?.outAmount || 0) || null;
      expectedInAmount = Number(quoteFinal?.inAmount || solLamportsFinal || 0) || null;
      cacheRouteReadyMint({ state, cfg, mint, quote: quoteFinal, nowMs, source: immediateMode ? 'immediate-final-quote' : 'watchlist-final-quote' });
    }

    const canonicalCarryObj = state?.watchlist?.mints?.[mint]?.meta?.confirmTxCarry || null;
    const runtimeCarryObj = state?.runtime?.confirmTxCarryByMint?.[mint] || null;
    const carryObj = row?.meta?.confirmTxCarry || canonicalCarryObj || runtimeCarryObj || null;
    const carryPresent = !!(carryObj && Number(carryObj?.atMs || 0) > 0);
    recordConfirmCarryTrace(state, mint, 'preConfirm', {
      carryPresent,
      carryTx1m: Number(carryObj?.tx1m || 0) || null,
      carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
      carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
      canonicalCarryPresent: !!(canonicalCarryObj && Number(canonicalCarryObj?.atMs || 0) > 0),
      runtimeCarryPresent: !!(runtimeCarryObj && Number(runtimeCarryObj?.atMs || 0) > 0),
      rowPath: `evaluateWatchlistRows.row.meta.confirmTxCarry`,
    });
    const confirmTxResolved = await resolveConfirmTxMetrics({ state, row, snapshot, pair, mint, birdseye });
    const confirmSigReasons = {
      ...(sig?.reasons || {}),
      tx_1m: Number(confirmTxResolved?.tx1m || 0),
      tx_5m_avg: Number(confirmTxResolved?.tx5mAvg || 0),
      tx_30m_avg: Number(confirmTxResolved?.tx30mAvg || 0),
      buySellRatio: Number(confirmTxResolved?.buySellRatio || 0),
    };
    const confirmTx1m = Number(confirmSigReasons?.tx_1m || 0);
    const confirmTx5mAvg = Number(confirmSigReasons?.tx_5m_avg || 0);
    const confirmTx30mAvg = Number(confirmSigReasons?.tx_30m_avg || 0);
    const confirmTxAccelObserved = confirmTx5mAvg > 0 ? (confirmTx1m / Math.max(1, confirmTx5mAvg)) : 0;
    const confirmTxAccelThreshold = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
    const confirmTxAccelMissDistance = Math.max(0, confirmTxAccelThreshold - confirmTxAccelObserved);
    const confirmBuySellRatioObserved = Number(confirmSigReasons?.buySellRatio || 0);
    const confirmBuySellThreshold = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
    const confirmTxMetricSource = String(confirmTxResolved?.source || 'unknown');
    recordConfirmCarryTrace(state, mint, 'confirmEval', {
      carryPresent,
      carryTx1m: Number(carryObj?.tx1m || 0) || null,
      carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
      carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
      canonicalCarryPresent: !!(canonicalCarryObj && Number(canonicalCarryObj?.atMs || 0) > 0),
      runtimeCarryPresent: !!(runtimeCarryObj && Number(runtimeCarryObj?.atMs || 0) > 0),
      txMetricSourceUsed: confirmTxMetricSource,
      tx1m: Number.isFinite(confirmTx1m) ? confirmTx1m : null,
      tx5mAvg: Number.isFinite(confirmTx5mAvg) ? confirmTx5mAvg : null,
      tx30mAvg: Number.isFinite(confirmTx30mAvg) ? confirmTx30mAvg : null,
      rowPath: `confirm.eval(sigReasons from resolved carry chain)`,
    });

    confirmReachedThisEval = true;
    if (row?.meta?.preRunner?.taggedAtMs) {
      counters.watchlist.preRunnerReachedConfirm = Number(counters.watchlist.preRunnerReachedConfirm || 0) + 1;
      counters.watchlist.preRunnerLast10 ||= [];
      for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
          counters.watchlist.preRunnerLast10[i].finalStageReached = 'confirm';
          break;
        }
      }
    }
    if (row?.meta?.burst?.taggedAtMs) {
      counters.watchlist.burstReachedConfirm = Number(counters.watchlist.burstReachedConfirm || 0) + 1;
      counters.watchlist.burstLast10 ||= [];
      for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.burstLast10[i]?.mint === mint) {
          counters.watchlist.burstLast10[i].finalStageReached = 'confirm';
          break;
        }
      }
    }
    pushCompactWindowEvent('confirmReached');
    pushCompactWindowEvent('postMomentumFlow', null, {
      mint,
      liq: Number(liqUsd || 0),
      mcap: Number(mcapHot || 0),
      ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
      freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
      priceImpactPct: confirmPriceImpactPct,
      slippageBps: confirmSlippageBps,
      stage: 'confirm',
      outcome: 'reached',
      reason: 'none',
      txAccelObserved: Number.isFinite(confirmTxAccelObserved) ? confirmTxAccelObserved : null,
      txAccelThreshold: confirmTxAccelThreshold,
      txAccelMissDistance: Number.isFinite(confirmTxAccelMissDistance) ? confirmTxAccelMissDistance : null,
      tx1m: Number.isFinite(confirmTx1m) ? confirmTx1m : null,
      tx5mAvg: Number.isFinite(confirmTx5mAvg) ? confirmTx5mAvg : null,
      tx30mAvg: Number.isFinite(confirmTx30mAvg) ? confirmTx30mAvg : null,
      buySellRatioObserved: Number.isFinite(confirmBuySellRatioObserved) ? confirmBuySellRatioObserved : null,
      buySellThreshold: confirmBuySellThreshold,
      txMetricSource: confirmTxMetricSource,
      txMetricMissing: !(Number.isFinite(confirmTx1m) && Number.isFinite(confirmTx5mAvg) && confirmTx1m > 0 && confirmTx5mAvg > 0),
      carryPresent,
      carryTx1m: Number(carryObj?.tx1m || 0) || null,
      carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
      carryTx30mAvg: Number(carryObj?.tx30mAvg || 0) || null,
      carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
    });
    const confirmMinLiqUsd = Number(cfg.LIVE_CONFIRM_MIN_LIQ_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD);
    const attemptMinLiqUsd = Number(cfg.LIVE_ATTEMPT_MIN_LIQ_USD ?? cfg.LIVE_CONFIRM_MIN_LIQ_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD);
    const liqForEntry = Number(snapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0) || 0;
    if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
      counters.watchlist.hotLiqBypassReachedConfirm = Number(counters.watchlist.hotLiqBypassReachedConfirm || 0) + 1;
      counters.watchlist.hotPostBypassReachedConfirm = Number(counters.watchlist.hotPostBypassReachedConfirm || 0) + 1;
    }
    if (!((process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true') && liqForEntry < confirmMinLiqUsd) {
      counters.watchlist.confirmFullLiqRejected = Number(counters.watchlist.confirmFullLiqRejected || 0) + 1;
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.fullLiqRejected', momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
      if (fail('fullLiqRejected', { stage: 'confirm', cooldownMs: 20_000, meta: { liqForEntry, required: confirmMinLiqUsd } }) === 'break') break;
      continue;
    }

    state.runtime ||= {};
    state.runtime.confirmLiqTrack ||= {};
    const confirmLiqKey = String(mint || pair?.baseToken?.address || '').trim();
    const confirmLiqNow = Number(liqForEntry || 0);
    const confirmPrev = confirmLiqKey ? (state.runtime.confirmLiqTrack[confirmLiqKey] || null) : null;
    const confirmLiq60sAgo = (confirmPrev && (nowMs - Number(confirmPrev.tsMs || 0)) <= 60_000)
      ? Number(confirmPrev.liqUsd || 0)
      : null;
    const confirmLiqDropPct = (confirmLiq60sAgo && confirmLiq60sAgo > 0)
      ? ((confirmLiq60sAgo - confirmLiqNow) / confirmLiq60sAgo)
      : null;
    counters.watchlist.confirmLiqDrop60sCandidates = Number(counters.watchlist.confirmLiqDrop60sCandidates || 0) + 1;
    counters.watchlist.confirmLiqDrop60sLast3 ||= [];
    counters.watchlist.confirmLiqDrop60sLast3.push({
      t: nowIso(),
      mint,
      liqNow: confirmLiqNow,
      liq60sAgo: confirmLiq60sAgo,
      liqDropPct: Number.isFinite(confirmLiqDropPct) ? confirmLiqDropPct : null,
    });
    if (counters.watchlist.confirmLiqDrop60sLast3.length > 3) counters.watchlist.confirmLiqDrop60sLast3 = counters.watchlist.confirmLiqDrop60sLast3.slice(-3);
    if (confirmLiqKey) state.runtime.confirmLiqTrack[confirmLiqKey] = { liqUsd: confirmLiqNow, tsMs: nowMs };
    if (Number.isFinite(confirmLiqDropPct) && confirmLiqDropPct > 0.12) {
      counters.watchlist.confirmLiqDrop60sRejected = Number(counters.watchlist.confirmLiqDrop60sRejected || 0) + 1;
      if (fail('liqDrop60sRejected', { stage: 'confirm', cooldownMs: 20_000, meta: { liqNow: confirmLiqNow, liq60sAgo: confirmLiq60sAgo, liqDropPct: confirmLiqDropPct } }) === 'break') break;
      continue;
    }

    const mcapForEntry = Number(mcap?.mcapUsd ?? row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || 0;
    if (!(mcapForEntry > 0)) {
      counters.watchlist.confirmMcapMissingRejected = Number(counters.watchlist.confirmMcapMissingRejected || 0) + 1;
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.mcapMissingRejected', momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
      if (fail('mcapMissingRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') break;
      continue;
    }

    const confirmMinAgeHours = Number(state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS ?? 0);
    const confirmPairCreatedAt = Number(snapshot?.pair?.pairCreatedAt ?? pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0) || null;
    const confirmAgeSec = confirmPairCreatedAt ? Math.max(0, (nowMs - confirmPairCreatedAt) / 1000) : null;
    if (confirmMinAgeHours > 0 && !(confirmAgeSec != null)) {
      counters.watchlist.confirmAgeMissingRejected = Number(counters.watchlist.confirmAgeMissingRejected || 0) + 1;
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.ageMissingRejected', momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
      if (fail('ageMissingRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') break;
      continue;
    }

    const continuationActive = (process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true';
    const mcapFreshnessForConfirmMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
    if (!continuationActive && Number.isFinite(mcapFreshnessForConfirmMs) && mcapFreshnessForConfirmMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
      counters.watchlist.confirmMcapStaleRejected = Number(counters.watchlist.confirmMcapStaleRejected || 0) + 1;
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.mcapStaleRejected', momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
      if (fail('mcapStaleRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') break;
      continue;
    }

    state.runtime ||= {};
    state.runtime.confirmRetryGateByMint ||= {};
    state.runtime.confirmRetryRequalifiedPassed ||= 0;
    const retryGate = state.runtime.confirmRetryGateByMint[mint] || null;
    const retryStartPrice = Number(snapshot?.priceUsd ?? row?.latest?.priceUsd ?? pair?.priceUsd ?? 0) || 0;
    const retryMomentumScore = Number(confirmSigReasons?.momentumScore || sig?.reasons?.momentumScore || 0) || 0;
    const retryWalletExpansion = Number(confirmSigReasons?.walletExpansion || sig?.reasons?.walletExpansion || 0) || 0;
    const retryTxAccel = Number.isFinite(confirmTxAccelObserved) ? Number(confirmTxAccelObserved) : 0;
    let retryImprovedThisPass = false;
    if (continuationActive && retryGate) {
      const retryMinDelayMs = Math.max(3000, Number(process.env.CONFIRM_RETRY_MIN_DELAY_MS || 10000));
      const retryAgeMs = Math.max(0, nowMs - Number(retryGate?.failedAtMs || 0));
      const improvedMomentum = retryMomentumScore > (Number(retryGate?.momentumScore || 0) + 1);
      const improvedTx = retryTxAccel > (Number(retryGate?.txAccelObserved || 0) + 0.10);
      const improvedWallet = retryWalletExpansion > (Number(retryGate?.walletExpansion || 0) + 0.05);
      const improvedBreakout = retryStartPrice > (Number(retryGate?.startPrice || 0) * 1.002);
      retryImprovedThisPass = !!(improvedMomentum || improvedTx || improvedWallet || improvedBreakout);
      const retryReadyByTime = retryAgeMs >= retryMinDelayMs;
      if (!retryImprovedThisPass || !retryReadyByTime) {
        const retryReason = !retryReadyByTime ? 'confirmContinuation.retryCooldown' : 'confirmContinuation.retryNoImprovement';
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(liqForEntry || 0),
          mcap: Number(mcapForEntry || 0),
          ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
          priceImpactPct: confirmPriceImpactPct,
          slippageBps: confirmSlippageBps,
          stage: 'confirm',
          outcome: 'rejected',
          reason: retryReason,
          continuationMode: true,
          continuationPassReason: 'none',
        });
        if (fail(retryReason, { stage: 'confirm', cooldownMs: 20_000, meta: { retryGate, retryAgeMs, retryMinDelayMs } }) === 'break') break;
        continue;
      }
    }

    const confirmStartLiqUsd = Number(liqForEntry || 0) || 0;
    const confirmGate = continuationActive
      ? await confirmContinuationGate({ cfg, mint, row, snapshot, pair, confirmMinLiqUsd, confirmPriceImpactPct, confirmStartLiqUsd })
      : confirmQualityGate({ cfg, sigReasons: confirmSigReasons, snapshot });
    if (!confirmGate.ok) {
      const rejectReason = continuationActive ? `confirmContinuation.${String(confirmGate?.failReason || 'windowExpired')}` : String(confirmGate.reason || 'confirmGateRejected');
      pushCompactWindowEvent('postMomentumFlow', null, {
        mint,
        liq: Number(liqForEntry || 0),
        mcap: Number(mcapForEntry || 0),
        ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
        priceImpactPct: confirmPriceImpactPct,
        slippageBps: confirmSlippageBps,
        stage: 'confirm',
        outcome: 'rejected',
        reason: rejectReason,
        txAccelObserved: Number.isFinite(confirmTxAccelObserved) ? confirmTxAccelObserved : null,
        txAccelThreshold: confirmTxAccelThreshold,
        txAccelMissDistance: Number.isFinite(confirmTxAccelMissDistance) ? confirmTxAccelMissDistance : null,
        tx1m: Number.isFinite(confirmTx1m) ? confirmTx1m : null,
        tx5mAvg: Number.isFinite(confirmTx5mAvg) ? confirmTx5mAvg : null,
        tx30mAvg: Number.isFinite(confirmTx30mAvg) ? confirmTx30mAvg : null,
        buySellRatioObserved: Number.isFinite(confirmBuySellRatioObserved) ? confirmBuySellRatioObserved : null,
        buySellThreshold: confirmBuySellThreshold,
        txMetricSource: confirmTxMetricSource,
        txMetricMissing: !(Number.isFinite(confirmTx1m) && Number.isFinite(confirmTx5mAvg) && confirmTx1m > 0 && confirmTx5mAvg > 0),
        carryPresent,
        carryTx1m: Number(carryObj?.tx1m || 0) || null,
        carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
        carryTx30mAvg: Number(carryObj?.tx30mAvg || 0) || null,
        carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
        continuationMode: continuationActive,
        continuationPassReason: continuationActive ? String(confirmGate?.passReason || 'none') : null,
        continuationStartPrice: Number.isFinite(Number(confirmGate?.diag?.startPrice)) ? Number(confirmGate.diag.startPrice) : null,
        continuationHighPrice: Number.isFinite(Number(confirmGate?.diag?.highPrice)) ? Number(confirmGate.diag.highPrice) : null,
        continuationLowPrice: Number.isFinite(Number(confirmGate?.diag?.lowPrice)) ? Number(confirmGate.diag.lowPrice) : null,
        continuationFinalPrice: Number.isFinite(Number(confirmGate?.diag?.finalPrice)) ? Number(confirmGate.diag.finalPrice) : null,
        continuationMaxRunupPct: Number.isFinite(Number(confirmGate?.diag?.maxRunupPctWithinConfirm)) ? Number(confirmGate.diag.maxRunupPctWithinConfirm) : null,
        continuationMaxDipPct: Number.isFinite(Number(confirmGate?.diag?.maxDipPctWithinConfirm)) ? Number(confirmGate.diag.maxDipPctWithinConfirm) : null,
        continuationTimeToRunupPassMs: Number.isFinite(Number(confirmGate?.diag?.timeToRunupPassMs)) ? Number(confirmGate.diag.timeToRunupPassMs) : null,
        continuationTimeoutWasFlatOrNegative: !!confirmGate?.diag?.timeoutWasFlatOrNegative,
        continuationConfirmStartLiqUsd: Number.isFinite(Number(confirmGate?.diag?.confirmStartLiqUsd)) ? Number(confirmGate.diag.confirmStartLiqUsd) : null,
        continuationCurrentLiqUsd: Number.isFinite(Number(confirmGate?.diag?.currentLiqUsd)) ? Number(confirmGate.diag.currentLiqUsd) : null,
        continuationLiqChangePct: Number.isFinite(Number(confirmGate?.diag?.liqChangePct)) ? Number(confirmGate.diag.liqChangePct) : null,
        continuationPriceSource: String(confirmGate?.diag?.priceSource || 'unknown'),
        continuationInitialSourceUsed: String(confirmGate?.diag?.initialSourceUsed || 'unknown'),
        continuationDominantSourceUsed: String(confirmGate?.diag?.dominantSourceUsed || 'unknown'),
        continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
        continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
        continuationUniqueOhlcvTicksWithinWindow: Number(confirmGate?.diag?.uniqueOhlcvTicksWithinWindow || 0) || 0,
        continuationTradeUpdateCountWithinWindow: Number(confirmGate?.diag?.tradeUpdateCountWithinWindow || 0) || 0,
        continuationUniqueTradeTicksWithinWindow: Number(confirmGate?.diag?.uniqueTradeTicksWithinWindow || 0) || 0,
        continuationRunupSourceUsed: String(confirmGate?.diag?.runupSourceUsed || 'no_runup'),
        continuationTradeSequenceSourceUsed: String(confirmGate?.diag?.tradeSequenceSourceUsed || 'ws_trade'),
        continuationTradeTickCountAtRunupMoment: Number(confirmGate?.diag?.tradeTickCountAtRunupMoment || 0) || 0,
        continuationTradeSequenceEligibleAtRunup: !!confirmGate?.diag?.tradeSequenceEligibleAtRunup,
        continuationMaxConsecutiveTradeUpticks: Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0) || 0,
        continuationMinConsecutiveTradeUpticks: Number(confirmGate?.diag?.minConsecutiveTradeUpticks || 0) || 0,
        continuationRequireTradeUpticks: !!confirmGate?.diag?.requireTradeUpticks,
        continuationSelectedTradeReads: Number(confirmGate?.diag?.selectedTradeReads || 0) || 0,
        continuationSelectedOhlcvReads: Number(confirmGate?.diag?.selectedOhlcvReads || 0) || 0,
        continuationWsUpdateTimestamps: Array.isArray(confirmGate?.diag?.wsUpdateTimestamps) ? confirmGate.diag.wsUpdateTimestamps.slice(0, 24) : [],
        continuationWsUpdatePrices: Array.isArray(confirmGate?.diag?.wsUpdatePrices) ? confirmGate.diag.wsUpdatePrices.slice(0, 24) : [],
        continuationTradeUpdateTimestamps: Array.isArray(confirmGate?.diag?.tradeUpdateTimestamps) ? confirmGate.diag.tradeUpdateTimestamps.slice(0, 24) : [],
        continuationTradeUpdatePrices: Array.isArray(confirmGate?.diag?.tradeUpdatePrices) ? confirmGate.diag.tradeUpdatePrices.slice(0, 24) : [],
      });
      if (continuationActive && String(confirmGate?.failReason || '') === 'dataUnavailable') {
        continue;
      }
      if (continuationActive && ['windowExpiredStall', 'windowExpired'].includes(String(confirmGate?.failReason || ''))) {
        state.runtime ||= {};
        state.runtime.confirmRetryGateByMint ||= {};
        state.runtime.confirmRetryGateByMint[mint] = {
          failedAtMs: nowMs,
          failReason: String(confirmGate?.failReason || 'windowExpiredStall'),
          momentumScore: retryMomentumScore,
          txAccelObserved: retryTxAccel,
          walletExpansion: retryWalletExpansion,
          startPrice: Number(confirmGate?.diag?.startPrice || retryStartPrice || 0) || 0,
          highPrice: Number(confirmGate?.diag?.highPrice || 0) || 0,
        };
      }
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: `confirm.${rejectReason}`, momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
      if (fail(rejectReason, { stage: 'confirm', cooldownMs: 20_000, meta: {
        txAccelObserved: Number.isFinite(confirmTxAccelObserved) ? confirmTxAccelObserved : null,
        txAccelThreshold: confirmTxAccelThreshold,
        txAccelMissDistance: Number.isFinite(confirmTxAccelMissDistance) ? confirmTxAccelMissDistance : null,
        tx1m: Number.isFinite(confirmTx1m) ? confirmTx1m : null,
        tx5mAvg: Number.isFinite(confirmTx5mAvg) ? confirmTx5mAvg : null,
        tx30mAvg: Number.isFinite(confirmTx30mAvg) ? confirmTx30mAvg : null,
        buySellRatioObserved: Number.isFinite(confirmBuySellRatioObserved) ? confirmBuySellRatioObserved : null,
        buySellThreshold: confirmBuySellThreshold,
        txMetricSource: confirmTxMetricSource,
        txMetricMissing: !(Number.isFinite(confirmTx1m) && Number.isFinite(confirmTx5mAvg) && confirmTx1m > 0 && confirmTx5mAvg > 0),
        carryPresent,
        carryTx1m: Number(carryObj?.tx1m || 0) || null,
        carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
        carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
        continuation: confirmGate?.diag || null,
      } }) === 'break') break;
      continue;
    }

    bumpWatchlistFunnel(counters, 'confirmPassed', { nowMs });
    pushCompactWindowEvent('confirmPassed');
    pushCompactWindowEvent('postMomentumFlow', null, {
      mint,
      liq: Number(liqForEntry || 0),
      mcap: Number(mcapForEntry || 0),
      ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
      freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
      priceImpactPct: confirmPriceImpactPct,
      slippageBps: confirmSlippageBps,
      stage: 'confirm',
      outcome: 'passed',
      reason: 'none',
      txAccelObserved: Number.isFinite(confirmTxAccelObserved) ? confirmTxAccelObserved : null,
      txAccelThreshold: confirmTxAccelThreshold,
      txAccelMissDistance: Number.isFinite(confirmTxAccelMissDistance) ? confirmTxAccelMissDistance : null,
      tx1m: Number.isFinite(confirmTx1m) ? confirmTx1m : null,
      tx5mAvg: Number.isFinite(confirmTx5mAvg) ? confirmTx5mAvg : null,
      tx30mAvg: Number.isFinite(confirmTx30mAvg) ? confirmTx30mAvg : null,
      buySellRatioObserved: Number.isFinite(confirmBuySellRatioObserved) ? confirmBuySellRatioObserved : null,
      buySellThreshold: confirmBuySellThreshold,
      txMetricSource: confirmTxMetricSource,
      txMetricMissing: !(Number.isFinite(confirmTx1m) && Number.isFinite(confirmTx5mAvg) && confirmTx1m > 0 && confirmTx5mAvg > 0),
      carryPresent,
      carryTx1m: Number(carryObj?.tx1m || 0) || null,
      carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
      carryTx30mAvg: Number(carryObj?.tx30mAvg || 0) || null,
      carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
      continuationMode: continuationActive,
      continuationPassReason: continuationActive ? String(confirmGate?.passReason || 'none') : null,
      continuationStartPrice: Number.isFinite(Number(confirmGate?.diag?.startPrice)) ? Number(confirmGate.diag.startPrice) : null,
      continuationHighPrice: Number.isFinite(Number(confirmGate?.diag?.highPrice)) ? Number(confirmGate.diag.highPrice) : null,
      continuationLowPrice: Number.isFinite(Number(confirmGate?.diag?.lowPrice)) ? Number(confirmGate.diag.lowPrice) : null,
      continuationFinalPrice: Number.isFinite(Number(confirmGate?.diag?.finalPrice)) ? Number(confirmGate.diag.finalPrice) : null,
      continuationMaxRunupPct: Number.isFinite(Number(confirmGate?.diag?.maxRunupPctWithinConfirm)) ? Number(confirmGate.diag.maxRunupPctWithinConfirm) : null,
      continuationMaxDipPct: Number.isFinite(Number(confirmGate?.diag?.maxDipPctWithinConfirm)) ? Number(confirmGate.diag.maxDipPctWithinConfirm) : null,
      continuationTimeToRunupPassMs: Number.isFinite(Number(confirmGate?.diag?.timeToRunupPassMs)) ? Number(confirmGate.diag.timeToRunupPassMs) : null,
      continuationTimeoutWasFlatOrNegative: !!confirmGate?.diag?.timeoutWasFlatOrNegative,
      continuationConfirmStartLiqUsd: Number.isFinite(Number(confirmGate?.diag?.confirmStartLiqUsd)) ? Number(confirmGate.diag.confirmStartLiqUsd) : null,
      continuationCurrentLiqUsd: Number.isFinite(Number(confirmGate?.diag?.currentLiqUsd)) ? Number(confirmGate.diag.currentLiqUsd) : null,
      continuationLiqChangePct: Number.isFinite(Number(confirmGate?.diag?.liqChangePct)) ? Number(confirmGate.diag.liqChangePct) : null,
      continuationPriceSource: String(confirmGate?.diag?.priceSource || 'unknown'),
      continuationInitialSourceUsed: String(confirmGate?.diag?.initialSourceUsed || 'unknown'),
      continuationDominantSourceUsed: String(confirmGate?.diag?.dominantSourceUsed || 'unknown'),
      continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
      continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
      continuationUniqueOhlcvTicksWithinWindow: Number(confirmGate?.diag?.uniqueOhlcvTicksWithinWindow || 0) || 0,
      continuationTradeUpdateCountWithinWindow: Number(confirmGate?.diag?.tradeUpdateCountWithinWindow || 0) || 0,
      continuationUniqueTradeTicksWithinWindow: Number(confirmGate?.diag?.uniqueTradeTicksWithinWindow || 0) || 0,
      continuationRunupSourceUsed: String(confirmGate?.diag?.runupSourceUsed || 'no_runup'),
      continuationTradeSequenceSourceUsed: String(confirmGate?.diag?.tradeSequenceSourceUsed || 'ws_trade'),
      continuationTradeTickCountAtRunupMoment: Number(confirmGate?.diag?.tradeTickCountAtRunupMoment || 0) || 0,
      continuationTradeSequenceEligibleAtRunup: !!confirmGate?.diag?.tradeSequenceEligibleAtRunup,
      continuationMaxConsecutiveTradeUpticks: Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0) || 0,
      continuationMinConsecutiveTradeUpticks: Number(confirmGate?.diag?.minConsecutiveTradeUpticks || 0) || 0,
      continuationRequireTradeUpticks: !!confirmGate?.diag?.requireTradeUpticks,
      continuationSelectedTradeReads: Number(confirmGate?.diag?.selectedTradeReads || 0) || 0,
      continuationSelectedOhlcvReads: Number(confirmGate?.diag?.selectedOhlcvReads || 0) || 0,
      continuationWsUpdateTimestamps: Array.isArray(confirmGate?.diag?.wsUpdateTimestamps) ? confirmGate.diag.wsUpdateTimestamps.slice(0, 24) : [],
      continuationWsUpdatePrices: Array.isArray(confirmGate?.diag?.wsUpdatePrices) ? confirmGate.diag.wsUpdatePrices.slice(0, 24) : [],
      continuationTradeUpdateTimestamps: Array.isArray(confirmGate?.diag?.tradeUpdateTimestamps) ? confirmGate.diag.tradeUpdateTimestamps.slice(0, 24) : [],
      continuationTradeUpdatePrices: Array.isArray(confirmGate?.diag?.tradeUpdatePrices) ? confirmGate.diag.tradeUpdatePrices.slice(0, 24) : [],
    });
    if (continuationActive && retryGate) {
      state.runtime ||= {};
      state.runtime.confirmRetryGateByMint ||= {};
      delete state.runtime.confirmRetryGateByMint[mint];
      if (retryImprovedThisPass) state.runtime.confirmRetryRequalifiedPassed = Number(state.runtime.confirmRetryRequalifiedPassed || 0) + 1;
    }
    canaryLog('confirm', 'passed');
    if (hotBypassTraceCtx) {
      counters.watchlist.hotPostBypassReachedConfirm = Number(counters.watchlist.hotPostBypassReachedConfirm || 0) + 1;
      hotBypassTraceCtx._confirmPassed = true;
      finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: null, momentumCounterIncremented: !!hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: true });
    }
    if (immediateMode) counters.watchlist.immediateConfirmPassed += 1;

    state.runtime ||= {};
    state.runtime.requalifyAfterStopByMint ||= {};
    const requalifyBlock = state.runtime.requalifyAfterStopByMint[mint] || null;
    if (requalifyBlock) {
      let allowAttemptAfterFastStop = false;
      try {
        if (requalifyBlock.fastStopActive) {
          const nowMsLocal = Date.now();
          const holdUntilMs = Number(requalifyBlock.holdUntilMs || 0);
          if (Number.isFinite(holdUntilMs) && holdUntilMs > 0 && nowMsLocal >= holdUntilMs) {
            allowAttemptAfterFastStop = true;
          } else {
            const requireNewHigh = (requalifyBlock.requireNewHigh ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH) === true;
            const requireTradeUpticks = (requalifyBlock.requireTradeUpticks ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS) === true;
            const minConsecutiveTradeUpticks = Math.max(1, Number(requalifyBlock.minConsecutiveTradeUpticks || cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2));
            const breakoutAboveUsd = Number(requalifyBlock.breakoutAboveUsd || 0);
            const currentPx = Number(snapshot?.priceUsd ?? row?.latest?.priceUsd ?? pair?.priceUsd ?? 0);
            const maxConsecutiveTradeUpticks = Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0);
            const newHighOk = !requireNewHigh || (currentPx > 0 && breakoutAboveUsd > 0 && currentPx > breakoutAboveUsd);
            const upticksOk = !requireTradeUpticks || maxConsecutiveTradeUpticks >= minConsecutiveTradeUpticks;
            allowAttemptAfterFastStop = newHighOk && upticksOk;
          }
        }
      } catch {
        allowAttemptAfterFastStop = false;
      }

      if (allowAttemptAfterFastStop) {
        delete state.runtime.requalifyAfterStopByMint[mint];
        counters.watchlist.requalifyClearedOnFastStopBreakout = Number(counters.watchlist.requalifyClearedOnFastStopBreakout || 0) + 1;
      } else {
        counters.watchlist.requalifyBlockedAttempts = Number(counters.watchlist.requalifyBlockedAttempts || 0) + 1;
        if (fail('attemptNeedsRequalify', { stage: 'attempt', meta: {
          blockedAtMs: Number(requalifyBlock?.blockedAtMs || 0),
          trigger: String(requalifyBlock?.trigger || 'stop'),
          fastStopActive: !!requalifyBlock?.fastStopActive,
          holdUntilMs: Number(requalifyBlock?.holdUntilMs || 0),
          breakoutAboveUsd: Number(requalifyBlock?.breakoutAboveUsd || 0),
          requireNewHigh: (requalifyBlock?.requireNewHigh ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH) === true,
          requireTradeUpticks: (requalifyBlock?.requireTradeUpticks ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS) === true,
          minConsecutiveTradeUpticks: Math.max(1, Number(requalifyBlock?.minConsecutiveTradeUpticks || cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2)),
          maxConsecutiveTradeUpticks: Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0),
        } }) === 'break') break;
        continue;
      }
    }

    const forceAttemptActive = cfg.FORCE_ATTEMPT_POLICY_ACTIVE === true;
    if (forceAttemptActive) {
      const policyState = ensureForceAttemptPolicyState(state);
      pruneForceAttemptPolicyWindows(policyState, nowMs);
      const guard = evaluateForceAttemptPolicyGuards({ cfg, policyState, row, mint, nowMs });
      if (!guard.ok) {
        counters.guardrails.forceAttemptBlocked = Number(counters.guardrails.forceAttemptBlocked || 0) + 1;
        counters.guardrails.forceAttemptBlockedReasons ||= {};
        counters.guardrails.forceAttemptBlockedReasons[guard.reason] = Number(counters.guardrails.forceAttemptBlockedReasons[guard.reason] || 0) + 1;
        if (fail(guard.reason, { stage: 'forcePolicy' }) === 'break') break;
        continue;
      }
      counters.guardrails.forceAttemptTriggered = Number(counters.guardrails.forceAttemptTriggered || 0) + 1;
      recordForceAttemptPolicyAttempt({ policyState, mint, nowMs });
    }

    const liqForAttempt = Number(snapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0) || 0;
    if (liqForAttempt < attemptMinLiqUsd) {
      counters.watchlist.attemptFullLiqRejected = Number(counters.watchlist.attemptFullLiqRejected || 0) + 1;
      if (fail('fullLiqRejected', { stage: 'attempt', cooldownMs: 20_000, meta: { liqForAttempt, required: attemptMinLiqUsd } }) === 'break') break;
      continue;
    }

    row.meta ||= {};
    row.meta.attemptSuppression ||= {};
    const suppress = row.meta.attemptSuppression;
    const attemptCooldownMs = Number(cfg.ATTEMPT_PER_MINT_COOLDOWN_MS || 1_800_000);
    const lastAttemptTs = Number(suppress.lastAttemptAtMs || 0);
    const withinAttemptCooldown = lastAttemptTs > 0 && (nowMs - lastAttemptTs) < attemptCooldownMs;
    const priceNowForSuppression = Number(snapshot?.priceUsd ?? row?.latest?.priceUsd ?? pair?.priceUsd ?? 0) || 0;
    const newHigh = priceNowForSuppression > 0 && Number(suppress.lastAttemptPriceUsd || 0) > 0
      ? (priceNowForSuppression > (Number(suppress.lastAttemptPriceUsd || 0) * Number(cfg.ATTEMPT_NEW_HIGH_MULTIPLIER || 1.03)))
      : false;
    const liqExpandedMaterially = liqForAttempt > 0 && Number(suppress.lastAttemptLiqUsd || 0) > 0
      ? (liqForAttempt > (Number(suppress.lastAttemptLiqUsd || 0) * Number(cfg.ATTEMPT_LIQ_EXPAND_MULTIPLIER || 1.20)))
      : false;
    if (withinAttemptCooldown && !(newHigh && liqExpandedMaterially)) {
      counters.watchlist.attemptMintSuppressed = Number(counters.watchlist.attemptMintSuppressed || 0) + 1;
      if (fail('attemptMintSuppressed', { stage: 'attempt', cooldownMs: Math.max(5_000, attemptCooldownMs - Math.max(0, nowMs - lastAttemptTs)), meta: { lastAttemptTs, attemptCooldownMs, newHigh, liqExpandedMaterially } }) === 'break') break;
      continue;
    }

    try {
      counters.watchlist.attemptBranchDebugLast10 ||= [];
      counters.watchlist.executionPathLast10 ||= [];
      const quoteBuilt = Number.isFinite(Number(expectedOutAmount)) && Number(expectedOutAmount) > 0;
      const quoteRefreshed = !usedRouteCacheForAttempt;
      const routeSource = usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote';
      const attemptEnteredAtMs = Date.now();
      const quoteAgeMs = null;
      const pushExecutionPath = ({ swapSubmissionEntered = false, outcome = 'unknown', finalReason = 'none' }) => {
        counters.watchlist.executionPathLast10.push({
          t: nowIso(), mint,
          attemptEntered: true,
          quoteBuilt,
          quoteRefreshed,
          routeSource,
          quoteAgeMs,
          swapSubmissionEntered: !!swapSubmissionEntered,
          outcome: String(outcome || 'unknown'),
          finalReason: String(finalReason || 'none'),
        });
        if (counters.watchlist.executionPathLast10.length > 10) counters.watchlist.executionPathLast10 = counters.watchlist.executionPathLast10.slice(-10);
      };
      const pushAttemptBranchDebug = ({ branchTaken, finalReason, swapSubmissionEntered = false }) => {
        counters.watchlist.attemptBranchDebugLast10.push({
          t: nowIso(),
          mint,
          attemptEntered: true,
          swapSubmissionEntered: !!swapSubmissionEntered,
          branchTaken: String(branchTaken || 'unknown'),
          finalReason: String(finalReason || 'none'),
        });
        if (counters.watchlist.attemptBranchDebugLast10.length > 10) counters.watchlist.attemptBranchDebugLast10 = counters.watchlist.attemptBranchDebugLast10.slice(-10);
      };
      counters.entryAttempts += 1;
      counters.funnel.attempts += 1;
      counters.watchlist.attempts += 1;
      if (isHot) counters.watchlist.hotAttempts += 1;
      if (immediateMode) counters.watchlist.immediateAttempts += 1;
      if (usedRouteCacheForAttempt) counters.watchlist.attemptFromRouteCache += 1;
      attemptReachedThisEval = true;
      if (row?.meta?.preRunner?.taggedAtMs) {
        counters.watchlist.preRunnerReachedAttempt = Number(counters.watchlist.preRunnerReachedAttempt || 0) + 1;
        counters.watchlist.preRunnerLast10 ||= [];
        for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
          if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
            counters.watchlist.preRunnerLast10[i].finalStageReached = 'attempt';
            break;
          }
        }
      }
      if (row?.meta?.burst?.taggedAtMs) {
        counters.watchlist.burstReachedAttempt = Number(counters.watchlist.burstReachedAttempt || 0) + 1;
        counters.watchlist.burstLast10 ||= [];
        for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
          if (counters.watchlist.burstLast10[i]?.mint === mint) {
            counters.watchlist.burstLast10[i].finalStageReached = 'attempt';
            break;
          }
        }
      }
      bumpWatchlistFunnel(counters, 'attempted', { nowMs });
      pushCompactWindowEvent('attempt');
      pushCompactWindowEvent('postMomentumFlow', null, {
        mint,
        liq: Number(liqForAttempt || 0),
        mcap: Number(mcapForEntry || 0),
        ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
        priceImpactPct: confirmPriceImpactPct,
        slippageBps: confirmSlippageBps,
        stage: 'attempt',
        outcome: 'reached',
        reason: 'none',
      });
      canaryLog('attempt', 'executeSwap');
      canaryRecord('attempt', 'executeSwap');
      row.lastAttemptAtMs = nowMs;
      row.attempts = Number(row.attempts || 0) + 1;
      row.totalAttempts = Number(row.totalAttempts || 0) + 1;
      row.meta ||= {};
      row.meta.attemptSuppression ||= {};
      row.meta.attemptSuppression.lastAttemptAtMs = nowMs;
      row.meta.attemptSuppression.lastAttemptPriceUsd = Number(snapshot?.priceUsd ?? row?.latest?.priceUsd ?? pair?.priceUsd ?? 0) || null;
      row.meta.attemptSuppression.lastAttemptLiqUsd = Number(liqForAttempt || 0) || null;
      if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: pair?.baseToken?.symbol || row?.pair?.baseToken?.symbol || null, tag: 'watchlist' })) {
        pushCompactWindowEvent('postMomentumFlow', null, {
          mint,
          liq: Number(liqForAttempt || 0),
          mcap: Number(mcapForEntry || 0),
          ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
          freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
          stage: 'swap',
          outcome: 'rejected',
          reason: 'entryCapacityBlocked',
        });
        pushAttemptBranchDebug({ branchTaken: 'capacityBlockedPreSwap', finalReason: 'execution.entryCapacityBlocked', swapSubmissionEntered: false });
        pushExecutionPath({ swapSubmissionEntered: false, outcome: 'noop', finalReason: 'execution.entryCapacityBlocked' });
        continue;
      }
      const decimalsHintForAttempt = [
        mcap?.decimals,
        row?.latest?.decimals,
        snapshot?.raw?.decimals,
        snapshot?.pair?.baseToken?.decimals,
        pair?.baseToken?.decimals,
      ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
      const swapSubmittedAtMs = Date.now();
      const entryRes = await openPosition(cfg, conn, wallet, state, solUsdNow, pair, mcap.mcapUsd, decimalsHintForAttempt, report, sig.reasons, {
        mint,
        tokenName: pair?.baseToken?.name || snapshot?.tokenName || snapshot?.raw?.name || row?.pair?.baseToken?.name || null,
        symbol: pair?.baseToken?.symbol || snapshot?.tokenSymbol || snapshot?.raw?.symbol || row?.pair?.baseToken?.symbol || null,
        entrySnapshot: snapshot,
        birdeyeEnabled: birdseye?.enabled,
        getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
        usdTarget: finalUsdTarget,
        slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
        expectedOutAmount,
        expectedInAmount,
        paperOnly: paperModeActive,
        stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
        stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
        trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
        trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
      });

      if (entryRes?.blocked) {
        pushAttemptBranchDebug({ branchTaken: 'swapSubmissionReturnedBlocked', finalReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`, swapSubmissionEntered: true });
        pushExecutionPath({ swapSubmissionEntered: true, outcome: 'blocked', finalReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}` });
        counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
        counters.guardrails.entryBlockedReasons ||= {};
        counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
        counters.guardrails.entryBlockedLast10 ||= [];
        counters.guardrails.entryBlockedLast10.push({
          t: nowIso(),
          mint,
          reason: String(entryRes?.reason || 'unknown'),
          pairBaseTokenAddress: String(entryRes?.meta?.pairBaseTokenAddress || pair?.baseToken?.address || ''),
          mintResolvedForDecimals: String(entryRes?.meta?.mintResolvedForDecimals || mint || ''),
          decimalsSource: String(entryRes?.meta?.decimalsSource || 'none'),
          decimalsSourcesTried: Array.isArray(entryRes?.meta?.decimalsSourcesTried) ? entryRes.meta.decimalsSourcesTried : [],
          missingLookup: Array.isArray(entryRes?.meta?.decimalsSourcesTried)
            ? (entryRes.meta.decimalsSourcesTried.filter((x) => !x?.ok).map((x) => String(x?.source || 'unknown')).join('>') || 'none')
            : 'none',
          finalMissingDecimalsReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`,
        });
        if (counters.guardrails.entryBlockedLast10.length > 10) counters.guardrails.entryBlockedLast10 = counters.guardrails.entryBlockedLast10.slice(-10);
        canaryRecord('swap', 'entryBlocked', { reason: entryRes.reason, meta: entryRes.meta || null });
        fail(`entryBlocked_${entryRes.reason}`, { stage: 'swap', cooldownMs: 5_000 });
        continue;
      }

      canaryRecord('swap', 'openPositionReturned', { signature: entryRes?.signature || null, ok: !!entryRes?.signature });
      pushAttemptBranchDebug({ branchTaken: 'swapSubmissionReturnedSuccess', finalReason: 'fill.passed', swapSubmissionEntered: true });
      pushExecutionPath({ swapSubmissionEntered: true, outcome: 'success', finalReason: 'fill.passed' });
      counters.entrySuccesses += 1;
      counters.funnel.fills += 1;
      counters.watchlist.fills += 1;
      if (isHot) counters.watchlist.hotFills += 1;
      if (immediateMode) counters.watchlist.immediateFills += 1;
      bumpWatchlistFunnel(counters, 'filled', { nowMs });
      if (row?.meta?.preRunner?.taggedAtMs) {
        counters.watchlist.preRunnerFilled = Number(counters.watchlist.preRunnerFilled || 0) + 1;
        counters.watchlist.preRunnerLast10 ||= [];
        for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
          if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
            counters.watchlist.preRunnerLast10[i].finalStageReached = 'fill';
            break;
          }
        }
      }
      if (row?.meta?.burst?.taggedAtMs) {
        counters.watchlist.burstFilled = Number(counters.watchlist.burstFilled || 0) + 1;
        counters.watchlist.burstLast10 ||= [];
        for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
          if (counters.watchlist.burstLast10[i]?.mint === mint) {
            counters.watchlist.burstLast10[i].finalStageReached = 'fill';
            break;
          }
        }
      }
      pushCompactWindowEvent('fill');
      const fillAtMs = Date.now();
      const sendToFillMs = Number.isFinite(Number(swapSubmittedAtMs)) ? Math.max(0, fillAtMs - Number(swapSubmittedAtMs)) : null;
      const totalAttemptToFillMs = Number.isFinite(Number(attemptEnteredAtMs)) ? Math.max(0, fillAtMs - Number(attemptEnteredAtMs)) : null;
      pushCompactWindowEvent('postMomentumFlow', null, {
        mint,
        liq: Number(liqForAttempt || 0),
        mcap: Number(mcapForEntry || 0),
        ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
        priceImpactPct: confirmPriceImpactPct,
        slippageBps: confirmSlippageBps,
        sendToFillMs,
        totalAttemptToFillMs,
        quoteAgeMs,
        stage: 'fill',
        outcome: 'passed',
        reason: 'none',
      });
      canaryLog('fill', 'opened');
      row.lastFillAtMs = nowMs;
      row.totalFills = Number(row.totalFills || 0) + 1;
      row.lastTriggerHitAtMs = nowMs;
      row.cooldownUntilMs = nowMs + (cfg.FORCE_ATTEMPT_POLICY_ACTIVE ? cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS : cfg.PAPER_ENTRY_COOLDOWN_MS);
      if (entryRes?.swapMeta?.attempted) {
        counters.retry.slippageRetryAttempted += 1;
        if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
        else counters.retry.slippageRetryFailed += 1;
      }
      recordEntryOpened({ state, nowMs });
      try {
        wsmgr.onFill(mint, {
          entryPrice: state.positions?.[mint]?.entryPriceUsd,
          stopPrice: state.positions?.[mint]?.stopPriceUsd,
          stopPct: null,
          trailingPct: state.positions?.[mint]?.trailDistancePct,
        });
      } catch (e) {}
      saveState(cfg.STATE_PATH, state);
    } catch (e) {
      counters.watchlist.attemptBranchDebugLast10 ||= [];
      counters.watchlist.attemptBranchDebugLast10.push({
        t: nowIso(),
        mint,
        attemptEntered: true,
        swapSubmissionEntered: true,
        branchTaken: 'swapSubmissionThrew',
        finalReason: `swapError(${safeMsg(e)})`,
      });
      if (counters.watchlist.attemptBranchDebugLast10.length > 10) counters.watchlist.attemptBranchDebugLast10 = counters.watchlist.attemptBranchDebugLast10.slice(-10);
      counters.watchlist.executionPathLast10 ||= [];
      counters.watchlist.executionPathLast10.push({
        t: nowIso(), mint, attemptEntered: true, quoteBuilt: Number.isFinite(Number(expectedOutAmount)) && Number(expectedOutAmount) > 0, quoteRefreshed: !usedRouteCacheForAttempt, routeSource: usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote', quoteAgeMs: null, swapSubmissionEntered: true, outcome: 'threw', finalReason: `swapError(${safeMsg(e)})`,
      });
      if (counters.watchlist.executionPathLast10.length > 10) counters.watchlist.executionPathLast10 = counters.watchlist.executionPathLast10.slice(-10);
      const degradeMsg = safeMsg(e);
      const m = /Quote degraded: out\s+(\d+)\s+<\s+min\s+(\d+)/i.exec(degradeMsg || '');
      if (m) {
        counters.watchlist.quoteDegradeLast10 ||= [];
        counters.watchlist.quoteDegradeLast10.push({
          t: nowIso(),
          mint,
          quotedOut: Number(expectedOutAmount || 0),
          finalOut: Number(m[1] || 0),
          minOut: Number(m[2] || 0),
          slippageBps: Number(cfg.DEFAULT_SLIPPAGE_BPS || 0),
          priceImpactPct: Number(confirmPriceImpactPct || 0) || null,
          quoteAgeMs: null,
          routeSource: usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote',
          quoteRefreshed: !usedRouteCacheForAttempt,
          routeChanged: null,
          finalReason: `swapError(${degradeMsg})`,
        });
        if (counters.watchlist.quoteDegradeLast10.length > 10) counters.watchlist.quoteDegradeLast10 = counters.watchlist.quoteDegradeLast10.slice(-10);
      }
      bump(counters, 'reject.swapError');
      canaryRecord('swap', 'swapError', { message: safeMsg(e) });
      fail('swapError', { stage: 'executeSwap', cooldownMs: 30_000 });
      pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `watchlistSwapError(${safeMsg(e)})` });
    }
  }
}
