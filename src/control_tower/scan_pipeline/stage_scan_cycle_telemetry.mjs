export function createScanCycleState({
  cfg,
  counters,
  state,
  scanWatchlistIngestStart,
  scanPairFetchStart,
  scanBirdeyeReqStart,
}) {
  const cycle = {
    scanCandidatesFound: 0,
    scanPairFetchCalls: 0,
    scanBirdeyeCalls: 0,
    scanRpcCalls: 0,
    scanPairFetchConcurrency: Math.max(1, Math.min(8, Number(cfg.PAIR_FETCH_CONCURRENCY || 1))),
    scanJupCooldownActive: false,
    scanJupCooldownRemainingMs: 0,
    scanRoutePrefilterDegraded: false,
    scanUsableSnapshotWithoutPairCount: 0,
    scanNoPairTempActiveCount: 0,
    scanNoPairTempRevisitCount: 0,
    scanMaxSingleCallDurationMs: 0,
    scanPhase: {
      candidateDiscoveryMs: 0,
      candidateSourcePollingMs: 0,
      candidateSourceMergingMs: 0,
      candidateSourceTransformsMs: 0,
      candidateStreamDrainMs: 0,
      candidateTokenlistFetchMs: 0,
      candidateTokenlistPoolBuildMs: 0,
      candidateTokenlistSamplingMs: 0,
      candidateTokenlistQuoteabilityChecksMs: 0,
      tokenlistCandidatesFilteredByLiquidity: 0,
      tokenlistQuoteChecksPerformed: 0,
      tokenlistQuoteChecksSkipped: 0,
      candidateDedupeMs: 0,
      candidateIterationMs: 0,
      candidateStateLookupMs: 0,
      candidateCacheReadsMs: 0,
      candidateCacheWritesMs: 0,
      candidateFilterLoopsMs: 0,
      candidateAsyncWaitUnclassifiedMs: 0,
      candidateCooldownFilteringMs: 0,
      candidateShortlistPrefilterMs: 0,
      candidateRouteabilityChecksMs: 0,
      candidateOtherMs: 0,
      routePrepMs: 0,
      pairFetchMs: 0,
      birdeyeMs: 0,
      rpcMs: 0,
      snapshotBuildMs: 0,
      snapshotBirdseyeFetchMs: 0,
      snapshotPairEnrichmentMs: 0,
      snapshotLiqMcapNormalizationMs: 0,
      snapshotValidationMs: 0,
      snapshotWatchlistRowConstructionMs: 0,
      snapshotOtherMs: 0,
      shortlistMs: 0,
      watchlistWriteMs: 0,
    },
    markCallDuration(startedAtMs, kind = null) {
      const d = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
      if (d > cycle.scanMaxSingleCallDurationMs) cycle.scanMaxSingleCallDurationMs = d;
      if (kind === 'rpc') cycle.scanPhase.rpcMs += d;
    },
    applyScanState(scanState) {
      if (!scanState) return;
      cycle.scanCandidatesFound = Number(scanState.scanCandidatesFound || 0);
      cycle.scanPairFetchConcurrency = Number(scanState.scanPairFetchConcurrency || cycle.scanPairFetchConcurrency || 1);
      cycle.scanJupCooldownActive = !!scanState.scanJupCooldownActive;
      cycle.scanJupCooldownRemainingMs = Number(scanState.scanJupCooldownRemainingMs || 0);
      cycle.scanRoutePrefilterDegraded = !!scanState.scanRoutePrefilterDegraded;
      cycle.scanUsableSnapshotWithoutPairCount = Number(scanState.scanUsableSnapshotWithoutPairCount || 0);
      cycle.scanNoPairTempActiveCount = Number(scanState.scanNoPairTempActiveCount || 0);
      cycle.scanNoPairTempRevisitCount = Number(scanState.scanNoPairTempRevisitCount || 0);
    },
    finalize({
      scanCycleStartedAtMs,
      scanIntervalMs,
      nextScanDelayMs,
      appendDiagEvent,
      appendJsonl,
    }) {
      const scanDurationMs = Math.max(0, Date.now() - scanCycleStartedAtMs);
      const watchlistIngestPerScan = Math.max(0, Number(counters?.watchlist?.ingested || 0) - scanWatchlistIngestStart);
      cycle.scanPairFetchCalls = Math.max(0, Number(counters?.pairFetch?.started || 0) - scanPairFetchStart);
      cycle.scanBirdeyeCalls = Math.max(0, Number(state?.marketData?.providers?.birdeye?.requests || 0) - scanBirdeyeReqStart);
      counters.scanDurationMsTotal = Number(counters.scanDurationMsTotal || 0) + scanDurationMs;
      counters.scanDurationSamples = Number(counters.scanDurationSamples || 0) + 1;
      counters.scanCandidatesFoundTotal = Number(counters.scanCandidatesFoundTotal || 0) + Number(cycle.scanCandidatesFound || 0);
      counters.scanWatchlistIngestTotal = Number(counters.scanWatchlistIngestTotal || 0) + watchlistIngestPerScan;

      counters.watchlist ||= {};
      counters.watchlist.compactWindow ||= {};
      const w = counters.watchlist.compactWindow;
      if (!Array.isArray(w.scanCycles)) w.scanCycles = [];
      const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
      const cutoff = Date.now() - retainMs;
      cycle.scanPhase.candidateOtherMs = Math.max(0,
        Number(cycle.scanPhase.candidateDiscoveryMs || 0)
        - Number(cycle.scanPhase.candidateSourcePollingMs || 0)
        - Number(cycle.scanPhase.candidateSourceMergingMs || 0)
        - Number(cycle.scanPhase.candidateSourceTransformsMs || 0)
        - Number(cycle.scanPhase.candidateStreamDrainMs || 0)
        - Number(cycle.scanPhase.candidateTokenlistFetchMs || 0)
        - Number(cycle.scanPhase.candidateTokenlistPoolBuildMs || 0)
        - Number(cycle.scanPhase.candidateTokenlistSamplingMs || 0)
        - Number(cycle.scanPhase.candidateTokenlistQuoteabilityChecksMs || 0)
        - Number(cycle.scanPhase.candidateDedupeMs || 0)
        - Number(cycle.scanPhase.candidateIterationMs || 0)
        - Number(cycle.scanPhase.candidateStateLookupMs || 0)
        - Number(cycle.scanPhase.candidateCacheReadsMs || 0)
        - Number(cycle.scanPhase.candidateCacheWritesMs || 0)
        - Number(cycle.scanPhase.candidateFilterLoopsMs || 0)
        - Number(cycle.scanPhase.candidateAsyncWaitUnclassifiedMs || 0)
        - Number(cycle.scanPhase.candidateCooldownFilteringMs || 0)
        - Number(cycle.scanPhase.candidateShortlistPrefilterMs || 0)
        - Number(cycle.scanPhase.candidateRouteabilityChecksMs || 0));
      cycle.scanPhase.snapshotOtherMs = Math.max(0,
        Number(cycle.scanPhase.snapshotBuildMs || 0)
        - Number(cycle.scanPhase.snapshotBirdseyeFetchMs || 0)
        - Number(cycle.scanPhase.snapshotPairEnrichmentMs || 0)
        - Number(cycle.scanPhase.snapshotLiqMcapNormalizationMs || 0)
        - Number(cycle.scanPhase.snapshotValidationMs || 0)
        - Number(cycle.scanPhase.snapshotWatchlistRowConstructionMs || 0));
      const totalWorkMs = Number(cycle.scanPhase.candidateDiscoveryMs || 0)
        + Number(cycle.scanPhase.routePrepMs || 0)
        + Number(cycle.scanPhase.pairFetchMs || 0)
        + Number(cycle.scanPhase.birdeyeMs || 0)
        + Number(cycle.scanPhase.rpcMs || 0)
        + Number(cycle.scanPhase.snapshotBuildMs || 0)
        + Number(cycle.scanPhase.shortlistMs || 0)
        + Number(cycle.scanPhase.watchlistWriteMs || 0);
      const scanCycleEvent = {
        tMs: Date.now(),
        intervalMs: Number.isFinite(Number(scanIntervalMs)) ? Number(scanIntervalMs) : null,
        durationMs: scanDurationMs,
        candidatesFound: Number(cycle.scanCandidatesFound || 0),
        watchlistIngest: watchlistIngestPerScan,
        pairFetchCalls: Number(cycle.scanPairFetchCalls || 0),
        pairFetchConcurrency: Number(cycle.scanPairFetchConcurrency || 1),
        birdeyeCalls: Number(cycle.scanBirdeyeCalls || 0),
        rpcCalls: Number(cycle.scanRpcCalls || 0),
        jupCooldownActive: !!cycle.scanJupCooldownActive,
        jupCooldownRemainingMs: Number(cycle.scanJupCooldownRemainingMs || 0),
        degradedRoutePrefilterMode: !!cycle.scanRoutePrefilterDegraded,
        usableSnapshotWithoutPairCount: Number(cycle.scanUsableSnapshotWithoutPairCount || 0),
        noPairTempActiveCount: Number(cycle.scanNoPairTempActiveCount || 0),
        noPairTempRevisitCount: Number(cycle.scanNoPairTempRevisitCount || 0),
        maxSingleCallDurationMs: Number(cycle.scanMaxSingleCallDurationMs || 0),
        candidateDiscoveryMs: Number(cycle.scanPhase.candidateDiscoveryMs || 0),
        candidateSourcePollingMs: Number(cycle.scanPhase.candidateSourcePollingMs || 0),
        candidateSourceMergingMs: Number(cycle.scanPhase.candidateSourceMergingMs || 0),
        candidateSourceTransformsMs: Number(cycle.scanPhase.candidateSourceTransformsMs || 0),
        candidateStreamDrainMs: Number(cycle.scanPhase.candidateStreamDrainMs || 0),
        candidateTokenlistFetchMs: Number(cycle.scanPhase.candidateTokenlistFetchMs || 0),
        candidateTokenlistPoolBuildMs: Number(cycle.scanPhase.candidateTokenlistPoolBuildMs || 0),
        candidateTokenlistSamplingMs: Number(cycle.scanPhase.candidateTokenlistSamplingMs || 0),
        candidateTokenlistQuoteabilityChecksMs: Number(cycle.scanPhase.candidateTokenlistQuoteabilityChecksMs || 0),
        tokenlistCandidatesFilteredByLiquidity: Number(cycle.scanPhase.tokenlistCandidatesFilteredByLiquidity || 0),
        tokenlistQuoteChecksPerformed: Number(cycle.scanPhase.tokenlistQuoteChecksPerformed || 0),
        tokenlistQuoteChecksSkipped: Number(cycle.scanPhase.tokenlistQuoteChecksSkipped || 0),
        candidateDedupeMs: Number(cycle.scanPhase.candidateDedupeMs || 0),
        candidateIterationMs: Number(cycle.scanPhase.candidateIterationMs || 0),
        candidateStateLookupMs: Number(cycle.scanPhase.candidateStateLookupMs || 0),
        candidateCacheReadsMs: Number(cycle.scanPhase.candidateCacheReadsMs || 0),
        candidateCacheWritesMs: Number(cycle.scanPhase.candidateCacheWritesMs || 0),
        candidateFilterLoopsMs: Number(cycle.scanPhase.candidateFilterLoopsMs || 0),
        candidateAsyncWaitUnclassifiedMs: Number(cycle.scanPhase.candidateAsyncWaitUnclassifiedMs || 0),
        candidateCooldownFilteringMs: Number(cycle.scanPhase.candidateCooldownFilteringMs || 0),
        candidateShortlistPrefilterMs: Number(cycle.scanPhase.candidateShortlistPrefilterMs || 0),
        candidateRouteabilityChecksMs: Number(cycle.scanPhase.candidateRouteabilityChecksMs || 0),
        candidateOtherMs: Number(cycle.scanPhase.candidateOtherMs || 0),
        routePrepMs: Number(cycle.scanPhase.routePrepMs || 0),
        pairFetchMs: Number(cycle.scanPhase.pairFetchMs || 0),
        birdeyeMs: Number(cycle.scanPhase.birdeyeMs || 0),
        rpcMs: Number(cycle.scanPhase.rpcMs || 0),
        snapshotBuildMs: Number(cycle.scanPhase.snapshotBuildMs || 0),
        snapshotBirdseyeFetchMs: Number(cycle.scanPhase.snapshotBirdseyeFetchMs || 0),
        snapshotPairEnrichmentMs: Number(cycle.scanPhase.snapshotPairEnrichmentMs || 0),
        snapshotLiqMcapNormalizationMs: Number(cycle.scanPhase.snapshotLiqMcapNormalizationMs || 0),
        snapshotValidationMs: Number(cycle.scanPhase.snapshotValidationMs || 0),
        snapshotWatchlistRowConstructionMs: Number(cycle.scanPhase.snapshotWatchlistRowConstructionMs || 0),
        snapshotOtherMs: Number(cycle.scanPhase.snapshotOtherMs || 0),
        shortlistMs: Number(cycle.scanPhase.shortlistMs || 0),
        watchlistWriteMs: Number(cycle.scanPhase.watchlistWriteMs || 0),
        adaptiveDelayMs: Number(nextScanDelayMs || 0),
        totalWorkMs: Number(totalWorkMs || 0),
        totalCycleMs: Number(scanDurationMs || 0),
        scanAggregateTaskMs: Number(totalWorkMs || 0),
        scanWallClockMs: Number(scanDurationMs || 0),
      };
      w.scanCycles.push(scanCycleEvent);
      while (w.scanCycles.length && Number(w.scanCycles[0]?.tMs || 0) < cutoff) w.scanCycles.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: Number(scanCycleEvent.tMs || Date.now()), kind: 'scanCycle', reason: null, extra: { ...scanCycleEvent } },
        });
      } catch {}
    },
  };

  return cycle;
}
