import { resolveConfirmTxMetricsFromDiagEvent } from './diag_event_invariants.mjs';
import { getCompactWindowForDiagRequest } from './diag_event_store.mjs';
import { buildExecutionDiagMessage } from './messages/execution_message.mjs';
import { buildScannerDiagMessage } from './messages/scanner_message.mjs';
import { buildConfirmDiagMessage } from './messages/confirm_message.mjs';
import { buildMomentumDiagMessage } from './messages/momentum_message.mjs';
import { buildCompactDiagMessage } from './messages/compact_message.mjs';
import { buildFullDiagMessage } from './messages/full_message.mjs';

/**
 * stage_get_diag_message_full_implementation.mjs
 * 
 * COMPLETE getDiagSnapshotMessage function extracted from commit 77252ba
 * This preserves the original implementation with all mode-specific branches:
 * - momentum
 * - confirm
 * - compact
 * - scanner
 * - execution
 * - full
 * 
 * All helper functions (formatDiagMintLabel, fmtRate, etc.) are preserved
 * exactly as they were in the original implementation.
 * 
 * This is NOT refactored - it is the exact original code.
 */

export function createGetDiagSnapshotMessageFull({ state, getCounters, cfg, fmtCt, runtime }) {
  return function getDiagSnapshotMessage(nowMs = Date.now(), mode = 'full', windowHours = null) {
    const counters = getCounters();
    const diagSnapshot = runtime.diagSnapshot;
    const updatedAtMs = Number(diagSnapshot.updatedAtMs || 0);
    const ageSec = updatedAtMs > 0 ? Math.max(0, Math.round((nowMs - updatedAtMs) / 1000)) : null;
    const updatedIso = fmtCt(updatedAtMs);
    if (mode !== 'full') {
      state.runtime ||= {};
      const snapshotRefMs = updatedAtMs > 0 ? updatedAtMs : nowMs;
      if (!Number.isFinite(Number(state.runtime.botStartTimeMs || 0))) state.runtime.botStartTimeMs = snapshotRefMs;
      const botStartTimeMs = Number(state.runtime.botStartTimeMs || snapshotRefMs);
      const useWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : null;
      const requestedWindowHours = useWindowHours;
      const requestedWindowStartMs = requestedWindowHours ? (snapshotRefMs - (requestedWindowHours * 3_600_000)) : botStartTimeMs;
      const effectiveWindowStartMs = requestedWindowStartMs;
      const windowLabel = requestedWindowHours ? `${requestedWindowHours}h` : 'sinceStart';
      const elapsedHours = Math.max(1 / 60, (snapshotRefMs - effectiveWindowStartMs) / 3_600_000);
      const botUptimeHours = Math.max(0, (snapshotRefMs - botStartTimeMs) / 3_600_000);
      const windowHeaderLabel = windowLabel;
      const scansPerHour = elapsedHours > 0 ? (Number(counters?.scanCycles || 0) / elapsedHours) : 0;
      const warmingUp = !!(useWindowHours && useWindowHours < 0.25);
      const wl = state.watchlist || {};
      const wlMints = wl?.mints && typeof wl.mints === 'object' ? wl.mints : {};
      const watchlistSize = Object.keys(wlMints).length;
      const hotDepth = Array.isArray(wl?.hotQueue) ? wl.hotQueue.length : 0;
      const wlFunnel = counters?.watchlist?.funnelCumulative || {};
      const providers = state.marketData?.providers || {};
      const providerRate = (p) => {
        const req = Number(p?.requests || 0);
        const hit = Number(p?.hits || 0);
        return req > 0 ? `${Math.round((hit / req) * 100)}%` : 'n/a';
      };
      const circuit = state?.circuit || {};
      const circuitFailures = circuit?.failures || {};
      const circuitTrippedUntilMs = Number(circuit?.trippedUntilMs || 0);
      const circuitOpen = !!(circuitTrippedUntilMs && snapshotRefMs < circuitTrippedUntilMs);
      const circuitOpenRemainingSec = circuitOpen ? Math.max(0, Math.round((circuitTrippedUntilMs - snapshotRefMs) / 1000)) : 0;
      const circuitOpenReason = String(circuit?.lastTripReason || 'none');
      const circuitOpenSinceMs = Number(circuit?.lastTripAtMs || 0);
      const inMemoryCompactWindow = counters?.watchlist?.compactWindow || {};
      const durableHistoryEnabled = (process.env.DIAG_USE_DURABLE_HISTORY ?? 'true') === 'true';
      const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
      let compactWindow = inMemoryCompactWindow;
      if (durableHistoryEnabled) {
        try {
          const durableCompactWindow = getCompactWindowForDiagRequest({
            statePath: cfg.STATE_PATH,
            mode,
            nowMs: snapshotRefMs,
            windowStartMs: effectiveWindowStartMs,
            retainMs,
          });
          const arrKeys = [
            'momentumRecent', 'momentumEval', 'momentumPassed', 'confirmReached', 'confirmPassed', 'attempt', 'fill',
            'scanCycles', 'candidateSeen', 'candidateRouteable', 'candidateLiquiditySeen', 'shortlistPreCandidate', 'shortlistSelected', 'watchlistSeen', 'watchlistEvaluated',
            'postMomentumFlow', 'momentumLiqValues', 'stalkableSeen', 'repeatSuppressed', 'momentumFailChecks', 'providerHealth', 'hotBypass', 'preHotFlow',
          ];
          const durableCount = arrKeys.reduce((a, k) => a + Number((durableCompactWindow?.[k] || []).length || 0), 0);
          const memoryCount = arrKeys.reduce((a, k) => a + Number((inMemoryCompactWindow?.[k] || []).length || 0), 0);
          compactWindow = (durableCount > 0 || memoryCount === 0) ? durableCompactWindow : inMemoryCompactWindow;

          // Keep window metrics accurate when some keys are only tracked in-memory in this process.
          // If durable selection is active but a key is missing/empty there, fall back to in-memory array.
          if (compactWindow === durableCompactWindow) {
            for (const k of arrKeys) {
              const durableArr = Array.isArray(durableCompactWindow?.[k]) ? durableCompactWindow[k] : [];
              const memoryArr = Array.isArray(inMemoryCompactWindow?.[k]) ? inMemoryCompactWindow[k] : [];
              if (durableArr.length === 0 && memoryArr.length > 0) {
                compactWindow[k] = memoryArr;
              }
            }
          }
        } catch {}
      }
      const inWindowTs = (arr) => (arr || []).filter((t) => Number(t || 0) >= effectiveWindowStartMs);
      const inWindowObj = (arr) => (arr || []).filter((x) => Number(x?.tMs || 0) >= effectiveWindowStartMs);
      const momentumEvalWin = inWindowTs(compactWindow.momentumEval || []);
      const momentumPassedWin = inWindowTs(compactWindow.momentumPassed || []);
      const confirmReachedWin = inWindowTs(compactWindow.confirmReached || []);
      const confirmPassedWin = inWindowTs(compactWindow.confirmPassed || []);
      const attemptWin = inWindowTs(compactWindow.attempt || []);
      const fillWin = inWindowTs(compactWindow.fill || []);
      const blockersWin = inWindowObj(compactWindow.blockers || []);
      const momentumFailChecksWin = inWindowObj(compactWindow.momentumFailChecks || []);
      const repeatSuppressedWin = inWindowObj(compactWindow.repeatSuppressed || []);
      const momentumLiqWin = inWindowObj(compactWindow.momentumLiqValues || []);
      const stalkableSeenWin = inWindowObj(compactWindow.stalkableSeen || []);
      const providerHealthWin = inWindowObj(compactWindow.providerHealth || []);
      const hotBypassWin = inWindowObj(compactWindow.hotBypass || []);
      const preHotFlowWin = inWindowObj(compactWindow.preHotFlow || []);
      const scanCyclesRaw = compactWindow.scanCycles || [];
      const scanCyclesWin = inWindowObj(scanCyclesRaw);
      const candidateSeenWin = inWindowObj(compactWindow.candidateSeen || []);
      const candidateRouteableWin = inWindowObj(compactWindow.candidateRouteable || []);
      const candidateLiquiditySeenWin = inWindowObj(compactWindow.candidateLiquiditySeen || []);
      const shortlistPreCandidateWin = inWindowObj(compactWindow.shortlistPreCandidate || []);
      const shortlistSelectedWin = inWindowObj(compactWindow.shortlistSelected || []);
      const postFlowWin = inWindowObj(compactWindow.postMomentumFlow || []);
      const momentumAgeWin = inWindowObj(compactWindow.momentumAgeSamples || []);
      const agePresentWin = momentumAgeWin.filter(x => Number.isFinite(x?.ageMin)).length;
      const ageMissingWin = Math.max(0, momentumAgeWin.length - agePresentWin);
      const ageSourceCountsWin = {};
      const branchCountsWin = {};
      const earlyCountWin = momentumAgeWin.filter(x => !!x?.early).length;
      for (const ev of momentumAgeWin) {
        const src = String(ev?.source || 'missing');
        ageSourceCountsWin[src] = Number(ageSourceCountsWin[src] || 0) + 1;
        const br = String(ev?.branch || 'mature_3_of_4');
        branchCountsWin[br] = Number(branchCountsWin[br] || 0) + 1;
      }
      const ageDebugLast10 = momentumAgeWin.slice(-10).map(x => `${String(x?.mint||'n/a').slice(0,6)} ageMin=${Number.isFinite(x?.ageMin) ? Number(x.ageMin).toFixed(1) : 'null'} early=${x?.early ? 'true' : 'false'} branch=${String(x?.branch||'mature_3_of_4')} src=${String(x?.source||'missing')} fail=[${String(x?.fail||'none')}]`);
      const evalsPerMinute = Number(inWindowTs(compactWindow.watchlistEvaluated || []).length) / Math.max(1, elapsedHours * 60);
      const scannerCycleCount = Number(scanCyclesWin.length || 0);
      const rawScanCycleCount = Number(scanCyclesRaw.length || 0);
      const scansPerHourWindow = elapsedHours > 0 ? (scannerCycleCount / elapsedHours) : 0;
      const earliestScanTs = scannerCycleCount > 0 ? Number(scanCyclesWin[0]?.tMs || 0) : null;
      const latestScanTs = scannerCycleCount > 0 ? Number(scanCyclesWin[scanCyclesWin.length - 1]?.tMs || 0) : null;
      const hasDownstreamActivity = Number(counters?.route?.routeAvailableSeen || 0) > 0
        || Number(counters?.watchlist?.preHotConsidered || 0) > 0
        || Number(counters?.watchlist?.hotEnqueued || 0) > 0
        || Number(counters?.watchlist?.funnelCumulative?.momentumPassed || 0) > 0;
      const scannerTelemetryStatus = scannerCycleCount > 0
        ? 'ok'
        : (rawScanCycleCount > 0 ? 'timestampMismatch' : (hasDownstreamActivity ? 'missingEvents' : 'sourceMismatch'));
      const scannerHealth = scannerTelemetryStatus === 'ok'
        ? (scannerCycleCount > 0 && Number(scansPerHourWindow || 0) >= 1 ? 'healthy' : 'lowCadence')
        : scannerTelemetryStatus;
      const avgScanIntervalMs = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.intervalMs || 0), 0) / scannerCycleCount)
        : null;
      const avgScanDurationMs = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.durationMs || 0), 0) / scannerCycleCount)
        : null;
      const candidatesFoundPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.candidatesFound || 0), 0) / scannerCycleCount)
        : null;
      const watchlistIngestPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.watchlistIngest || 0), 0) / scannerCycleCount)
        : null;
      const pairFetchCallsPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.pairFetchCalls || 0), 0) / scannerCycleCount)
        : null;
      const pairFetchConcurrencyPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.pairFetchConcurrency || 0), 0) / scannerCycleCount)
        : null;
      const birdeyeCallsPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.birdeyeCalls || 0), 0) / scannerCycleCount)
        : null;
      const rpcCallsPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.rpcCalls || 0), 0) / scannerCycleCount)
        : null;
      const maxSingleCallDurationMs = scannerCycleCount > 0
        ? Math.max(...scanCyclesWin.map((x) => Number(x?.maxSingleCallDurationMs || 0)))
        : null;
      const degradedRoutePrefilterScans = scanCyclesWin.filter((x) => !!x?.degradedRoutePrefilterMode).length;
      const jupCooldownActiveScans = scanCyclesWin.filter((x) => !!x?.jupCooldownActive).length;
      const usableSnapshotWithoutPairPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.usableSnapshotWithoutPairCount || 0), 0) / scannerCycleCount)
        : null;
      const noPairTempActivePerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.noPairTempActiveCount || 0), 0) / scannerCycleCount)
        : null;
      const phaseAvg = (k) => scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.[k] || 0), 0) / scannerCycleCount)
        : null;
      const scanPhaseAverages = {
        candidateDiscoveryMs: phaseAvg('candidateDiscoveryMs'),
        candidateSourcePollingMs: phaseAvg('candidateSourcePollingMs'),
        candidateSourceMergingMs: phaseAvg('candidateSourceMergingMs'),
        candidateSourceTransformsMs: phaseAvg('candidateSourceTransformsMs'),
        candidateStreamDrainMs: phaseAvg('candidateStreamDrainMs'),
        candidateTokenlistFetchMs: phaseAvg('candidateTokenlistFetchMs'),
        candidateTokenlistPoolBuildMs: phaseAvg('candidateTokenlistPoolBuildMs'),
        candidateTokenlistSamplingMs: phaseAvg('candidateTokenlistSamplingMs'),
        candidateTokenlistQuoteabilityChecksMs: phaseAvg('candidateTokenlistQuoteabilityChecksMs'),
        tokenlistCandidatesFilteredByLiquidity: phaseAvg('tokenlistCandidatesFilteredByLiquidity'),
        tokenlistQuoteChecksPerformed: phaseAvg('tokenlistQuoteChecksPerformed'),
        tokenlistQuoteChecksSkipped: phaseAvg('tokenlistQuoteChecksSkipped'),
        candidateDedupeMs: phaseAvg('candidateDedupeMs'),
        candidateIterationMs: phaseAvg('candidateIterationMs'),
        candidateStateLookupMs: phaseAvg('candidateStateLookupMs'),
        candidateCacheReadsMs: phaseAvg('candidateCacheReadsMs'),
        candidateCacheWritesMs: phaseAvg('candidateCacheWritesMs'),
        candidateFilterLoopsMs: phaseAvg('candidateFilterLoopsMs'),
        candidateAsyncWaitUnclassifiedMs: phaseAvg('candidateAsyncWaitUnclassifiedMs'),
        candidateCooldownFilteringMs: phaseAvg('candidateCooldownFilteringMs'),
        candidateShortlistPrefilterMs: phaseAvg('candidateShortlistPrefilterMs'),
        candidateRouteabilityChecksMs: phaseAvg('candidateRouteabilityChecksMs'),
        candidateOtherMs: phaseAvg('candidateOtherMs'),
        routePrepMs: phaseAvg('routePrepMs'),
        pairFetchMs: phaseAvg('pairFetchMs'),
        birdeyeMs: phaseAvg('birdeyeMs'),
        rpcMs: phaseAvg('rpcMs'),
        snapshotBuildMs: phaseAvg('snapshotBuildMs'),
        snapshotBirdseyeFetchMs: phaseAvg('snapshotBirdseyeFetchMs'),
        snapshotPairEnrichmentMs: phaseAvg('snapshotPairEnrichmentMs'),
        snapshotLiqMcapNormalizationMs: phaseAvg('snapshotLiqMcapNormalizationMs'),
        snapshotValidationMs: phaseAvg('snapshotValidationMs'),
        snapshotWatchlistRowConstructionMs: phaseAvg('snapshotWatchlistRowConstructionMs'),
        snapshotOtherMs: phaseAvg('snapshotOtherMs'),
        shortlistMs: phaseAvg('shortlistMs'),
        watchlistWriteMs: phaseAvg('watchlistWriteMs'),
        adaptiveDelayMs: phaseAvg('adaptiveDelayMs'),
        totalWorkMs: phaseAvg('totalWorkMs'),
        totalCycleMs: phaseAvg('totalCycleMs'),
        scanAggregateTaskMs: phaseAvg('scanAggregateTaskMs'),
        scanWallClockMs: phaseAvg('scanWallClockMs'),
      };
      const top3ScanPhases = Object.entries(scanPhaseAverages)
        .filter(([k,v]) => k.endsWith('Ms') && !k.startsWith('total') && Number.isFinite(Number(v)))
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
        .slice(0,3)
        .map(([k,v]) => `${k}:${Math.round(Number(v||0))}`)
        .join(', ') || 'none';
      const uniqueCandidatesSeen = new Set(candidateSeenWin.map((x) => String(x?.mint || 'unknown'))).size;
      const uniqueCandidatesRouteable = new Set(candidateRouteableWin.map((x) => String(x?.mint || 'unknown'))).size;
      const uniqueAboveHotFloor = new Set(candidateLiquiditySeenWin.filter((x) => Number(x?.liqUsd || 0) >= Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40000)).map((x) => String(x?.mint || 'unknown'))).size;
      const uniqueAboveConfirmFloor = new Set(candidateLiquiditySeenWin.filter((x) => Number(x?.liqUsd || 0) >= Number(cfg.LIVE_CONFIRM_MIN_LIQ_USD || 0)).map((x) => String(x?.mint || 'unknown'))).size;
      const uniqueAboveAttemptFloor = new Set(candidateLiquiditySeenWin.filter((x) => Number(x?.liqUsd || 0) >= Number(cfg.LIVE_ATTEMPT_MIN_LIQ_USD || 0)).map((x) => String(x?.mint || 'unknown'))).size;
      const sourceEnabled = {
        boosted: true,
        tokenlist: !!cfg.JUP_TOKENLIST_ENABLED,
        stream: !!(cfg.LASERSTREAM_ENABLED || String(cfg.STREAMING_PROVIDER_MODE || 'existing') !== 'existing'),
        trending: !!cfg.TRENDING_ENABLED,
      };
      const normalizeSrc = (s) => {
        const v = String(s || 'other').toLowerCase();
        if (v === 'dex' || v === 'boosted' || v === 'birdseye_boosted') return 'boosted';
        if (v === 'jup' || v === 'tokenlist') return 'tokenlist';
        if (v === 'stream') return 'stream';
        if (v === 'trending' || v === 'market_trending') return 'trending';
        return 'other';
      };
      const sourceMix = { boosted: 0, tokenlist: 0, stream: 0, trending: 0, other: 0 };
      const candidatesSeenBySource = { boosted: 0, tokenlist: 0, stream: 0, trending: 0, other: 0 };
      const routeableBySource = { boosted: 0, tokenlist: 0, stream: 0, trending: 0, other: 0 };
      const aboveHotFloorBySource = { boosted: 0, tokenlist: 0, stream: 0, trending: 0, other: 0 };
      for (const ev of candidateSeenWin) {
        const key = normalizeSrc(ev?.source);
        sourceMix[key] += 1;
        candidatesSeenBySource[key] += 1;
      }
      for (const ev of candidateRouteableWin) {
        const key = normalizeSrc(ev?.source);
        routeableBySource[key] += 1;
      }
      for (const ev of candidateLiquiditySeenWin) {
        const key = normalizeSrc(ev?.source);
        if (Number(ev?.liqUsd || 0) >= Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40000)) aboveHotFloorBySource[key] += 1;
      }
      const nowLocal = new Date();
      const winStartLocal = new Date(effectiveWindowStartMs);
      const tzLabel = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
      const hh = (d) => String(d.getHours()).padStart(2, '0');
      const timeOfWindowLabel = `${hh(winStartLocal)}:00-${hh(nowLocal)}:00 ${tzLabel}`;
      const tokenlistSeen = Number(candidatesSeenBySource.tokenlist || 0);
      const tokenlistRouteable = Number(routeableBySource.tokenlist || 0);
      const tokenlistAboveHot = Number(aboveHotFloorBySource.tokenlist || 0);
      const tokenlistDropoffStage = !sourceEnabled.tokenlist
        ? 'disabled'
        : (tokenlistSeen <= 0
          ? 'not_seen'
          : (tokenlistRouteable <= 0
            ? 'not_routeable'
            : (tokenlistAboveHot <= 0
              ? 'below_hot_floor'
              : 'post_hot_floor_(snapshot/preHot/later)')));
      const lastMomentumEvalTs = Math.max(...momentumEvalWin.slice(-1), ...momentumPassedWin.slice(-1), 0);
      const lastMomentumEvalAgeSec = lastMomentumEvalTs > 0 ? Math.max(0, Math.round((nowMs - lastMomentumEvalTs) / 1000)) : 'n/a';
      const blockerCounts1h = {};
      for (const ev of blockersWin) {
        const k = String(ev?.reason || 'unknown');
        blockerCounts1h[k] = Number(blockerCounts1h[k] || 0) + 1;
      }
      const blockerRename = (k) => {
        if (k === 'snapshot.unsafeSnapshot.liquidityBelowThreshold') return 'liquidityBelowThreshold';
        if (k === 'snapshot.unsafeSnapshot.birdeyeStale') return 'birdeyeStale';
        if (k === 'momentum.momentumFailed') return 'momentumFailed';
        if (k === 'hot.ageMissingForHot') return 'ageMissingForHot';
        if (k === 'hot.mcapMissing') return 'mcapMissing';
        return k;
      };
      let blockers = Object.entries(blockerCounts1h)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
        .slice(0,6)
        .map(([k,v])=>`- ${blockerRename(k)} = ${v}`);
      if (!blockers.length) {
        const fallbackKeys = [
          'snapshot.unsafeSnapshot.liquidityBelowThreshold',
          'snapshot.unsafeSnapshot.birdeyeStale',
          'momentum.momentumFailed',
          'hot.ageMissingForHot',
          'hot.mcapMissing',
        ];
        blockers = fallbackKeys.map((k) => `- ${blockerRename(k)} = ${Number(counters?.watchlist?.blockedByReason?.[k] || 0)}`);
      }
      const failCheckCountsWin = {};
      const failMintCountsWin = {};
      for (const ev of momentumFailChecksWin) {
        const mint = String(ev?.mint || 'unknown');
        failMintCountsWin[mint] = Number(failMintCountsWin[mint] || 0) + 1;
        for (const c of (ev?.checks || [])) failCheckCountsWin[String(c)] = Number(failCheckCountsWin[String(c)] || 0) + 1;
      }
      const failedTop = Object.entries(failCheckCountsWin)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
      const repeatMintCountsWin = {};
      const repeatReasonCountsWin = {};
      for (const ev of repeatSuppressedWin) {
        const m = String(ev?.mint || 'unknown');
        const r = String(ev?.reason || 'unknown');
        repeatMintCountsWin[m] = Number(repeatMintCountsWin[m] || 0) + 1;
        repeatReasonCountsWin[r] = Number(repeatReasonCountsWin[r] || 0) + 1;
      }
      const repeatMintsTop = Object.entries(repeatMintCountsWin)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${formatDiagMintLabel(k)}:${v}`).join(', ') || 'none';
      const repeatReasonTop = Object.entries(repeatReasonCountsWin)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
      const samples = inWindowObj(compactWindow.momentumInputSamples || [])
        .slice(-3)
        .map(x => {
          const m = formatDiagMintLabel(String(x?.mint || 'n/a'));
          const liq = Number(x?.liq || 0);
          const v5 = Number(x?.v5 || 0);
          const bsr = Number(x?.bsr || 0);
          const tx1m = Number(x?.tx1m || 0);
          const tx5mAvg = Number(x?.tx5mAvg || 0);
          const tx30mAvg = Number(x?.tx30mAvg || 0);
          const fail = String(x?.fail || 'none');
          return `- ${m} liq=${Math.round(liq)} v5=${Math.round(v5)} bsr=${bsr.toFixed(2)} tx1m=${tx1m.toFixed(2)} tx5mAvg=${tx5mAvg.toFixed(2)} tx30mAvg=${tx30mAvg.toFixed(2)} fail=[${fail}]`;
        });
      const band = counters?.watchlist?.momentumLiqBand || {};
      const recentMomo = inWindowObj(compactWindow.momentumRecent || [])
        .slice(-10)
        .map(x => `- ${formatDiagMintLabel(String(x?.mint||'n/a'))} liq=${Math.round(Number(x?.liq||0))} mcap=${Math.round(Number(x?.mcap||0))} agePresent=${x?.agePresent ? 'true' : 'false'} ageMin=${Number.isFinite(x?.ageMin) ? Number(x.ageMin).toFixed(1) : 'null'} early=${x?.early ? 'true' : 'false'} branch=${String(x?.branch||'mature_3_of_4')} ${x?.final||'passed'}`);
      const recentMomentumInput5 = (counters?.watchlist?.momentumInputDebugLast || []).slice(-5);
      const cumulativeMomentumEvaluated = Number(momentumEvalWin.length) + Number(momentumPassedWin.length);
      const cumulativeMomentumPassed = Number(momentumPassedWin.length);
      const cumulativeConfirmReached = Number(confirmReachedWin.length);
      const cumulativeConfirmPassed = Number(confirmPassedWin.length);
      const cumulativeAttempt = Number(attemptWin.length);
      const cumulativeFill = Number(fillWin.length);
      const hourCutoffMs = nowMs - (60 * 60_000);
      const hourMomentumEval = Number(momentumEvalWin.filter(t=>t>=hourCutoffMs).length) + Number(momentumPassedWin.filter(t=>t>=hourCutoffMs).length);
      const hourMomentumPassed = Number(momentumPassedWin.filter(t=>t>=hourCutoffMs).length);
      const hourConfirmReached = Number(confirmReachedWin.filter(t=>t>=hourCutoffMs).length);
      const hourConfirmPassed = Number(confirmPassedWin.filter(t=>t>=hourCutoffMs).length);
      const hourAttempt = Number(attemptWin.filter(t=>t>=hourCutoffMs).length);
      const hourFill = Number(fillWin.filter(t=>t>=hourCutoffMs).length);

      function formatDiagMintLabel(mint) {
        const m = String(mint || 'unknown');
        const frag = `${m.slice(0,6)}...`;

        const watchRow = state?.watchlist?.mints?.[m] || null;
        const pos = state?.positions?.[m] || null;

        const name = cleanTokenText(
          pos?.tokenName
          || watchRow?.pair?.baseToken?.name
          || watchRow?.latest?.tokenName
          || watchRow?.snapshot?.tokenName
        );
        const symbol = cleanTokenText(
          pos?.symbol
          || watchRow?.pair?.baseToken?.symbol
          || watchRow?.latest?.tokenSymbol
          || watchRow?.snapshot?.tokenSymbol
        );

        if (name && symbol) return `${name} (${symbol}) ${frag}`;
        if (!name && symbol) return `${symbol} (${frag})`;
        if (name && !symbol) return `${name} (${frag})`;
        return frag;
      }

      function cleanTokenText(v) {
        if (v == null) return '';
        return String(v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
      }

      if (mode === 'execution') {
        const medianLocal = (arr) => { const a = arr.filter((v) => Number.isFinite(Number(v))).map(Number); if (!a.length) return null; const srt=a.slice().sort((x,y)=>x-y); const m=Math.floor(srt.length/2); return srt.length%2?srt[m]:(srt[m-1]+srt[m])/2; };
        const fmtMed = (v, d=0) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : 'n/a';

        const lastAttemptTs = Math.max(...attemptWin.slice(-1), ...fillWin.slice(-1), ...confirmPassedWin.slice(-1), 0);
        const lastAttemptAgeSec = lastAttemptTs > 0 ? Math.max(0, Math.round((nowMs - lastAttemptTs) / 1000)) : 'n/a';

        const hourAttemptReached = Number(attemptWin.filter(t=>t>=hourCutoffMs).length);
        const hourFill = Number(fillWin.filter(t=>t>=hourCutoffMs).length);
        const hourAttemptPassed = hourFill;
        const hourSwapFailed = Number(postFlowWin.filter((e)=>Number(e?.tMs||0)>=hourCutoffMs && String(e?.stage||'')==='swap' && String(e?.outcome||'')==='rejected').length);

        const cumConfirmPassed = Number(confirmPassedWin.length);
        const cumAttemptReached = Number(attemptWin.length);
        const cumFill = Number(fillWin.length);
        const cumAttemptPassed = cumFill;
        const cumSwapFailed = Number(postFlowWin.filter((e)=>String(e?.stage||'')==='swap' && String(e?.outcome||'')==='rejected').length);

        const attemptPassRate = cumAttemptReached > 0 ? (cumAttemptPassed / cumAttemptReached) : 0;
        const fillFromAttemptRate = cumAttemptReached > 0 ? (cumFill / cumAttemptReached) : 0;
        const fillFromConfirmRate = cumConfirmPassed > 0 ? (cumFill / cumConfirmPassed) : 0;

        const normExecReason = (r) => {
          const x = String(r || 'unknown');
          if (x.includes('entryMcapTooLow')) return 'entryMcapTooLow';
          if (x.includes('noRoute') || x.includes('routeMissing') || x.includes('noRouteConfirmed') || x.includes('route')) return 'noRoute/routeMissing';
          if (x.includes('priceImpactTooHigh') || x.includes('impact')) return 'priceImpactTooHigh';
          if (x.includes('slippageTooHigh') || x.includes('slippage')) return 'slippageTooHigh';
          if (x.includes('mintSuppressed') || x.includes('attemptMintSuppressed')) return 'mintSuppressed';
          if (x.includes('targetUsdTooSmall')) return 'targetUsdTooSmall';
          if (x.includes('reserveBlocked')) return 'reserveBlocked';
          if (x.includes('missingDecimals')) return 'missingDecimals';
          if (x.includes('preflight') || x.includes('swapError') || x.startsWith('attempt.swap') || x.startsWith('swap.')) return 'preflight/swapApiError';
          return x;
        };

        const executionRejectCounts = {};
        for (const ev of postFlowWin) {
          if (String(ev?.outcome || '') !== 'rejected') continue;
          const stage = String(ev?.stage || '');
          if (!['attempt','swap','execution','forcePolicy'].includes(stage)) continue;
          const k = normExecReason(String(ev?.reason || 'unknown'));
          executionRejectCounts[k] = Number(executionRejectCounts[k] || 0) + 1;
        }
        const topExecutionBlockers = Object.entries(executionRejectCounts)
          .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
          .slice(0,5)
          .map(([k,v])=>`- ${k}:${v}`);

        const attemptReachedRows = postFlowWin.filter((e) => String(e?.stage || '') === 'attempt' && String(e?.outcome || '') === 'reached');
        const fillRows = postFlowWin.filter((e) => String(e?.stage || '') === 'fill' && String(e?.outcome || '') === 'passed');
        const executionPathRows = (counters?.watchlist?.executionPathLast10 || []);

        const quoteToSendMs = executionPathRows.map((x)=>Number(x?.quoteAgeMs ?? NaN)).filter((v)=>Number.isFinite(v) && v>0);
        const sendToFillMs = fillRows.map((x)=>Number(x?.fillLatencyMs ?? x?.sendToFillMs ?? NaN)).filter((v)=>Number.isFinite(v) && v>0);
        const totalAttemptToFillMs = fillRows.map((x)=>Number(x?.attemptToFillMs ?? x?.totalAttemptToFillMs ?? NaN)).filter((v)=>Number.isFinite(v) && v>0);
        const realizedSlippageBps = fillRows.map((x)=>Number(x?.realizedSlippageBps ?? NaN)).filter((v)=>Number.isFinite(v));
        const quotedPriceImpactPct = fillRows.map((x)=>Number(x?.priceImpactPct ?? NaN)).filter((v)=>Number.isFinite(v));

        const entryLiq = attemptReachedRows.map((x)=>Number(x?.liq ?? NaN)).filter((v)=>Number.isFinite(v) && v>0);
        const entryMcap = attemptReachedRows.map((x)=>Number(x?.mcap ?? NaN)).filter((v)=>Number.isFinite(v) && v>0);
        const entryPi = attemptReachedRows.map((x)=>Number(x?.priceImpactPct ?? NaN)).filter((v)=>Number.isFinite(v));
        const entrySlip = attemptReachedRows.map((x)=>Number(x?.slippageBps ?? NaN)).filter((v)=>Number.isFinite(v));
        const routeMix = {};
        for (const x of executionPathRows) {
          const src = String(x?.routeSource || 'unknown');
          routeMix[src] = Number(routeMix[src] || 0) + 1;
        }
        const routeMixStr = Object.entries(routeMix).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,4).map(([k,v])=>`${k}:${v}`).join(', ') || 'n/a';

        const handoffBlockers = {};
        for (const ev of postFlowWin) {
          const r = String(ev?.reason || '');
          if (String(ev?.outcome || '') === 'rejected' && (r.startsWith('attempt.') || r.startsWith('swap.') || r.includes('reserveBlocked') || r.includes('targetUsdTooSmall') || r.includes('missingDecimals'))) {
            handoffBlockers[r] = Number(handoffBlockers[r] || 0) + 1;
          }
        }
        const topHandoffBlocker = Object.entries(handoffBlockers).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0]?.[0] || 'none';

        const byMint = {};
        for (const ev of postFlowWin) {
          const m = String(ev?.mint || '');
          if (!m) continue;
          byMint[m] ||= [];
          byMint[m].push(ev);
        }
        const failedAttemptsCompact = Object.entries(byMint).map(([mint, flow]) => {
          const attempt = flow.find((e)=>String(e?.stage||'')==='attempt' && String(e?.outcome||'')==='reached');
          if (!attempt) return null;
          const filled = flow.find((e)=>String(e?.stage||'')==='fill' && String(e?.outcome||'')==='passed');
          if (filled) return null;
          const rej = flow.slice().reverse().find((e)=>String(e?.outcome||'')==='rejected');
          const pi = Number(attempt?.priceImpactPct ?? NaN);
          const sl = Number(attempt?.slippageBps ?? NaN);
          return {
            mint,
            liq: Number(attempt?.liq || 0),
            mcap: Number(attempt?.mcap || 0),
            reason: String(rej?.reason || 'no_fill'),
            pi, sl,
            score: Number(attempt?.mcap || 0) + Number(attempt?.liq || 0),
          };
        }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,3)
          .map((r)=>`- ${formatDiagMintLabel(r.mint)} liq=${Math.round(r.liq)} mcap=${Math.round(r.mcap)} reason=${r.reason}${Number.isFinite(r.pi)?` impact=${r.pi.toFixed(4)}`:''}${Number.isFinite(r.sl)?` slippage=${Math.round(r.sl)}`:''}`);

        const filledAttemptsCompact = fillRows
          .map((e)=>({ mint:String(e?.mint||'unknown'), liq:Number(e?.liq||0), mcap:Number(e?.mcap||0), reason:'fill.passed', pi:Number(e?.priceImpactPct??NaN), sl:Number(e?.slippageBps??NaN), score:Number(e?.mcap||0)+Number(e?.liq||0) }))
          .sort((a,b)=>b.score-a.score)
          .slice(0,3)
          .map((r)=>`- ${formatDiagMintLabel(r.mint)} liq=${Math.round(r.liq)} mcap=${Math.round(r.mcap)} reason=${r.reason}${Number.isFinite(r.pi)?` impact=${r.pi.toFixed(4)}`:''}${Number.isFinite(r.sl)?` slippage=${Math.round(r.sl)}`:''}`);

        const swapErrSummary = Object.entries(executionRejectCounts).filter(([k,v]) => k === 'preflight/swapApiError' && Number(v||0) > 0).map(([k,v])=>`- ${k}:${v}`);
        const missingDecimalsN = Number(executionRejectCounts['missingDecimals'] || 0);
        const reserveBlockedN = Number(executionRejectCounts['reserveBlocked'] || 0);
        const targetUsdTooSmallN = Number(executionRejectCounts['targetUsdTooSmall'] || 0);

        return buildExecutionDiagMessage({
          windowHeaderLabel,
          fmtCt,
          effectiveWindowStartMs,
          updatedIso,
          elapsedHours,
          warmingUp,
          lastAttemptAgeSec,
          circuitOpen,
          circuitOpenReason,
          circuitOpenSinceMs,
          circuitOpenRemainingSec,
          hourAttemptReached,
          hourAttemptPassed,
          hourFill,
          hourSwapFailed,
          cumAttemptReached,
          cumAttemptPassed,
          cumFill,
          cumSwapFailed,
          attemptPassRate,
          fillFromAttemptRate,
          fillFromConfirmRate,
          cumConfirmPassed,
          topExecutionBlockers,
          medianLocal,
          quoteToSendMs,
          sendToFillMs,
          totalAttemptToFillMs,
          realizedSlippageBps,
          quotedPriceImpactPct,
          fmtMed,
          entryLiq,
          entryMcap,
          entryPi,
          entrySlip,
          routeMixStr,
          topHandoffBlocker,
          failedAttemptsCompact,
          filledAttemptsCompact,
          swapErrSummary,
          missingDecimalsN,
          reserveBlockedN,
          targetUsdTooSmallN,
        });
      }

      if (mode === 'scanner') {
        return buildScannerDiagMessage({
          windowHeaderLabel,
          fmtCt,
          effectiveWindowStartMs,
          updatedIso,
          elapsedHours,
          scannerHealth,
          scannerCycleCount,
          warmingUp,
          scansPerHourWindow,
          avgScanIntervalMs,
          avgScanDurationMs,
          scanPhaseAverages,
          top3ScanPhases,
          pairFetchCallsPerScan,
          pairFetchConcurrencyPerScan,
          birdeyeCallsPerScan,
          rpcCallsPerScan,
          maxSingleCallDurationMs,
          degradedRoutePrefilterScans,
          jupCooldownActiveScans,
          usableSnapshotWithoutPairPerScan,
          noPairTempActivePerScan,
          cfg,
          sourceEnabled,
          sourceMix,
          candidatesSeenBySource,
          routeableBySource,
          aboveHotFloorBySource,
          tokenlistDropoffStage,
          tokenlistSeen,
          tokenlistRouteable,
          tokenlistAboveHot,
          uniqueCandidatesSeen,
          uniqueCandidatesRouteable,
          uniqueAboveHotFloor,
          uniqueAboveConfirmFloor,
          uniqueAboveAttemptFloor,
          requestedWindowStartMs,
          botUptimeHours,
        });
      }

      if (mode === 'confirm') {
        const lastConfirmTs = Math.max(...confirmReachedWin.slice(-1), ...confirmPassedWin.slice(-1), ...attemptWin.slice(-1), ...fillWin.slice(-1), 0);
        const lastConfirmEvalAgeSec = lastConfirmTs > 0 ? Math.max(0, Math.round((nowMs - lastConfirmTs) / 1000)) : 'n/a';
        const hourConfirmReached2 = Number(confirmReachedWin.filter(t=>t>=hourCutoffMs).length);
        const hourConfirmPassed2 = Number(confirmPassedWin.filter(t=>t>=hourCutoffMs).length);
        const hourAttemptReached2 = Number(attemptWin.filter(t=>t>=hourCutoffMs).length);
        const hourFill2 = Number(fillWin.filter(t=>t>=hourCutoffMs).length);
        const hourAttemptPassed2 = hourFill2;
        const cumAttemptReached = Number(attemptWin.length);
        const cumFill = Number(fillWin.length);
        const cumAttemptPassed = cumFill;
        const preConfirmRejectedHour = Number(postFlowWin.filter(e => e.stage === 'preConfirm' && e.outcome === 'rejected' && Number(e?.tMs||0) >= hourCutoffMs).length);
        const preConfirmRejectedCum = Number(postFlowWin.filter(e => e.stage === 'preConfirm' && e.outcome === 'rejected').length);

        const postBlockerCounts = {};
        const confirmRejectCounts = {};
        const attemptRejectCounts = {};
        for (const ev of postFlowWin) {
          if (String(ev?.outcome || '') !== 'rejected') continue;
          const r = String(ev?.reason || 'unknown');
          postBlockerCounts[r] = Number(postBlockerCounts[r] || 0) + 1;
          if (r.startsWith('confirm.')) confirmRejectCounts[r] = Number(confirmRejectCounts[r] || 0) + 1;
          if (r.startsWith('attempt.') || r.startsWith('swap.')) attemptRejectCounts[r] = Number(attemptRejectCounts[r] || 0) + 1;
        }
        const postBlockersTop = Object.entries(postBlockerCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`- ${k} = ${v}`);
        const topConfirmRejectReasons = Object.entries(confirmRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,4).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const topAttemptRejectReasons = Object.entries(attemptRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,4).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';

        const freshnessBuckets = { b5_10: 0, b10_15: 0, b15_20: 0, gte20: 0 };
        for (const ev of postFlowWin) {
          if (String(ev?.stage || '') !== 'confirm' || String(ev?.outcome || '') !== 'reached') continue;
          const f = Number(ev?.freshnessMs || NaN);
          if (!Number.isFinite(f)) continue;
          if (f < 10_000) freshnessBuckets.b5_10 += 1;
          else if (f < 15_000) freshnessBuckets.b10_15 += 1;
          else if (f < 20_000) freshnessBuckets.b15_20 += 1;
          else freshnessBuckets.gte20 += 1;
        }
        const _confirmFreshnessLast10Removed = true;

        const preConfirmRejectedRows = postFlowWin.filter((ev) => String(ev?.stage || '') === 'preConfirm' && String(ev?.outcome || '') === 'rejected');
        const preConfirmRejectTop = Object.entries(preConfirmRejectedRows.reduce((acc, ev) => {
          const k = String(ev?.reason || 'unknown');
          acc[k] = Number(acc[k] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).slice(0, 4)
          .map(([k, v]) => `${k}:${v}`).join(', ') || 'none';

        const confirmReachedRows = postFlowWin.filter((ev) => String(ev?.stage || '') === 'confirm' && String(ev?.outcome || '') === 'reached');
        const confirmCandidateTxRows = confirmReachedRows.map((ev) => {
          const mint = String(ev?.mint || 'unknown');
          const tStart = Number(ev?.tMs || 0);
          const nextReachedTs = confirmReachedRows
            .filter((x) => String(x?.mint || '') === mint && Number(x?.tMs || 0) > tStart)
            .map((x) => Number(x?.tMs || 0))
            .sort((a, b) => a - b)[0] || Number.POSITIVE_INFINITY;
          const flow = postFlowWin.filter((x) => {
            if (String(x?.stage || '') !== 'confirm') return false;
            if (String(x?.mint || '') !== mint) return false;
            const tx = Number(x?.tMs || 0);
            return tx >= tStart && tx < nextReachedTs;
          });
          const withTx = flow.find((x) => Number.isFinite(Number(x?.txAccelObserved)) || Number.isFinite(Number(x?.tx1m)) || Number.isFinite(Number(x?.tx5mAvg)) || Number.isFinite(Number(x?.tx30mAvg))) || ev;
          const withContinuation = flow.find((x) => {
            const runupRaw = x?.continuationMaxRunupPct;
            const dipRaw = x?.continuationMaxDipPct;
            const hasRunup = runupRaw != null && Number.isFinite(Number(runupRaw));
            const hasDip = dipRaw != null && Number.isFinite(Number(dipRaw));
            const hasPassReason = String(x?.continuationPassReason || 'none') !== 'none';
            return hasRunup || hasDip || hasPassReason;
          }) || flow.find((x) => String(x?.outcome || '') === 'passed' || String(x?.outcome || '') === 'rejected') || ev;
          const confirmTxResolved = resolveConfirmTxMetricsFromDiagEvent(withTx || null);
          const tx1mResolved = Number(confirmTxResolved?.tx1m ?? NaN);
          const tx5mAvgResolved = Number(confirmTxResolved?.tx5mAvg ?? NaN);
          const tx30mAvgResolved = Number(confirmTxResolved?.tx30mAvg ?? NaN);
          const txAccelObservedResolved = Number(confirmTxResolved?.txAccelObserved ?? NaN);
          const final = flow.find((x) => String(x?.outcome || '') === 'passed')
            ? 'passed'
            : (flow.find((x) => String(x?.outcome || '') === 'rejected') ? 'rejected' : 'reached');
          return {
            mint,
            liq: Number(withTx?.liq ?? ev?.liq ?? 0),
            mcap: Number(withTx?.mcap ?? ev?.mcap ?? 0),
            ageMin: Number.isFinite(Number(withTx?.ageMin ?? ev?.ageMin)) ? Number(withTx?.ageMin ?? ev?.ageMin) : null,
            rejectReason: String(flow.find((x) => String(x?.outcome || '') === 'rejected')?.reason || ''),
            txAccelObserved: txAccelObservedResolved,
            txAccelThreshold: Number(withTx?.txAccelThreshold ?? 1),
            txAccelMissDistance: Number(withTx?.txAccelMissDistance ?? NaN),
            tx1m: tx1mResolved,
            tx5mAvg: tx5mAvgResolved,
            tx30mAvg: tx30mAvgResolved,
            freshnessMs: Number(withTx?.freshnessMs ?? ev?.freshnessMs ?? NaN),
            txMetricSource: String(confirmTxResolved?.txMetricSource || 'unknown'),
            carryPresent: !!withTx?.carryPresent,
            carryTx1m: Number(withTx?.carryTx1m ?? NaN),
            carryTx5mAvg: Number(withTx?.carryTx5mAvg ?? NaN),
            carryBuySellRatio: Number(withTx?.carryBuySellRatio ?? NaN),
            continuationMode: !!(withContinuation?.continuationMode ?? withTx?.continuationMode ?? ev?.continuationMode),
            continuationPassReason: String(withContinuation?.continuationPassReason ?? withTx?.continuationPassReason ?? ev?.continuationPassReason ?? 'none'),
            continuationStartPrice: Number(withContinuation?.continuationStartPrice ?? withTx?.continuationStartPrice ?? ev?.continuationStartPrice ?? NaN),
            continuationHighPrice: Number(withContinuation?.continuationHighPrice ?? withTx?.continuationHighPrice ?? ev?.continuationHighPrice ?? NaN),
            continuationLowPrice: Number(withContinuation?.continuationLowPrice ?? withTx?.continuationLowPrice ?? ev?.continuationLowPrice ?? NaN),
            continuationFinalPrice: Number(withContinuation?.continuationFinalPrice ?? withTx?.continuationFinalPrice ?? ev?.continuationFinalPrice ?? NaN),
            continuationMaxRunupPct: Number(withContinuation?.continuationMaxRunupPct ?? withTx?.continuationMaxRunupPct ?? ev?.continuationMaxRunupPct ?? NaN),
            continuationMaxDipPct: Number(withContinuation?.continuationMaxDipPct ?? withTx?.continuationMaxDipPct ?? ev?.continuationMaxDipPct ?? NaN),
            continuationTimeToRunupPassMs: Number(withContinuation?.continuationTimeToRunupPassMs ?? withTx?.continuationTimeToRunupPassMs ?? ev?.continuationTimeToRunupPassMs ?? NaN),
            continuationTimeoutWasFlatOrNegative: !!(withContinuation?.continuationTimeoutWasFlatOrNegative ?? withTx?.continuationTimeoutWasFlatOrNegative ?? ev?.continuationTimeoutWasFlatOrNegative),
            continuationConfirmStartLiqUsd: Number(withContinuation?.continuationConfirmStartLiqUsd ?? withTx?.continuationConfirmStartLiqUsd ?? ev?.continuationConfirmStartLiqUsd ?? NaN),
            continuationCurrentLiqUsd: Number(withContinuation?.continuationCurrentLiqUsd ?? withTx?.continuationCurrentLiqUsd ?? ev?.continuationCurrentLiqUsd ?? NaN),
            continuationLiqChangePct: Number(withContinuation?.continuationLiqChangePct ?? withTx?.continuationLiqChangePct ?? ev?.continuationLiqChangePct ?? NaN),
            continuationPriceSource: String(withContinuation?.continuationPriceSource ?? withTx?.continuationPriceSource ?? ev?.continuationPriceSource ?? 'unknown'),
            continuationInitialSourceUsed: String(withContinuation?.continuationInitialSourceUsed ?? withTx?.continuationInitialSourceUsed ?? ev?.continuationInitialSourceUsed ?? 'unknown'),
            continuationDominantSourceUsed: String(withContinuation?.continuationDominantSourceUsed ?? withTx?.continuationDominantSourceUsed ?? ev?.continuationDominantSourceUsed ?? 'unknown'),
            continuationConfirmStartedAtMs: Number(withContinuation?.continuationConfirmStartedAtMs ?? withTx?.continuationConfirmStartedAtMs ?? ev?.continuationConfirmStartedAtMs ?? NaN),
            continuationWsUpdateCountWithinWindow: Number(withContinuation?.continuationWsUpdateCountWithinWindow ?? withTx?.continuationWsUpdateCountWithinWindow ?? ev?.continuationWsUpdateCountWithinWindow ?? 0),
            continuationUniqueOhlcvTicksWithinWindow: Number(withContinuation?.continuationUniqueOhlcvTicksWithinWindow ?? withTx?.continuationUniqueOhlcvTicksWithinWindow ?? ev?.continuationUniqueOhlcvTicksWithinWindow ?? 0),
            continuationTradeUpdateCountWithinWindow: Number(withContinuation?.continuationTradeUpdateCountWithinWindow ?? withTx?.continuationTradeUpdateCountWithinWindow ?? ev?.continuationTradeUpdateCountWithinWindow ?? 0),
            continuationUniqueTradeTicksWithinWindow: Number(withContinuation?.continuationUniqueTradeTicksWithinWindow ?? withTx?.continuationUniqueTradeTicksWithinWindow ?? ev?.continuationUniqueTradeTicksWithinWindow ?? 0),
            continuationRunupSourceUsed: String(withContinuation?.continuationRunupSourceUsed ?? withTx?.continuationRunupSourceUsed ?? ev?.continuationRunupSourceUsed ?? 'no_runup'),
            continuationTradeSequenceSourceUsed: String(withContinuation?.continuationTradeSequenceSourceUsed ?? withTx?.continuationTradeSequenceSourceUsed ?? ev?.continuationTradeSequenceSourceUsed ?? 'ws_trade'),
            continuationTradeTickCountAtRunupMoment: Number(withContinuation?.continuationTradeTickCountAtRunupMoment ?? withTx?.continuationTradeTickCountAtRunupMoment ?? ev?.continuationTradeTickCountAtRunupMoment ?? 0),
            continuationTradeSequenceEligibleAtRunup: !!(withContinuation?.continuationTradeSequenceEligibleAtRunup ?? withTx?.continuationTradeSequenceEligibleAtRunup ?? ev?.continuationTradeSequenceEligibleAtRunup),
            continuationMaxConsecutiveTradeUpticks: Number(withContinuation?.continuationMaxConsecutiveTradeUpticks ?? withTx?.continuationMaxConsecutiveTradeUpticks ?? ev?.continuationMaxConsecutiveTradeUpticks ?? 0),
            continuationMinConsecutiveTradeUpticks: Number(withContinuation?.continuationMinConsecutiveTradeUpticks ?? withTx?.continuationMinConsecutiveTradeUpticks ?? ev?.continuationMinConsecutiveTradeUpticks ?? 0),
            continuationRequireTradeUpticks: !!(withContinuation?.continuationRequireTradeUpticks ?? withTx?.continuationRequireTradeUpticks ?? ev?.continuationRequireTradeUpticks),
            continuationSelectedTradeReads: Number(withContinuation?.continuationSelectedTradeReads ?? withTx?.continuationSelectedTradeReads ?? ev?.continuationSelectedTradeReads ?? 0),
            continuationSelectedOhlcvReads: Number(withContinuation?.continuationSelectedOhlcvReads ?? withTx?.continuationSelectedOhlcvReads ?? ev?.continuationSelectedOhlcvReads ?? 0),
            continuationWsUpdateTimestamps: Array.isArray(withContinuation?.continuationWsUpdateTimestamps) ? withContinuation.continuationWsUpdateTimestamps.slice(0,24) : (Array.isArray(withTx?.continuationWsUpdateTimestamps) ? withTx.continuationWsUpdateTimestamps.slice(0,24) : (Array.isArray(ev?.continuationWsUpdateTimestamps) ? ev.continuationWsUpdateTimestamps.slice(0,24) : [])),
            continuationWsUpdatePrices: Array.isArray(withContinuation?.continuationWsUpdatePrices) ? withContinuation.continuationWsUpdatePrices.slice(0,24) : (Array.isArray(withTx?.continuationWsUpdatePrices) ? withTx.continuationWsUpdatePrices.slice(0,24) : (Array.isArray(ev?.continuationWsUpdatePrices) ? ev.continuationWsUpdatePrices.slice(0,24) : [])),
            continuationTradeUpdateTimestamps: Array.isArray(withContinuation?.continuationTradeUpdateTimestamps) ? withContinuation.continuationTradeUpdateTimestamps.slice(0,24) : (Array.isArray(withTx?.continuationTradeUpdateTimestamps) ? withTx.continuationTradeUpdateTimestamps.slice(0,24) : (Array.isArray(ev?.continuationTradeUpdateTimestamps) ? ev.continuationTradeUpdateTimestamps.slice(0,24) : [])),
            continuationTradeUpdatePrices: Array.isArray(withContinuation?.continuationTradeUpdatePrices) ? withContinuation.continuationTradeUpdatePrices.slice(0,24) : (Array.isArray(withTx?.continuationTradeUpdatePrices) ? withTx.continuationTradeUpdatePrices.slice(0,24) : (Array.isArray(ev?.continuationTradeUpdatePrices) ? ev.continuationTradeUpdatePrices.slice(0,24) : [])),
            final,
          };
        });
        const confirmTxThreshold = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
        const confirmBuyThreshold = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
        const confirmLiqThreshold = Number(cfg?.LIVE_CONFIRM_MIN_LIQ_USD ?? cfg?.MIN_LIQUIDITY_FLOOR_USD ?? 0);
        const inferBuySell = (ratio, tx1m) => {
          if (!(Number.isFinite(ratio) && ratio > 0 && Number.isFinite(tx1m) && tx1m > 0)) return { buys: null, sells: null };
          const sells = tx1m / (1 + ratio);
          const buys = tx1m - sells;
          return { buys, sells };
        };
        const explainDriver = (r) => {
          const txPass = Number.isFinite(r.txAccelObserved) && r.txAccelObserved > confirmTxThreshold;
          const buyPass = Number.isFinite(r.carryBuySellRatio) ? (r.carryBuySellRatio > confirmBuyThreshold) : false;
          const buyObs = Number.isFinite(r.carryBuySellRatio) ? r.carryBuySellRatio : NaN;
          const liqPass = Number(r.liq || 0) >= confirmLiqThreshold;
          const reason = String(r.rejectReason || '');
          if (!txPass || reason.includes('confirm.confirmWeakTxAcceleration')) {
            return {
              driver: 'TxAcceleration',
              metric: `threshold=${confirmTxThreshold.toFixed(2)} txAccel=${Number.isFinite(r.txAccelObserved) ? r.txAccelObserved.toFixed(2) : 'null'} tx1m=${Number.isFinite(r.tx1m) ? r.tx1m.toFixed(2) : 'null'} tx5mAvg=${Number.isFinite(r.tx5mAvg) ? r.tx5mAvg.toFixed(2) : 'null'} tx30mAvg=${Number.isFinite(r.tx30mAvg) ? r.tx30mAvg.toFixed(2) : 'null'}`,
              miss: Number.isFinite(r.txAccelObserved) ? Math.max(0, confirmTxThreshold - r.txAccelObserved) : 9,
            };
          }
          if (!buyPass || reason.includes('confirm.confirmWeakBuyDominance')) {
            const bs = inferBuySell(buyObs, Number(r.tx1m || 0));
            return {
              driver: 'BuyDominance',
              metric: `threshold=${confirmBuyThreshold.toFixed(2)} buyDom=${Number.isFinite(buyObs) ? buyObs.toFixed(3) : 'null'} buys=${Number.isFinite(bs.buys) ? bs.buys.toFixed(0) : 'n/a'} sells=${Number.isFinite(bs.sells) ? bs.sells.toFixed(0) : 'n/a'}`,
              miss: Number.isFinite(buyObs) ? Math.max(0, confirmBuyThreshold - buyObs) : 9,
            };
          }
          if (!liqPass || reason.includes('confirm.fullLiqRejected')) {
            return {
              driver: 'Liquidity',
              metric: `threshold=${Math.round(confirmLiqThreshold)} liq=${Math.round(Number(r.liq || 0))}`,
              miss: Math.max(0, (confirmLiqThreshold - Number(r.liq || 0)) / Math.max(1, confirmLiqThreshold)),
            };
          }
          if (reason.includes('confirm.mcapStaleRejected')) {
            return { driver: 'McapStale', metric: `freshnessMs=${Number.isFinite(r.freshnessMs) ? Math.round(r.freshnessMs) : 'null'} threshold=${Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)}`, miss: 0.2 };
          }
          return { driver: 'Other', metric: `reason=${reason || 'none'}`, miss: 0.5 };
        };
        const decorateCandidate = (r) => {
          const rowRef = state?.watchlist?.mints?.[r.mint] || null;
          const mintFrag = `${String(r.mint || 'unknown').slice(0,5)}...`;
          const symbol = String(rowRef?.pair?.baseToken?.symbol || rowRef?.pair?.baseToken?.name || mintFrag);
          const buyObs = Number.isFinite(r.carryBuySellRatio) ? r.carryBuySellRatio : NaN;
          const txPass = Number.isFinite(r.txAccelObserved) && r.txAccelObserved > confirmTxThreshold;
          const buyPass = Number.isFinite(buyObs) && buyObs > confirmBuyThreshold;
          const liqPass = Number(r.liq || 0) >= confirmLiqThreshold;
          const passedChecks = (txPass ? 1 : 0) + (buyPass ? 1 : 0) + (liqPass ? 1 : 0);
          const driver = explainDriver(r);
          const liqScore = Math.log10(Math.max(1, Number(r.liq || 0)));
          const mcapScore = Math.log10(Math.max(1, Number(r.mcap || 0)));
          const ageScore = Number.isFinite(Number(r.ageMin)) ? Math.min(1, Number(r.ageMin) / 180) : 0;
          const failedStrength = (passedChecks * 100) + ((1 - Math.min(1, Number(driver.miss || 1))) * 40) + (liqScore + mcapScore + ageScore);
          const passStrength = ((txPass ? Math.min(3, Number(r.txAccelObserved || 0) / Math.max(0.0001, confirmTxThreshold)) : 0) * 30)
            + ((buyPass ? Math.min(3, buyObs / Math.max(0.0001, confirmBuyThreshold)) : 0) * 30)
            + ((liqPass ? Math.min(3, Number(r.liq || 0) / Math.max(1, confirmLiqThreshold)) : 0) * 20)
            + (mcapScore + ageScore);
          const checks = `checks=buyDom${buyPass ? '✓' : '✗'} txAccel${txPass ? '✓' : '✗'} liq${liqPass ? '✓' : '✗'}`;
          return { ...r, symbol, txPass, buyPass, liqPass, driver, failedStrength, passStrength, checks };
        };
        const confirmCandidatesDecorated = confirmCandidateTxRows.map(decorateCandidate);
        const strongestFailedConfirmRows = confirmCandidatesDecorated
          .filter((r) => r.final === 'rejected')
          .sort((a, b) => Number(b.failedStrength || 0) - Number(a.failedStrength || 0))
          .slice(0, 5)
          .map((r) => {
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
            return `- ${label} liq=${Math.round(Number(r.liq || 0))} mcap=${Math.round(Number(r.mcap || 0))} ageMin=${Number.isFinite(Number(r.ageMin)) ? Number(r.ageMin).toFixed(1) : 'null'} result=FAIL driver=${r.driver.driver} ${r.driver.metric} ${r.checks}`;
          });
        const freshnessOnlyFails = confirmCandidatesDecorated
          .filter((r) => r.final === 'rejected'
            && r.txPass
            && r.buyPass
            && r.liqPass
            && String(r.rejectReason || '').includes('confirm.mcapStaleRejected'));
        const freshnessOnlyFailBuckets = { b5_10: 0, b10_15: 0, b15_20: 0, gte20: 0 };
        for (const r of freshnessOnlyFails) {
          const f = Number(r.freshnessMs || 0);
          if (!(f > 0)) continue;
          if (f < 10_000) freshnessOnlyFailBuckets.b5_10 += 1;
          else if (f < 15_000) freshnessOnlyFailBuckets.b10_15 += 1;
          else if (f < 20_000) freshnessOnlyFailBuckets.b15_20 += 1;
          else freshnessOnlyFailBuckets.gte20 += 1;
        }
        const freshnessOnlyFailRows = freshnessOnlyFails
          .sort((a, b) => Number(a.freshnessMs || Infinity) - Number(b.freshnessMs || Infinity))
          .slice(0, 8)
          .map((r) => {
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
            return `- ${label} freshnessMs=${Number.isFinite(Number(r.freshnessMs)) ? Math.round(Number(r.freshnessMs)) : 'null'} buyDom=${Number.isFinite(Number(r.carryBuySellRatio)) ? Number(r.carryBuySellRatio).toFixed(3) : 'null'} txAccel=${Number.isFinite(Number(r.txAccelObserved)) ? Number(r.txAccelObserved).toFixed(2) : 'null'} liq=${Math.round(Number(r.liq || 0))}`;
          });
        const strongestPassedConfirmRows = confirmCandidatesDecorated
          .filter((r) => r.final === 'passed')
          .sort((a, b) => Number(b.passStrength || 0) - Number(a.passStrength || 0))
          .slice(0, 5)
          .map((r) => {
            const passDriver = (Number(r.txAccelObserved || 0) / Math.max(0.0001, confirmTxThreshold)) >= (Number(r.carryBuySellRatio || 0) / Math.max(0.0001, confirmBuyThreshold))
              ? 'TxAcceleration'
              : 'BuyDominance';
            const passMetric = passDriver === 'TxAcceleration'
              ? `threshold=${confirmTxThreshold.toFixed(2)} txAccel=${Number.isFinite(r.txAccelObserved) ? r.txAccelObserved.toFixed(2) : 'null'} tx1m=${Number.isFinite(r.tx1m) ? r.tx1m.toFixed(2) : 'null'} tx5mAvg=${Number.isFinite(r.tx5mAvg) ? r.tx5mAvg.toFixed(2) : 'null'} tx30mAvg=${Number.isFinite(r.tx30mAvg) ? r.tx30mAvg.toFixed(2) : 'null'}`
              : (() => { const bs = inferBuySell(Number(r.carryBuySellRatio || NaN), Number(r.tx1m || 0)); return `threshold=${confirmBuyThreshold.toFixed(2)} buyDom=${Number.isFinite(Number(r.carryBuySellRatio)) ? Number(r.carryBuySellRatio).toFixed(3) : 'null'} buys=${Number.isFinite(bs.buys) ? bs.buys.toFixed(0) : 'n/a'} sells=${Number.isFinite(bs.sells) ? bs.sells.toFixed(0) : 'n/a'}`; })();
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
            return `- ${label} liq=${Math.round(Number(r.liq || 0))} mcap=${Math.round(Number(r.mcap || 0))} ageMin=${Number.isFinite(Number(r.ageMin)) ? Number(r.ageMin).toFixed(1) : 'null'} result=PASS driver=${passDriver} ${passMetric}`;
          });

        // primary choke derived below from confirmRejectCounts
        const primaryChokeRaw = Object.entries(confirmRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0] || null;
        const primaryChokeName = primaryChokeRaw ? String(primaryChokeRaw[0]).replace('confirm.', '') : 'none';
        const primaryChokeCount = Number(primaryChokeRaw?.[1] || 0);
        const primaryChokePct = cumulativeConfirmReached > 0 ? ((primaryChokeCount / cumulativeConfirmReached) * 100) : 0;
        const fmtRate = (num, den) => `${num}/${den} (${den > 0 ? ((num/den)*100).toFixed(1) : '0.0'}%)`;
        const nearMissBuy = confirmCandidatesDecorated.filter(r => r.final === 'rejected' && r.driver?.driver === 'BuyDominance' && Number.isFinite(Number(r.carryBuySellRatio || NaN))).map(r => Number(r.carryBuySellRatio));
        const nearMissTx = confirmCandidatesDecorated.filter(r => r.final === 'rejected' && r.driver?.driver === 'TxAcceleration' && Number.isFinite(Number(r.txAccelObserved || NaN))).map(r => Number(r.txAccelObserved));
        const nearMissLines = [];
        if (nearMissBuy.length) nearMissLines.push(`- nearMisses: BuyDominance avg=${(nearMissBuy.reduce((a,b)=>a+b,0)/nearMissBuy.length).toFixed(2)} vs ${confirmBuyThreshold.toFixed(2)} threshold (n=${nearMissBuy.length})`);
        if (nearMissTx.length) nearMissLines.push(`- nearMisses: TxAcceleration avg=${(nearMissTx.reduce((a,b)=>a+b,0)/nearMissTx.length).toFixed(2)} vs ${confirmTxThreshold.toFixed(2)} threshold (n=${nearMissTx.length})`);
        const passedForProfile = confirmCandidatesDecorated.filter(r => r.final === 'passed');
        const median = (arr) => { if (!arr.length) return null; const s=arr.slice().sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
        const passLiqMed = median(passedForProfile.map(r => Number(r.liq||0)).filter(v=>v>0));
        const passMcapMed = median(passedForProfile.map(r => Number(r.mcap||0)).filter(v=>v>0));
        const passAgeMed = median(passedForProfile.map(r => Number(r.ageMin||NaN)).filter(v=>Number.isFinite(v) && v>=0));
        const passingProfileLine = passedForProfile.length
          ? `passingProfile: liq median=${passLiqMed != null ? `${Math.round(passLiqMed/1000)}k` : 'n/a'} mcap median=${passMcapMed != null ? `${Math.round(passMcapMed/1000)}k` : 'n/a'} age median=${passAgeMed != null ? `${Math.round(passAgeMed)}m` : 'n/a'}`
          : 'passingProfile: none';

        const continuationRows = confirmCandidatesDecorated.filter((r) => r.continuationMode);
        const continuationPassReasonCounts = {};
        const continuationFailReasonCounts = {};
        for (const r of continuationRows) {
          const pr = String(r?.continuationPassReason || 'none');
          continuationPassReasonCounts[pr] = Number(continuationPassReasonCounts[pr] || 0) + 1;
          if (r.final === 'rejected') {
            const rr = String(r.rejectReason || 'none').replace(/^confirmContinuation\./, '');
            continuationFailReasonCounts[rr] = Number(continuationFailReasonCounts[rr] || 0) + 1;
          }
        }
        const continuationPassReasonLine = Object.entries(continuationPassReasonCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const continuationFailReasonLine = Object.entries(continuationFailReasonCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';

        const momentumPassedRows = inWindowObj(compactWindow.momentumRecent || []).filter(x => String(x?.final || '').includes('momentum.passed')).slice(-20);
        const momentumPassedMintsSet = new Set(momentumPassedRows.map((x) => String(x?.mint || '')));
        const contFailByType = { hardDip: 0, windowExpired: 0, liq: 0, impact: 0, route: 0, other: 0 };
        let momentumPassedReachedRunup15 = 0;
        const seenRunup15Mints = new Set();
        for (const ev of postFlowWin) {
          const mint = String(ev?.mint || '');
          if (!momentumPassedMintsSet.has(mint)) continue;
          const reason = String(ev?.reason || '');
          if (String(ev?.stage || '') === 'confirm' && String(ev?.outcome || '') === 'rejected') {
            if (reason.includes('confirmContinuation.hardDip')) contFailByType.hardDip += 1;
            else if (reason.includes('confirmContinuation.windowExpired') || reason.includes('confirmContinuation.windowClose')) contFailByType.windowExpired += 1;
            else if (reason.includes('confirmContinuation.liq') || reason.includes('confirm.fullLiqRejected')) contFailByType.liq += 1;
            else if (reason.includes('confirmContinuation.impact') || reason.includes('confirmPriceImpact')) contFailByType.impact += 1;
            else if (reason.includes('confirmNoRoute')) contFailByType.route += 1;
            else contFailByType.other += 1;
          }
          const runup = Number(ev?.continuationMaxRunupPct || 0);
          if (String(ev?.stage || '') === 'confirm' && Number.isFinite(runup) && runup >= 0.015 && !seenRunup15Mints.has(mint)) {
            seenRunup15Mints.add(mint);
            momentumPassedReachedRunup15 += 1;
          }
        }

        const postByMint = {};
        for (const ev of postFlowWin) {
          const m = String(ev?.mint || 'unknown');
          postByMint[m] ||= [];
          postByMint[m].push(ev);
        }
        const recentPostCandidates = momentumPassedRows.slice(-10).map((x) => {
          const mint = String(x?.mint || 'unknown');
          const flow = (postByMint[mint] || []).filter(e => Number(e?.tMs||0) >= Number(x?.tMs||0));
          const preConfirm = flow.find(e=>e.stage==='preConfirm' && e.outcome==='rejected') ? 'rejected' : 'none';
          const confirm = flow.find(e=>e.stage==='confirm' && e.outcome==='passed') ? 'passed' : (flow.find(e=>e.stage==='confirm' && e.outcome==='rejected') ? 'rejected' : (flow.find(e=>e.stage==='confirm') ? 'reached' : 'none'));
          const attempt = flow.find(e=>e.stage==='attempt' && e.outcome==='reached') ? 'reached' : (flow.find(e=>e.stage==='attempt' && e.outcome==='rejected') ? 'rejected' : 'none');
          const fill = flow.find(e=>e.stage==='fill' && e.outcome==='passed') ? 'passed' : 'none';
          const finalReason = flow.slice().reverse().find(e=>String(e?.reason||'none')!=='none')?.reason || (fill === 'passed' ? 'filled' : 'none');
          const freshness = flow.find(e => e.stage === 'confirm' && Number.isFinite(Number(e?.freshnessMs)))?.freshnessMs;
          return `- ${formatDiagMintLabel(mint)} liq=${Math.round(Number(x?.liq||0))} mcap=${Math.round(Number(x?.mcap||0))} ageMin=${Number.isFinite(x?.ageMin) ? Number(x.ageMin).toFixed(1) : 'null'} freshnessMs=${Number.isFinite(Number(freshness)) ? Math.round(Number(freshness)) : 'null'} momentum=passed preConfirm=${preConfirm} confirm=${confirm} attempt=${attempt} fill=${fill} reason=${finalReason}`;
        });

        const recentSuccess = postFlowWin.filter(e => e.stage === 'fill' && e.outcome === 'passed').slice(-5).map((e) => `- ${formatDiagMintLabel(String(e?.mint||'n/a'))} liq=${Math.round(Number(e?.liq||0))} mcap=${Math.round(Number(e?.mcap||0))} ageMin=${Number.isFinite(e?.ageMin) ? Number(e.ageMin).toFixed(1) : 'null'} route=unknown attempt=passed fill=passed`);

        const liqBandPost = { lt30: 0, b30_50: 0, b50_75: 0, gte75: 0 };
        for (const ev of momentumPassedRows) {
          const liq = Number(ev?.liq || 0);
          if (liq < 30_000) liqBandPost.lt30 += 1;
          else if (liq < 50_000) liqBandPost.b30_50 += 1;
          else if (liq < 75_000) liqBandPost.b50_75 += 1;
          else liqBandPost.gte75 += 1;
        }

        const reserveBlocked = Number(counters?.watchlist?.executionReserveBlocked || 0);
        const targetUsdTooSmall = Number(counters?.watchlist?.executionTargetUsdTooSmall || 0);
        const swapEntryBlockedMissingDecimalsCount = Number(counters?.guardrails?.entryBlockedReasons?.missingDecimals || 0);
        const otherExecutionSpillover = Number(counters?.execution?.nonTradableMintRejected || 0) + Number(counters?.execution?.nonTradableMintCooldownActive || 0);
        const showExecutionSpillover = reserveBlocked > 0 || targetUsdTooSmall > 0 || swapEntryBlockedMissingDecimalsCount > 0 || otherExecutionSpillover > 0;
        const rc = counters?.runnerCapture || {};
        const holdSamples = Array.isArray(rc?.holdSecSamples) ? rc.holdSecSamples.map(Number).filter(Number.isFinite) : [];
        const sortedHold = holdSamples.slice().sort((a, b) => a - b);
        const medianHoldSec = sortedHold.length ? sortedHold[Math.floor(sortedHold.length / 2)] : null;
        const hotQueueSamples = Array.isArray(counters?.watchlist?.hotQueueSizeSamples) ? counters.watchlist.hotQueueSizeSamples.slice(-20) : [];
        const hotQueueAvg = hotQueueSamples.length ? (hotQueueSamples.reduce((s, x) => s + Number(x?.size || 0), 0) / hotQueueSamples.length) : null;
        const hotQueueMaxSeen = hotQueueSamples.length ? Math.max(...hotQueueSamples.map((x) => Number(x?.size || 0))) : null;
        const liqDropRejected = Number(counters?.watchlist?.confirmLiqDrop60sRejected || 0);
        const preConfirmMcapMissingRejected = Number(counters?.watchlist?.preConfirmMcapMissingRejected || 0);
        const preConfirmMcapLowRejected = Number(counters?.watchlist?.preConfirmMcapLowRejected || 0);
        const showPreconfirmPlumbing = preConfirmMcapMissingRejected > 0 || preConfirmMcapLowRejected > 0;

        const continuationModeActive = (process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true';
        const confirmWindowMs = Math.max(250, Number(process.env.CONFIRM_CONTINUATION_WINDOW_MS || 15000));
        const confirmWindowSec = Math.round(confirmWindowMs / 1000);
        const confirmReachedRunup15 = confirmCandidatesDecorated.filter((r) => Number.isFinite(Number(r.continuationMaxRunupPct)) && Number(r.continuationMaxRunupPct) >= 0.015).length;
        const requireTradeSequence = (process.env.CONFIRM_CONTINUATION_REQUIRE_TRADE_UPTICKS ?? 'false') === 'true';
        const minTradeSequence = Math.max(1, Number(process.env.CONFIRM_CONTINUATION_MIN_CONSECUTIVE_TRADE_UPTICKS || 2));
        const confirmReachedRunupAndTradeSeq = confirmCandidatesDecorated.filter((r) => {
          const runup = Number(r?.continuationMaxRunupPct ?? NaN);
          const maxSeq = Number(r?.continuationMaxConsecutiveTradeUpticks ?? 0);
          return Number.isFinite(runup) && runup >= 0.015 && (!requireTradeSequence || maxSeq >= minTradeSequence);
        }).length;
        const failedAfterRunupNoTradeSequence = Number(confirmRejectCounts['confirm.confirmContinuation.runupNoTradeTrendConfirm'] || 0);
        const runupSourceUsedCounts = {};
        const tradeSequenceSourceUsedCounts = {};
        for (const r of confirmCandidatesDecorated) {
          if (Number(r?.continuationMaxRunupPct || 0) >= 0.015) {
            const k = String(r?.continuationRunupSourceUsed || 'no_runup');
            runupSourceUsedCounts[k] = Number(runupSourceUsedCounts[k] || 0) + 1;
          }
          const ts = String(r?.continuationTradeSequenceSourceUsed || 'ws_trade');
          tradeSequenceSourceUsedCounts[ts] = Number(tradeSequenceSourceUsedCounts[ts] || 0) + 1;
        }
        const runupSourceUsedSummary = Object.entries(runupSourceUsedCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'no_runup';
        const tradeSequenceSourceUsedSummary = Object.entries(tradeSequenceSourceUsedCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const medianLocal = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
        const medianRunupPct = medianLocal(confirmCandidatesDecorated.map((r) => Number(r.continuationMaxRunupPct || NaN)).filter((v) => Number.isFinite(v)));
        const medianDipPct = medianLocal(confirmCandidatesDecorated.map((r) => Number(r.continuationMaxDipPct || NaN)).filter((v) => Number.isFinite(v)));
        const medianFinalPct = medianLocal(confirmCandidatesDecorated.map((r) => {
          const s = Number(r.continuationStartPrice || NaN);
          const f = Number(r.continuationFinalPrice || NaN);
          if (!(Number.isFinite(s) && Number.isFinite(f) && s > 0)) return NaN;
          return (f / s) - 1;
        }).filter((v) => Number.isFinite(v)));
        const passedRunupTimesMs = confirmCandidatesDecorated
          .filter((r) => r.final === 'passed')
          .map((r) => Number(r.continuationTimeToRunupPassMs || NaN))
          .filter((v) => Number.isFinite(v) && v >= 0);
        const medianTimeToRunupPassMs = medianLocal(passedRunupTimesMs);
        const medianTimeToRunupWindowPct = Number.isFinite(medianTimeToRunupPassMs) && confirmWindowMs > 0
          ? ((Number(medianTimeToRunupPassMs) / confirmWindowMs) * 100)
          : null;
        const runupTimingBuckets = { lt10s: 0, s10_20: 0, s20_40: 0, s40_60: 0, gt60s: 0 };
        for (const tMs of passedRunupTimesMs) {
          if (tMs < 10_000) runupTimingBuckets.lt10s += 1;
          else if (tMs < 20_000) runupTimingBuckets.s10_20 += 1;
          else if (tMs < 40_000) runupTimingBuckets.s20_40 += 1;
          else if (tMs <= 60_000) runupTimingBuckets.s40_60 += 1;
          else runupTimingBuckets.gt60s += 1;
        }
        const recycledRequalifiedPassedCount = Number(state?.runtime?.confirmRetryRequalifiedPassed || 0);
        const top3ConfirmBlockers = Object.entries(confirmRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const top3AttemptBlockers = Object.entries(attemptRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const topHandoffBlocker = Object.entries(attemptRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0]?.[0] || 'none';
        const strongestFailedConfirmCompact = confirmCandidatesDecorated
          .filter((r) => r.final === 'rejected')
          .sort((a, b) => Number(b.failedStrength || 0) - Number(a.failedStrength || 0))
          .slice(0, 3)
          .map((r) => {
            const label = formatDiagMintLabel(r.mint);
            const reason = String(r.rejectReason || 'unknown').replace(/^confirm\./, '');
            const liqDiag = reason.includes('confirmContinuation.liqDegraded')
              ? ` startLiq=${Number.isFinite(Number(r.continuationConfirmStartLiqUsd)) ? Math.round(Number(r.continuationConfirmStartLiqUsd)) : 'null'} currentLiq=${Number.isFinite(Number(r.continuationCurrentLiqUsd)) ? Math.round(Number(r.continuationCurrentLiqUsd)) : 'null'} liqChangePct=${Number.isFinite(Number(r.continuationLiqChangePct)) ? Number(r.continuationLiqChangePct).toFixed(3) : 'null'}`
              : '';
            return `- ${label} liq=${Math.round(Number(r.liq || 0))} mcap=${Math.round(Number(r.mcap || 0))} reason=${reason}${liqDiag}`;
          });
        const strongestPassedConfirmCompact = confirmCandidatesDecorated
          .filter((r) => r.final === 'passed')
          .sort((a, b) => Number(b.passStrength || 0) - Number(a.passStrength || 0))
          .slice(0, 3)
          .map((r) => {
            const label = formatDiagMintLabel(r.mint);
            return `- ${label} liq=${Math.round(Number(r.liq || 0))} mcap=${Math.round(Number(r.mcap || 0))} passReason=${String(r.continuationPassReason || 'none')}`;
          });
        const wsTraceSampleRows = confirmCandidatesDecorated
          .filter((r) => Number(r?.continuationWsUpdateCountWithinWindow || 0) > 0 || String(r?.continuationPriceSource || '').includes('snapshot_fallback'))
          .slice(-3)
          .map((r) => {
            const label = formatDiagMintLabel(r.mint);
            const source = String(r?.continuationPriceSource || 'unknown');
            const initialSource = String(r?.continuationInitialSourceUsed || 'unknown');
            const dominantSource = String(r?.continuationDominantSourceUsed || 'unknown');
            const wsTs = Array.isArray(r?.continuationWsUpdateTimestamps) ? r.continuationWsUpdateTimestamps.slice(0, 10).map((x)=>fmtCt(Number(x))).join(', ') : 'none';
            const wsPx = Array.isArray(r?.continuationWsUpdatePrices) ? r.continuationWsUpdatePrices.slice(0, 10).map((x)=>Number(x).toFixed(10)).join(', ') : 'none';
            const trTs = Array.isArray(r?.continuationTradeUpdateTimestamps) ? r.continuationTradeUpdateTimestamps.slice(0, 10).map((x)=>fmtCt(Number(x))).join(', ') : 'none';
            const trPx = Array.isArray(r?.continuationTradeUpdatePrices) ? r.continuationTradeUpdatePrices.slice(0, 10).map((x)=>Number(x).toFixed(10)).join(', ') : 'none';
            const readsPart = `selectedTradeReads=${Number(r?.continuationSelectedTradeReads || 0)} selectedOhlcvReads=${Number(r?.continuationSelectedOhlcvReads || 0)} uniqueTradeTicks=${Number(r?.continuationUniqueTradeTicksWithinWindow || 0)} uniqueOhlcvTicks=${Number(r?.continuationUniqueOhlcvTicksWithinWindow || 0)}`;
            const sourceMismatchPart = `initialSourceUsed=${initialSource} dominantSourceUsed=${dominantSource} runupSourceUsed=${String(r?.continuationRunupSourceUsed || 'no_runup')} tradeSequenceSourceUsed=${String(r?.continuationTradeSequenceSourceUsed || 'ws_trade')} tradeTickCountAtRunupMoment=${Number(r?.continuationTradeTickCountAtRunupMoment || 0)} tradeSequenceEligibleAtRunup=${r?.continuationTradeSequenceEligibleAtRunup ? 'true' : 'false'}`;
            const runupSatisfiedOnPart = `runupSatisfiedOn=${(Number(r?.continuationMaxRunupPct || 0) >= 0.015) ? String(r?.continuationRunupSourceUsed || 'unknown') : 'no_runup'}`;
            const sourcePart = source === 'ws_trade'
              ? `tradeTs=[${trTs}] tradePx=[${trPx}]`
              : (source === 'ws_ohlcv'
                ? `wsTs=[${wsTs}] wsPx=[${wsPx}]`
                : (source.includes('snapshot_fallback_wsStale')
                  ? `staleFallback wsTs=[${wsTs}] wsPx=[${wsPx}] tradeTs=[${trTs}] tradePx=[${trPx}]`
                  : `fallback(no fresh ws/trade in window)`));
            return `- ${label} startedAt=${Number.isFinite(Number(r?.continuationConfirmStartedAtMs)) ? fmtCt(Number(r.continuationConfirmStartedAtMs)) : 'n/a'} startPx=${Number.isFinite(Number(r?.continuationStartPrice)) ? Number(r.continuationStartPrice).toFixed(10) : 'n/a'} source=${source} ${readsPart} ${sourceMismatchPart} ${runupSatisfiedOnPart} ${sourcePart} final=${r.final} reason=${String(r?.rejectReason || r?.continuationPassReason || 'none')}`;
          });
        const continuationFailMix = { hardDip: 0, windowExpiredStall: 0, windowExpiredWeak: 0, dataUnavailable: 0, liqDegraded: 0, impact: 0, route: 0, retryCooldown: 0, retryNoImprovement: 0, other: 0 };
        for (const [k, v] of Object.entries(confirmRejectCounts)) {
          const n = Number(v || 0);
          if (k.includes('confirmContinuation.hardDip')) continuationFailMix.hardDip += n;
          else if (k.includes('confirmContinuation.windowExpiredStall')) continuationFailMix.windowExpiredStall += n;
          else if (k.includes('confirmContinuation.windowExpired') || k.includes('confirmContinuation.windowClose')) continuationFailMix.windowExpiredWeak += n;
          else if (k.includes('confirmContinuation.dataUnavailable')) continuationFailMix.dataUnavailable += n;
          else if (k.includes('confirmContinuation.liqDegraded') || k.includes('confirmContinuation.liq') || k.includes('confirm.fullLiqRejected')) continuationFailMix.liqDegraded += n;
          else if (k.includes('confirmContinuation.impact') || k.includes('confirmPriceImpact')) continuationFailMix.impact += n;
          else if (k.includes('confirmNoRoute')) continuationFailMix.route += n;
          else if (k.includes('confirmContinuation.retryCooldown')) continuationFailMix.retryCooldown += n;
          else if (k.includes('confirmContinuation.retryNoImprovement')) continuationFailMix.retryNoImprovement += n;
          else continuationFailMix.other += n;
        }
        const showCircuitAbnormal = !!circuitOpen;
        const freshnessMajorBlocker = Number(confirmRejectCounts['confirm.mcapStaleRejected'] || 0) > 0;

        return buildConfirmDiagMessage({
          windowHeaderLabel,
          fmtCt,
          effectiveWindowStartMs,
          updatedIso,
          elapsedHours,
          warmingUp,
          lastConfirmEvalAgeSec,
          confirmWindowMs,
          confirmWindowSec,
          showCircuitAbnormal,
          circuitOpen,
          circuitOpenReason,
          circuitOpenRemainingSec,
          hourConfirmReached2,
          hourConfirmPassed2,
          hourAttemptReached2,
          hourFill2,
          cumulativeConfirmReached,
          cumulativeConfirmPassed,
          cumAttemptReached,
          cumFill,
          fmtRate,
          continuationModeActive,
          continuationPassReasonCounts,
          continuationFailMix,
          confirmReachedRunup15,
          confirmReachedRunupAndTradeSeq,
          failedAfterRunupNoTradeSequence,
          runupSourceUsedSummary,
          tradeSequenceSourceUsedSummary,
          medianTimeToRunupPassMs,
          medianTimeToRunupWindowPct,
          runupTimingBuckets,
          top3ConfirmBlockers,
          top3AttemptBlockers,
          preConfirmRejectedCount: Number(preConfirmRejectedRows.length || 0),
          preConfirmRejectTop,
          recycledRequalifiedPassedCount,
          topHandoffBlocker,
          medianRunupPct,
          medianDipPct,
          medianFinalPct,
          strongestFailedConfirmCompact,
          strongestPassedConfirmCompact,
          wsTraceSampleRows,
        });
      }

      if (mode === 'momentum') {
        const hourFailed = Number(momentumEvalWin.filter(t=>t>=hourCutoffMs).length);
        const hourEvaluated = hourFailed + Number(momentumPassedWin.filter(t=>t>=hourCutoffMs).length);
        const cumFailed = Number(momentumEvalWin.length);
        const cumPassed = Number(momentumPassedWin.length);
        const cumEvaluated = cumFailed + cumPassed;
        const liqBandM = { lt30: 0, b30_40: 0, b40_50: 0, b50_75: 0, gte75: 0 };
        for (const ev of momentumLiqWin) {
          const liq = Number(ev?.liqUsd || 0);
          if (liq < 30_000) liqBandM.lt30 += 1;
          else if (liq < 40_000) liqBandM.b30_40 += 1;
          else if (liq < 50_000) liqBandM.b40_50 += 1;
          else if (liq < 75_000) liqBandM.b50_75 += 1;
          else liqBandM.gte75 += 1;
        }
        const paperDiagDebugMode = String(process.env.MOMENTUM_DIAG_SHOW_PAPER_FAILS || 'false').toLowerCase() === 'true';
        const paperPrimaryFailInWindow = momentumFailChecksWin.some((ev) => {
          const checks = Array.isArray(ev?.checks) ? ev.checks.map(String) : [];
          return String(checks[0] || '').startsWith('paper.');
        });
        const paperActiveInRulePath = false; // paper no longer active in live momentum gate
        const showPaperInFailedDist = paperDiagDebugMode || paperPrimaryFailInWindow || paperActiveInRulePath;
        const hardGuardRejectCountsWin = {};
        for (const ev of inWindowObj(compactWindow.momentumRecent || [])) {
          const isRejected = String(ev?.final || '').includes('momentumFailed');
          if (!isRejected) continue;
          const guards = Array.isArray(ev?.hardRejects) ? ev.hardRejects : [];
          for (const g of guards) {
            const guardKeyRaw = String(g || '').trim();
            if (!guardKeyRaw) continue;
            const guardKey = guardKeyRaw.startsWith('liq<')
              ? `hardGuard.liquidityBelowThreshold(${guardKeyRaw.replace('liq<','')})`
              : `hardGuard.${guardKeyRaw}`;
            hardGuardRejectCountsWin[guardKey] = Number(hardGuardRejectCountsWin[guardKey] || 0) + 1;
          }
        }
        const failedTopM = Object.entries({ ...failCheckCountsWin, ...hardGuardRejectCountsWin })
          .filter(([k]) => showPaperInFailedDist || !String(k || '').startsWith('paper.'))
          .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`- ${k}: ${v}`);
        const recentMomentumInputByMint = {};
        for (const s of inWindowObj(compactWindow.momentumInputSamples || [])) {
          const k = String(s?.mint || 'unknown');
          recentMomentumInputByMint[k] ||= [];
          recentMomentumInputByMint[k].push(s);
        }
        const momentumTxThresholdRuntime = Number(process.env.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0);
        const momentumVolThresholdRuntime = Number(process.env.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0);
        const momentumWalletThresholdRuntime = Number(process.env.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25);
        const scoreSamplesByMint = {};
        for (const s of inWindowObj(compactWindow.momentumScoreSamples || [])) {
          const m = String(s?.mint || 'unknown');
          const prev = scoreSamplesByMint[m] || null;
          if (!prev || Number(s?.tMs || 0) >= Number(prev?.tMs || 0)) scoreSamplesByMint[m] = s;
        }
        const buildMomentumCandidate = (x) => {
          const mintFull = String(x?.mint || 'unknown');
          // Diagnostics-only: use the exact event (x) as single source-of-truth for displayed metrics/checks/driver
          const sourceEvent = x || {};
          const liveRow = state?.watchlist?.mints?.[mintFull] || null;
          const symbol = String(liveRow?.pair?.baseToken?.symbol || '').trim() || `${mintFull.slice(0,6)}...`;
          // For diagnostics we intentionally read metrics only from the displayed event (sourceEvent).
          const tx1m = Number(sourceEvent?.tx1m ?? NaN);
          const tx5mAvg = Number(sourceEvent?.tx5mAvg ?? NaN);
          const tx30mAvg = Number(sourceEvent?.tx30mAvg ?? NaN);
          const vol5m = Number(sourceEvent?.v5 ?? NaN);
          const vol30mAvg = Number(sourceEvent?.v30 ?? NaN);
          const buyStrength = Number(sourceEvent?.bsr ?? NaN);
          const buyers1mRaw = (sourceEvent?.buyers1m);
          const buyers5mAvgRaw = (sourceEvent?.buyers5mAvg);
          const walletExpansionRaw = (sourceEvent?.walletExpansion);
          const walletSrc = (sourceEvent?.walletExpansion != null || sourceEvent?.buyers1m != null || sourceEvent?.buyers5mAvg != null)
            ? 'eval'
            : 'missing';
          const buyers1m = Number(buyers1mRaw ?? NaN);
          const buyers5mAvg = Number(buyers5mAvgRaw ?? NaN);
          const walletExpansion = Number(walletExpansionRaw ?? (Number.isFinite(buyers1m) && Number.isFinite(buyers5mAvg) && buyers5mAvg > 0 ? (buyers1m / buyers5mAvg) : NaN));
          const txStrength = (Number.isFinite(tx1m) && Number.isFinite(tx5mAvg) && tx5mAvg > 0) ? (tx1m / Math.max(1, tx5mAvg)) : NaN;
          const volStrength = (Number.isFinite(vol5m) && Number.isFinite(vol30mAvg) && vol30mAvg > 0) ? (vol5m / vol30mAvg) : NaN;
          const hardRejects = Array.isArray(sourceEvent?.hardRejects) ? sourceEvent.hardRejects : [];
          const guardPrimary = Array.isArray(hardRejects) && hardRejects.length ? String(hardRejects[0]) : null;
          const scoreSample = scoreSamplesByMint[mintFull] || null;
          const momentumScore = Number(sourceEvent?.momentumScore ?? scoreSample?.momentumScore ?? 0);
          const momentumScoreThreshold = Number(sourceEvent?.momentumScoreThreshold ?? scoreSample?.momentumScoreThreshold ?? process.env.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60);
          const momentumScoreBand = String(sourceEvent?.momentumScoreBand || scoreSample?.momentumScoreBand || 'unknown');
          const topScoreContributors = Array.isArray(sourceEvent?.topScoreContributors) && sourceEvent.topScoreContributors.length
            ? sourceEvent.topScoreContributors
            : (Array.isArray(scoreSample?.topScoreContributors) ? scoreSample.topScoreContributors : []);
          const topPenaltyContributors = Array.isArray(sourceEvent?.topPenaltyContributors) && sourceEvent.topPenaltyContributors.length
            ? sourceEvent.topPenaltyContributors
            : (Array.isArray(scoreSample?.topPenaltyContributors) ? scoreSample.topPenaltyContributors : []);
          const contributorText = topScoreContributors.length
            ? topScoreContributors.map((x) => `${String(x?.name || 'unknown')}:${Number(x?.score || 0)}`).join(', ')
            : 'none';
          const detractorText = topPenaltyContributors.length
            ? topPenaltyContributors.map((x) => `${String(x?.name || 'unknown')}:${Number(x?.penalty || 0)}`).join(', ')
            : 'none';
          return {
            mint: mintFull,
            symbol,
            liq: Number(sourceEvent?.liq || 0),
            mcap: Number(sourceEvent?.mcap || 0),
            ageMin: Number.isFinite(Number(sourceEvent?.ageMin)) ? Number(sourceEvent.ageMin) : null,
            branch: String(sourceEvent?.branch || 'mature_3_of_4'),
            momentumScore: Number(momentumScore || 0),
            momentumScoreThreshold,
            momentumScoreBand,
            topScoreContributors,
            topPenaltyContributors,
            contributorText,
            detractorText,
            final: String(sourceEvent?.final || 'passed'),
            hardRejects,
            guardPrimary,
            txStrength,
            volStrength,
            walletExpansion,
            buyers1m,
            buyers5mAvg,
            walletSrc,
            freshnessMs: Number.isFinite(Number(sourceEvent?.freshnessMs)) ? Number(sourceEvent.freshnessMs) : null,
            wsFreshnessMs: Number.isFinite(Number(sourceEvent?.wsFreshnessMs)) ? Number(sourceEvent.wsFreshnessMs) : null,
            freshnessForMicroGateMs: Number.isFinite(Number(sourceEvent?.freshnessForMicroGateMs)) ? Number(sourceEvent.freshnessForMicroGateMs) : null,
            freshnessSourceForMicroGate: String(sourceEvent?.freshnessSourceForMicroGate || 'unknown'),
            snapshotLagOverWsMs: Number.isFinite(Number(sourceEvent?.snapshotLagOverWsMs)) ? Number(sourceEvent.snapshotLagOverWsMs) : null,
            effectiveMicroMaxAgeMs: Number.isFinite(Number(sourceEvent?.effectiveMicroMaxAgeMs)) ? Number(sourceEvent.effectiveMicroMaxAgeMs) : null,
          };
        };
        const momentumCandidates = inWindowObj(compactWindow.momentumRecent || []).map(buildMomentumCandidate);
        const strongestFailedMomentumRows = momentumCandidates.filter(c => c.final.includes('momentumFailed')).sort((a,b)=>Number(b.momentumScore||0)-Number(a.momentumScore||0)).slice(0,3)
          .map(c => {
            const frag = `${c.mint.slice(0,6)}...`;
            const label = (c.symbol === frag) ? frag : `${c.symbol} (${frag})`;
            const guardPrimary = c.guardPrimary ? String(c.guardPrimary) : null;
            const guardFail = guardPrimary
              ? (guardPrimary.startsWith('liq<')
                ? `guardFail=liquidityBelowThreshold liq=${Math.round(c.liq)} threshold=${Math.round(Number(guardPrimary.replace('liq<','') || 0))}`
                : `guardFail=${guardPrimary}`)
              : 'guardFail=none';
            return `- ${label} score=${c.momentumScore.toFixed(1)} threshold=${Number(c.momentumScoreThreshold || process.env.MOMENTUM_SCORE_PASS_THRESHOLD || 60).toFixed(1)} liq=${Math.round(c.liq)} mcap=${Math.round(c.mcap)} ${guardFail}`;
          });
        const strongestPassedMomentumRows = momentumCandidates.filter(c => c.final.includes('momentum.passed')).sort((a,b)=>Number(b.momentumScore||0)-Number(a.momentumScore||0)).slice(0,3)
          .map(c => {
            const frag = `${c.mint.slice(0,6)}...`;
            const label = (c.symbol === frag) ? frag : `${c.symbol} (${frag})`;
            return `- ${label} score=${c.momentumScore.toFixed(1)} threshold=${Number(c.momentumScoreThreshold || process.env.MOMENTUM_SCORE_PASS_THRESHOLD || 60).toFixed(1)} liq=${Math.round(c.liq)} mcap=${Math.round(c.mcap)}`;
          });
        const chokeEntry = Object.entries(failCheckCountsWin).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0] || null;
        const chokeName = chokeEntry ? chokeEntry[0] : 'none';
        const chokeCount = Number(chokeEntry?.[1] || 0);
        const chokePct = cumEvaluated > 0 ? ((chokeCount / cumEvaluated) * 100) : 0;
        const repeatSuppressed = Number(counters?.watchlist?.momentumRepeatFailSuppressed||0);
        const freshnessSourceCounts = { ws: 0, snapshot: 0, unknown: 0 };
        const freshnessUnknownReasonCounts = { missingTelemetry: 0, inferredFromWs: 0, inferredFromSnapshot: 0 };
        const freshnessGateValues = [];
        const snapshotLagValues = [];
        for (const c of momentumCandidates) {
          const fsRaw = String(c?.freshnessSourceForMicroGate || 'unknown');
          const wsFresh = Number(c?.wsFreshnessMs ?? NaN);
          const snapFresh = Number(c?.freshnessMs ?? NaN);
          let fs = fsRaw;
          if (fs !== 'ws' && fs !== 'snapshot') {
            if (Number.isFinite(wsFresh) && wsFresh >= 0) {
              fs = 'ws';
              freshnessUnknownReasonCounts.inferredFromWs += 1;
            } else if (Number.isFinite(snapFresh) && snapFresh >= 0) {
              fs = 'snapshot';
              freshnessUnknownReasonCounts.inferredFromSnapshot += 1;
            } else {
              fs = 'unknown';
              freshnessUnknownReasonCounts.missingTelemetry += 1;
            }
          }
          if (fs === 'ws') freshnessSourceCounts.ws += 1;
          else if (fs === 'snapshot') freshnessSourceCounts.snapshot += 1;
          else freshnessSourceCounts.unknown += 1;
          const fg = Number(c?.freshnessForMicroGateMs ?? NaN);
          if (Number.isFinite(fg) && fg >= 0) freshnessGateValues.push(fg);
          const sl = Number(c?.snapshotLagOverWsMs ?? NaN);
          if (Number.isFinite(sl) && sl >= 0) snapshotLagValues.push(sl);
        }
        const medianLocalNum = (arr) => {
          if (!arr.length) return null;
          const s = arr.slice().sort((a,b)=>a-b);
          const m = Math.floor(s.length / 2);
          return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
        };
        const medianFreshnessForGateMs = medianLocalNum(freshnessGateValues);
        const medianSnapshotLagOverWsMs = medianLocalNum(snapshotLagValues);

        const top3ScoringFailReasons = Object.entries(failCheckCountsWin)
          .filter(([k]) => !String(k).startsWith('hardGuard.'))
          .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
          .slice(0,3)
          .map(([k,v])=>`- ${k}: ${v}`);
        const top3HardGuardBlockers = Object.entries(hardGuardRejectCountsWin)
          .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))
          .slice(0,3)
          .map(([k,v])=>`- ${k}: ${v}`);

        const nearPassGuardBlocked = momentumCandidates.filter((c) => c.final.includes('momentumFailed')
          && Number.isFinite(Number(c.momentumScore))
          && Number(c.momentumScore) >= Number(c.momentumScoreThreshold || process.env.MOMENTUM_SCORE_PASS_THRESHOLD || 60)
          && Array.isArray(c.hardRejects)
          && c.hardRejects.length > 0);
        const nearPassGuardCounts = {};
        for (const c of nearPassGuardBlocked) {
          const g = String(c.guardPrimary || c.hardRejects?.[0] || 'unknown');
          nearPassGuardCounts[g] = Number(nearPassGuardCounts[g] || 0) + 1;
        }
        const nearPassTopGuard = Object.entries(nearPassGuardCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0]?.[0] || 'none';

        const momentumPassedRows = inWindowObj(compactWindow.momentumRecent || []).filter((x) => String(x?.final || '').includes('momentum.passed'));
        const momentumPassedMints = new Set(momentumPassedRows.map((x) => String(x?.mint || '')));
        const confirmPassedSet = new Set();
        const fillSet = new Set();
        const reachedRunup15Set = new Set();
        const confirmFailMix = { hardDip: 0, windowExpired: 0, liq: 0, route: 0, impact: 0, other: 0 };
        for (const ev of postFlowWin) {
          const mint = String(ev?.mint || '');
          if (!momentumPassedMints.has(mint)) continue;
          if (String(ev?.stage || '') === 'confirm' && String(ev?.outcome || '') === 'passed') confirmPassedSet.add(mint);
          if (String(ev?.stage || '') === 'fill' && String(ev?.outcome || '') === 'passed') fillSet.add(mint);
          const runup = Number(ev?.continuationMaxRunupPct || 0);
          if (String(ev?.stage || '') === 'confirm' && Number.isFinite(runup) && runup >= 0.015) reachedRunup15Set.add(mint);
          if (String(ev?.stage || '') === 'confirm' && String(ev?.outcome || '') === 'rejected') {
            const reason = String(ev?.reason || '');
            if (reason.includes('confirmContinuation.hardDip')) confirmFailMix.hardDip += 1;
            else if (reason.includes('confirmContinuation.windowExpired') || reason.includes('confirmContinuation.windowClose')) confirmFailMix.windowExpired += 1;
            else if (reason.includes('confirmContinuation.liq') || reason.includes('confirm.fullLiqRejected')) confirmFailMix.liq += 1;
            else if (reason.includes('confirmNoRoute')) confirmFailMix.route += 1;
            else if (reason.includes('confirmContinuation.impact') || reason.includes('confirmPriceImpact')) confirmFailMix.impact += 1;
            else confirmFailMix.other += 1;
          }
        }

        return buildMomentumDiagMessage({
          windowHeaderLabel,
          fmtCt,
          effectiveWindowStartMs,
          updatedIso,
          elapsedHours,
          warmingUp,
          lastMomentumEvalAgeSec,
          cumEvaluated,
          cumPassed,
          cumFailed,
          earlyCountWin,
          momentumAgeWin,
          chokeName,
          chokeCount,
          chokePct,
          momentumPassedMints,
          confirmPassedSet,
          fillSet,
          reachedRunup15Set,
          confirmFailMix,
          top3ScoringFailReasons,
          top3HardGuardBlockers,
          nearPassGuardBlocked,
          nearPassTopGuard,
          strongestFailedMomentumRows,
          strongestPassedMomentumRows,
          liqBandM,
          freshnessSourceCounts,
          freshnessUnknownReasonCounts,
          medianFreshnessForGateMs,
          medianSnapshotLagOverWsMs,
          repeatSuppressed,
          repeatMintsTop,
          repeatReasonTop,
        });
      }

      const routeable = Number(candidateRouteableWin.length || 0);
      const pairFetchReqWin = Number(candidateSeenWin.length || 0);
      const pairFetchHitWin = Number(candidateRouteableWin.length || 0);
      const pairFetchRate = pairFetchReqWin > 0 ? `${Math.round((pairFetchHitWin / pairFetchReqWin) * 100)}%` : 'n/a';

      const providerWinRate = (name) => {
        const req = providerHealthWin.filter((x) => String(x?.provider || '') === name && String(x?.outcome || '') === 'request').length;
        const hit = providerHealthWin.filter((x) => String(x?.provider || '') === name && String(x?.outcome || '') === 'hit').length;
        return req > 0 ? `${Math.round((hit / req) * 100)}%` : 'n/a';
      };
      const providerBirdEyeRateWin = providerWinRate('birdeye');
      const providerJupiterRateWin = providerWinRate('jupiter');
      const providerDexRateWin = providerWinRate('dexscreener');
      const preHotConsidered = Number(counters?.watchlist?.preHotConsidered || 0);
      const preHotPassed = Number(counters?.watchlist?.preHotPassed || 0);
      const preHotFailed = Number(counters?.watchlist?.preHotFailed || 0);
      const hotEnq = Number(counters?.watchlist?.hotEnqueued || 0);
      const hotCons = Number(counters?.watchlist?.hotConsumed || 0);

      const preHotMinLiqActive = Number(state?.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 0);
      const preHotConsideredRows = preHotFlowWin.filter((x) => String(x?.stage || '') === 'preHot' && String(x?.outcome || '') === 'considered');
      const preHotPassedRows = preHotFlowWin.filter((x) => String(x?.stage || '') === 'preHot' && String(x?.outcome || '') === 'passed');
      const preHotRejectedRows = preHotFlowWin.filter((x) => String(x?.stage || '') === 'preHot' && String(x?.outcome || '') === 'rejected');
      const preHotMissedTriggerRows = preHotFlowWin.filter((x) => String(x?.stage || '') === 'preHotEntry' && String(x?.outcome || '') === 'missedTrigger');
      const hotEnqueuedRows = preHotFlowWin.filter((x) => String(x?.stage || '') === 'hotQueue' && String(x?.outcome || '') === 'enqueued');

      const preHotConsideredWin = Number(preHotConsideredRows.length || 0);
      const preHotPassedWin = Number(preHotPassedRows.length || 0);
      const preHotFailedWin = Number(preHotRejectedRows.length || 0);
      const hotEnqWin = Number(hotEnqueuedRows.length || 0);
      const hotConsWin = Number(inWindowTs(compactWindow.watchlistSeen || []).length || 0);

      const liqBandKey = (liq) => {
        const n = Number(liq || 0);
        if (n >= 75_000) return '75k+';
        if (n >= 50_000) return '50-75k';
        if (n >= 40_000) return '40-50k';
        if (n >= 30_000) return '30-40k';
        return null;
      };
      const bandKeys = ['30-40k', '40-50k', '50-75k', '75k+'];
      const makeBandShape = () => ({
        candidateSeen: 0,
        preHotConsidered: 0,
        preHotPassed: 0,
        hotEnqueued: 0,
        momentumEvaluated: 0,
        momentumPassed: 0,
        hardGuardBlocked: 0,
        confirmReached: 0,
      });
      const funnelByBand = Object.fromEntries(bandKeys.map((k) => [k, makeBandShape()]));
      const reasonByBand = Object.fromEntries(bandKeys.map((k) => [k, {}]));
      const addReason = (band, reason) => {
        if (!band || !reasonByBand[band]) return;
        const key = String(reason || 'unknown');
        reasonByBand[band][key] = Number(reasonByBand[band][key] || 0) + 1;
      };
      const classifyReason = (raw) => {
        const r = String(raw || '').toLowerCase();
        if (!r || r === 'none') return null;
        if (r.includes('mcap/liquidity>10.0')) return 'mcap/liquidity>10.0';
        if (r.includes('buypressure')) return 'buyPressure';
        if (r.includes('walletexpansion')) return 'walletExpansion';
        if (r.includes('volumeexpansion')) return 'volumeExpansion';
        if (r.includes('cooldown') || r.includes('repeat')) return 'cooldown/repeat suppression';
        if (r.includes('liq') || r.includes('liquidity')) return 'liquidity-based rejection';
        return String(raw || 'other');
      };

      for (const ev of candidateLiquiditySeenWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (band) funnelByBand[band].candidateSeen += 1;
      }
      for (const ev of preHotConsideredRows) {
        const band = liqBandKey(ev?.liqUsd);
        if (band) funnelByBand[band].preHotConsidered += 1;
      }
      for (const ev of preHotPassedRows) {
        const band = liqBandKey(ev?.liqUsd);
        if (band) funnelByBand[band].preHotPassed += 1;
      }
      for (const ev of hotEnqueuedRows) {
        const band = liqBandKey(ev?.liqUsd);
        if (band) funnelByBand[band].hotEnqueued += 1;
      }
      for (const ev of momentumLiqWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (band) funnelByBand[band].momentumEvaluated += 1;
      }
      for (const ev of inWindowObj(compactWindow.momentumRecent || [])) {
        if (String(ev?.final || '') !== 'momentum.passed') continue;
        const band = liqBandKey(ev?.liq);
        if (band) funnelByBand[band].momentumPassed += 1;
      }
      for (const ev of postFlowWin) {
        const stage = String(ev?.stage || '');
        const outcome = String(ev?.outcome || '');
        const band = liqBandKey(ev?.liq);
        if (!band) continue;
        if (stage === 'confirm' && outcome === 'reached') funnelByBand[band].confirmReached += 1;
      }
      for (const ev of momentumFailChecksWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        const checks = Array.isArray(ev?.checks) ? ev.checks.map((x) => String(x || '')) : [];
        const hardGuardHit = checks.some((c) => {
          const cc = String(c || '').toLowerCase();
          return ['dex.mcap/liquidity>10.0', 'dex.spread>3%', 'dex.age<180s', 'dex.liqdrop60s>10%'].includes(cc) || cc.startsWith('dex.liq<');
        });
        if (hardGuardHit) funnelByBand[band].hardGuardBlocked += 1;
        for (const c of checks) {
          const rr = classifyReason(c);
          if (rr) addReason(band, rr);
        }
      }
      for (const ev of preHotRejectedRows) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        const reasons = Array.isArray(ev?.reasons) && ev.reasons.length ? ev.reasons : [ev?.reason || 'unknown'];
        for (const r of reasons) {
          const rr = classifyReason(r);
          if (rr) addReason(band, rr);
        }
      }
      for (const ev of repeatSuppressedWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        addReason(band, 'cooldown/repeat suppression');
      }
      const topRejectionByBand = Object.fromEntries(bandKeys.map((k) => {
        const top = Object.entries(reasonByBand[k] || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0];
        return [k, top ? `${top[0]}:${top[1]}` : 'none'];
      }));
      const hotReasonMissByBand = Object.fromEntries(bandKeys.map((k) => [k, 0]));
      for (const ev of preHotMissedTriggerRows) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        hotReasonMissByBand[band] = Number(hotReasonMissByBand[band] || 0) + 1;
      }

      const shortlistPreByBand = Object.fromEntries(bandKeys.map((k) => [k, 0]));
      const shortlistSelectedByBand = Object.fromEntries(bandKeys.map((k) => [k, 0]));
      for (const ev of shortlistPreCandidateWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        shortlistPreByBand[band] = Number(shortlistPreByBand[band] || 0) + 1;
      }
      for (const ev of shortlistSelectedWin) {
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        shortlistSelectedByBand[band] = Number(shortlistSelectedByBand[band] || 0) + 1;
      }
      const shortlistDroppedByBand = Object.fromEntries(bandKeys.map((k) => [k, Math.max(0, Number(shortlistPreByBand[k] || 0) - Number(shortlistSelectedByBand[k] || 0))]));

      const trackedPreMomentumReasons = [
        'precheck.cooldown',
        'hot.mcapLow(<250000)',
        'precheck.alreadyOpen',
        'hot.mcapStaleData',
      ];
      const preMomentumBlockersByBand = Object.fromEntries(bandKeys.map((k) => [k, Object.fromEntries(trackedPreMomentumReasons.map((r) => [r, 0]))]));
      for (const ev of blockersWin) {
        const rawReason = String(ev?.reason || '');
        const reason = trackedPreMomentumReasons.find((r) => rawReason.startsWith(r)) || null;
        if (!reason) continue;
        const band = liqBandKey(ev?.liqUsd);
        if (!band) continue;
        preMomentumBlockersByBand[band][reason] = Number(preMomentumBlockersByBand[band][reason] || 0) + 1;
      };
      const preMomentumBlockersByBandText = Object.fromEntries(bandKeys.map((k) => {
        const row = preMomentumBlockersByBand[k] || {};
        return [k, `cooldown=${Number(row['precheck.cooldown'] || 0)} mcapLow=${Number(row['hot.mcapLow(<250000)'] || 0)} alreadyOpen=${Number(row['precheck.alreadyOpen'] || 0)} mcapStale=${Number(row['hot.mcapStaleData'] || 0)}`];
      }));

      const blockerTop5 = Object.entries(blockerCounts1h)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)
        ).slice(0,5);
      const primaryChokeRaw = blockerTop5[0]?.[0] || 'none';
      const primaryChoke = blockerRename(primaryChokeRaw);
      const chokeStage = String(primaryChokeRaw || 'none').split('.')[0] || 'none';
      const top5Blockers = blockerTop5.map(([k,v])=>`- ${blockerRename(k)} = ${v}`);

      const hotStalkingFloor = Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40000);
      const stalkableByMint = {};
      for (const ev of stalkableSeenWin) {
        const m = String(ev?.mint || 'unknown');
        const liq = Number(ev?.liqUsd || 0);
        if (!Number.isFinite(liq) || liq <= 0) continue;
        stalkableByMint[m] = Math.max(Number(stalkableByMint[m] || 0), liq);
      }
      const stalkableCandidates = Object.values(stalkableByMint).filter((liq) => Number(liq) >= hotStalkingFloor).length;
      const stalkableBand = { b30_50: 0, b50_75: 0, gte75: 0 };
      for (const liq of Object.values(stalkableByMint)) {
        if (Number(liq) < hotStalkingFloor) continue;
        if (Number(liq) < 50_000) stalkableBand.b30_50 += 1;
        else if (Number(liq) < 75_000) stalkableBand.b50_75 += 1;
        else stalkableBand.gte75 += 1;
      }
      const bypassAllowed = Number(counters?.watchlist?.hotLiqMomentumBypassAllowed || 0);
      const bypassRejected = Number(counters?.watchlist?.hotLiqMomentumBypassRejected || 0);
      const bypassPrimaryReject = Object.entries(counters?.watchlist?.hotLiqBypassPrimaryRejectReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0]?.[0] || 'none';
      const bypassAllowedWin = Number(hotBypassWin.filter((x) => String(x?.decision || '') === 'allowed').length || 0);
      const bypassRejectedWin = Number(hotBypassWin.filter((x) => String(x?.decision || '') === 'rejected').length || 0);
      const bypassPrimaryRejectWin = Object.entries(hotBypassWin
        .filter((x) => String(x?.decision || '') === 'rejected')
        .reduce((acc, x) => {
          const k = String(x?.primary || 'unknown');
          acc[k] = Number(acc[k] || 0) + 1;
          return acc;
        }, {}))
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0] || 'none';

      const liqBandFromMomentum = momentumLiqWin.length > 0;
      let liqBand = { lt30: 0, b30_50: 0, b50_75: 0, gte75: 0 };
      if (liqBandFromMomentum) {
        for (const ev of momentumLiqWin) {
          const liq = Number(ev?.liqUsd || 0);
          if (liq < 30_000) liqBand.lt30 += 1;
          else if (liq < 50_000) liqBand.b30_50 += 1;
          else if (liq < 75_000) liqBand.b50_75 += 1;
          else liqBand.gte75 += 1;
        }
      } else {
        for (const row of Object.values(state?.watchlist?.mints || {})) {
          const liq = Number(row?.latest?.liqUsd || 0);
          if (liq <= 0) continue;
          if (liq < 30_000) liqBand.lt30 += 1;
          else if (liq < 50_000) liqBand.b30_50 += 1;
          else if (liq < 75_000) liqBand.b50_75 += 1;
          else liqBand.gte75 += 1;
        }
      }

      const downstreamShort = cumulativeMomentumEvaluated === 0
        ? `momentumEvaluated=0 (downstream idle)`
        : `momentum=${cumulativeMomentumEvaluated}/${cumulativeMomentumPassed} confirm=${cumulativeConfirmReached}/${cumulativeConfirmPassed} attempt=${cumulativeAttempt} fill=${cumulativeFill}`;

      const examples = [];
      if (recentMomo.length) {
        examples.push(...recentMomo.slice(-5).map(x => `${x} stage=momentum`));
      } else if (Array.isArray(counters?.watchlist?.hotBypassTraceLast10) && counters.watchlist.hotBypassTraceLast10.length) {
        examples.push(...counters.watchlist.hotBypassTraceLast10.slice(-5).map(x => {
          const liq = Number(x?.liq || 0);
          return `- ${String(x?.mint||'unknown').slice(0,6)} liq=${Number.isFinite(liq) && liq > 0 ? Math.round(liq) : 'unknown'} mcap=unknown stage=${x?.next||'hot'} reason=${x?.final||x?.decision||'unknown'}`;
        }));
      } else {
        const earlyBlockers = blockersWin.slice(-5).map(x => `- ${String(x?.mint||'unknown').slice(0,6)} liq=unknown mcap=unknown stage=${String(x?.reason||'unknown').split('.')[0]} reason=${blockerRename(String(x?.reason||'unknown'))}`);
        examples.push(...earlyBlockers);
      }

      return buildCompactDiagMessage({
        windowHeaderLabel,
        fmtCt,
        effectiveWindowStartMs,
        updatedIso,
        elapsedHours,
        warmingUp,
        scansPerHourWindow,
        watchlistSize,
        hotDepth,
        evalsPerMinute,
        providerRate,
        providers,
        providerBirdEyeRateWin,
        providerJupiterRateWin,
        providerDexRateWin,
        scannerHealth,
        uniqueCandidatesSeen,
        uniqueAboveHotFloor,
        routeable,
        pairFetchRate,
        preHotConsidered,
        preHotPassed,
        preHotFailed,
        preHotConsideredWin,
        preHotPassedWin,
        preHotFailedWin,
        hotEnq,
        hotCons,
        hotEnqWin,
        hotConsWin,
        cumulativeMomentumEvaluated,
        cumulativeConfirmReached,
        cumulativeAttempt,
        cumulativeFill,
        primaryChoke,
        chokeStage,
        top5Blockers,
        preHotMinLiqActive,
        state,
        cfg,
        hotStalkingFloor,
        bypassAllowed,
        bypassRejected,
        bypassPrimaryReject,
        bypassAllowedWin,
        bypassRejectedWin,
        bypassPrimaryRejectWin,
        stalkableCandidates,
        stalkableBand,
        liqBandFromMomentum,
        liqBand,
        funnelByBand,
        topRejectionByBand,
        preMomentumBlockersByBandText,
        hotReasonMissByBand,
        shortlistPreByBand,
        shortlistSelectedByBand,
        shortlistDroppedByBand,
        downstreamShort,
        examples,
      });
    }
    return buildFullDiagMessage({ state, fmtCt, nowMs, windowHours, updatedIso, ageSec, diagSnapshot });
  };
}
