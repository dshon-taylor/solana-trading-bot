import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getConfig, summarizeConfigForBoot } from './config.mjs';
import { applyOnchainBalanceToPosition } from './persistence/reconcile_positions.mjs';
import { loadKeypairFromEnv, loadKeypairFromSopsFile, getPublicKeyBase58 } from './trading/wallet.mjs';
import { makeConnection, getSolBalanceLamports, getSplBalance, getTokenHoldingsByMint } from './trading/portfolio.mjs';
import { getTokenPairs, pickBestPair } from './providers/dexscreener.mjs';
import { getRugcheckReport, isTokenSafe } from './providers/rugcheck.mjs';
import { getTokenSupply } from './providers/helius.mjs';
import { passesBaseFilters, evaluateMomentumSignal, canUseMomentumFallback } from './trading/strategy.mjs';
import { executeSwap, toBaseUnits, DECIMALS } from './trading/trader.mjs';
import { nowIso, safeErr } from './observability/logger.mjs';
import { loadState, saveState } from './persistence/state.mjs';
import { tgSend, tgSetMyCommands } from './telegram/index.mjs';
import { bump, bumpSourceCounter, snapshotAndReset, formatThroughputSummary, bumpWatchlistFunnel, rollWatchlistMinuteWindow } from './observability/metrics.mjs';
import { handleTelegramControls } from './telegram/control.mjs';
import { trackerMaybeEnqueue, trackerTick } from './trading/tracker.mjs';
import { pushDebug } from './observability/debug_buffer.mjs';
import { safeMsg } from './analytics/ai.mjs';
import { getModels, preprocessCandidate, analyzeTrade, gatekeep } from './analytics/ai_pipeline.mjs';
import { appendCost, estimateCostUsd, parseRange, readLedger, summarize } from './trading/cost.mjs';
import { jupQuote } from './providers/jupiter/client.mjs';
import { autoTuneFilters } from './analytics/autotune.mjs';
import { logCandidateDaily, appendJsonl } from './trading/candidates_ledger.mjs';
import { ensureDexState, getDexCooldownUntilMs, hitDex429, isDexScreener429 } from './trading/dex_cooldown.mjs';
import { ensureMarketDataState, computeAdaptiveScanDelayMs, getCachedPairSnapshot } from './market_data/reliability.mjs';
import { getMarketSnapshot, getEntrySnapshotUnsafeReason, isStopSnapshotUsable, getSnapshotStatus, snapshotFromBirdseye, formatMarketDataProviderSummary, markMarketDataRejectImpact } from './market_data/router.mjs';
import { hitJup429, isJup429, jupCooldownRemainingMs } from './providers/jupiter/cooldown.mjs';
import { maybeAlivePing } from './observability/alive_ping.mjs';
import { ensureCircuitState, circuitOkForEntries, circuitHit, circuitClear } from './trading/circuit_breaker.mjs';
import { maybePruneJsonlByAge, maybeRotateBySize } from './persistence/ledger_retention.mjs';
import { ensureCapitalGuardrailsState, canOpenNewEntry, recordEntryOpened, applySoftReserveToUsdTarget } from './trading/capital_guardrails.mjs';
import { ensurePlaybookState, recordPlaybookRestart, recordPlaybookError, evaluatePlaybook, runSelfRecovery, PLAYBOOK_MODE_DEGRADED } from './observability/incident_playbook.mjs';
import { createStreamingProvider } from './providers/streaming_provider.mjs';
import { createBirdseyeLiteClient } from './providers/birdeye/http_client.mjs';
import { didEntryFill } from './trading/entry_reliability.mjs';
import createWatchlistPipeline from './control_tower/watchlist_pipeline.mjs';
import { openPosition, processExposureQueue } from './control_tower/entry_engine.mjs';
import createExitEngine from './control_tower/exit_engine.mjs';
import { shouldStopPortfolio, reconcilePositions, syncExposureStateWithPositions, runPortfolioRiskCycle } from './control_tower/portfolio_control.mjs';
import { createOpsReporting, createSpendSummaryCache, fmtUsd } from './control_tower/ops_reporting.mjs';
import { startWatchlistCleanupTimer, startObservabilityHeartbeatTimer, startPositionsLoopTimer } from './control_tower/runtime_timers.mjs';
import { createPositionsLoop } from './control_tower/positions_loop.mjs';
import { createDiagReporting, initializeDiagCounters, runRejectionSummary } from './control_tower/diag_reporting.mjs';
import { appendDiagEvent, getDiagEventsPath } from './control_tower/diag_reporting/diag_event_store.mjs';
import { createScanCompactEventPusher } from './control_tower/diag_reporting/stage_scan_compact_events.mjs';
import { bootstrapCompactWindowState } from './control_tower/diag_reporting/stage_boot_compact_window.mjs';
import { createCandidatePipeline, bootstrapStreamingCandidateSources } from './control_tower/candidate_pipeline.mjs';
import { createOperatorSurfaces, bootstrapOperatorSurfaces, pollTelegramControls } from './control_tower/operator_surfaces.mjs';
import { runWatchlistTriggerLane } from './control_tower/watchlist_pipeline_runtime.mjs';
import { createScanPipeline, createScanCycleState, runScanCycle } from './control_tower/scan_pipeline.mjs';
import { createEntryDispatch, bindWsManagerExitHandler } from './control_tower/entry_dispatch/index.mjs';
import { announceBootStatus, seedOpenPositionsOnBoot, resolveBootSolUsdWithRetry, sendBootBalancesMessage, reconcileStartupState, bootRuntimeContext } from './control_tower/startup.mjs';
import { runJupiterPreflight } from './control_tower/route_control/stage_jupiter_preflight.mjs';
import { computePreTrailStopPrice } from './signals/stop_policy.mjs';
import { confirmQualityGate, createConfirmContinuationGate, recordConfirmCarryTrace, resolveConfirmTxMetrics } from './control_tower/confirm_helpers.mjs';
import {
  createGlobalTimers,
  clearAllTimers,
  createSolUsdPriceResolver,
  startHealthServer,
  runNodeScriptJson as runNodeScriptJsonCore,
  resolveMintCreatedAtFromRpc,
  computeMcapUsd as computeMcapUsdCore,
  fmtCt,
  startMemoryMonitors,
  registerGracefulShutdown,
  startRpcProbeAndHeartbeat,
  initializeTimescaleDbIfEnabled,
  initializeRuntimeState,
  createMainLoopState,
  runMaintenanceChores,
  runLoopHousekeeping,
  runOpsCycle,
  runLoopTail,
  createRuntimeAdapters,
  buildRuntimePipelines,
  runMainWithFatalReporting,
} from './control_tower/runtime_helpers.mjs';
import { setupBirdEyeWsGlue, initBirdEyeRuntimeListeners } from './control_tower/ws_runtime_bootstrap.mjs';
import {
  JUP_ROUTE_FIRST_ENABLED,
  JUP_SOURCE_PREFLIGHT_ENABLED,
  NO_PAIR_RETRY_BASE_MS,
  NO_PAIR_RETRY_MAX_BACKOFF_MS,
  NO_PAIR_RETRY_TOTAL_BUDGET_MS,
  NO_PAIR_NON_TRADABLE_TTL_MS,
  NO_PAIR_DEAD_MINT_TTL_MS,
  NO_PAIR_DEAD_MINT_STRIKES,
  effectiveNoPairRetryAttempts,
  mapWithConcurrency,
  jitter,
  quickRouteRecheck,
  ensureNoPairTemporaryState,
  ensureNoPairDeadMintState,
  normalizeCandidateSource,
  bumpNoPairReason,
  bumpRouteCounter,
  recordNonTradableMint,
  getBoostUsd,
  shouldApplyEarlyShortlistPrefilter,
  setNoPairTemporary,
  shouldSkipNoPairTemporary,
  ensureForceAttemptPolicyState,
  parseJupQuoteFailure,
  getRouteQuoteWithFallback,
  classifyNoPairReason,
  isPaperModeActive,
  holdersGateCheck,
} from './control_tower/route_control.mjs';
import {
  ensureWatchlistState,
  pruneRouteCache,
  getFreshRouteCacheEntry,
  cacheRouteReadyMint,
  watchlistEntriesPrioritized,
  evictWatchlist,
} from './control_tower/watchlist_control.mjs';
import {
  positionCount,
  entryCapacityAvailable,
  enforceEntryCapacityGate,
  tokenDisplayName,
  conservativeExitMark,
} from './control_tower/position_policy.mjs';
import cache from './lib/cache/global_cache.mjs';
import birdEyeWs from './providers/birdeye/ws_client.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const wsmgr = require('../../src/services/wsSubscriptionManager.js');
let runtimeStateRef = null;

// Global timer registry for proper cleanup
const globalTimers = createGlobalTimers();

function loadWallet() {
  const sopsPath = String(process.env.SOPS_WALLET_FILE || '').trim();
  if (sopsPath) return loadKeypairFromSopsFile(sopsPath);
  return loadKeypairFromEnv();
}

const getSolUsdPrice = createSolUsdPriceResolver({ getTokenPairs, pickBestPair });

const confirmContinuationGate = createConfirmContinuationGate({ cacheImpl: cache });
const {
  resolveConfirmTxMetricsWithFallback,
  computeMcapUsd,
  runNodeScriptJson,
} = createRuntimeAdapters({
  resolveConfirmTxMetrics,
  snapshotFromBirdseye,
  computeMcapUsdCore,
  getTokenSupply,
  runNodeScriptJsonCore,
  safeErr,
});

setupBirdEyeWsGlue({
  wsmgr,
  birdEyeWs,
  cache,
  snapshotFromBirdseye,
  globalTimers,
});


const {
  upsertWatchlistMint,
  promoteRouteAvailableCandidate,
  evaluateWatchlistRows,
} = createWatchlistPipeline({
  confirmQualityGate,
  confirmContinuationGate,
  recordConfirmCarryTrace,
  resolveConfirmTxMetrics: resolveConfirmTxMetricsWithFallback,
  resolveMintCreatedAtFromRpc,
  computeMcapUsd,
  openPosition,
  wsmgr,
});

const {
  closePosition,
  updateStops,
} = createExitEngine({
  getSolUsdPrice: (...args) => (typeof getSolUsdPrice === 'function' ? getSolUsdPrice(...args) : { solUsd: null }),
});

async function main() {
  const {
    cfg,
    wallet,
    pub,
    conn,
    state,
    birdseye,
    solUsd,
  } = await bootRuntimeContext({
    getConfig,
    summarizeConfigForBoot,
    loadWallet,
    getPublicKeyBase58,
    makeConnection,
    loadState,
    createBirdseyeLiteClient,
    initBirdEyeRuntimeListeners,
    wsmgr,
    birdEyeWs,
    safeErr,
    bindWsManagerExitHandler,
    getSplBalance,
    executeSwap,
    getSolUsdPrice,
    closePosition,
    startWatchlistCleanupTimer,
    globalTimers,
    ensureWatchlistState,
    seedOpenPositionsOnBoot,
    cache,
    announceBootStatus,
    tgSend,
    tgSetMyCommands,
    resolveBootSolUsdWithRetry,
    safeMsg,
    sendBootBalancesMessage,
    getSolBalanceLamports,
    fmtUsd,
    reconcileStartupState,
    reconcilePositions,
    positionCount,
    syncExposureStateWithPositions,
  });

  runtimeStateRef = state;

  const loopState = {
    ...createMainLoopState({ cfg }),
    lastAlivePingCheckAt: 0,
    lastLedgerPruneAt: 0,
    lastReconcileAt: 0,
    lastLowSolAlertAt: 0,
    lastStreamingHealthAt: 0,
    lastRpcAlertRef: { value: 0 },
    lastSolUsd: null,
    lastSolUsdAt: 0,
  };

  // Use persisted diagnostic counters as single source of truth across restarts.
  let counters = initializeDiagCounters({ state });

  bootstrapCompactWindowState({ state, counters, cfg });

  await runJupiterPreflight({
    enabled: JUP_SOURCE_PREFLIGHT_ENABLED,
    state,
    nowIso,
    safeMsg,
    pushDebug,
    parseJupQuoteFailure,
    circuitHit,
    persist: () => saveState(cfg.STATE_PATH, state),
  });


  // Positions enforcement must not be starved by long scan lanes.
  // runPositionsLoop is extracted to positions_loop.mjs; lastPosRef shared across all positions check blocks.
  const lastPosRef = loopState.lastPosRef;
  const { runPositionsLoop, runManualForceClose } = createPositionsLoop({
    cfg, state, cache, conn, wallet, birdseye,
    lastPosRef,
    closePosition, updateStops, tgSend, saveState, pushDebug, nowIso,
    computePreTrailStopPrice, conservativeExitMark, isStopSnapshotUsable,
    tokenDisplayName, getMarketSnapshot, getTokenPairs, pickBestPair, safeErr,
  });
  startPositionsLoopTimer({ globalTimers, cfg, runPositionsLoop, lastPosRef });

  // Diag snapshot machinery extracted to diag_reporting.mjs.
  const {
    refreshDiagSnapshot,
    getDiagSnapshotMessage,
    maybeRefreshDiagSnapshot,
  } = createDiagReporting({
    state,
    getCounters: () => counters,
    cfg,
    birdseye,
    nowIso,
    fmtCt,
  });

  const {
    tgSendChunked,
    sendPositionsReport,
  } = createOpsReporting({
    cfg,
    state,
    conn,
    pub,
    birdseye,
    tgSend,
    getSplBalance,
    tokenDisplayName,
  });

  refreshDiagSnapshot(Date.now());

  // Periodic observability summary (every 5 minutes)
  startObservabilityHeartbeatTimer({
    globalTimers,
    cfg,
    state,
    counters,
    birdseye,
    nowIso,
    pushDebug,
    saveState,
  });

  const {
    processOperatorCommands,
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
    SPEND_CACHE_TTL_MS,
  } = bootstrapOperatorSurfaces({
    cfg,
    state,
    conn,
    pub,
    tgSend,
    tgSendChunked,
    getDiagSnapshotMessage,
    createSpendSummaryCache,
    parseRange,
    readLedger,
    summarize,
    safeErr,
    runNodeScriptJson,
    sendPositionsReport,
    getSolUsdPrice,
    getLoopState: () => ({
      dexCooldownUntil: loopState.dexCooldownUntil,
      lastScan: loopState.lastScan,
      lastSolUsdAt: loopState.lastSolUsdAt,
    }),
    createOperatorSurfaces,
  });

  const runtimeInit = initializeRuntimeState({
    cfg,
    state,
    ensureDexState,
    ensureMarketDataState,
    ensureCircuitState,
    ensureCapitalGuardrailsState,
    ensurePlaybookState,
    ensureForceAttemptPolicyState,
    recordPlaybookRestart,
    getDexCooldownUntilMs,
  });

  loopState.dexCooldownUntil = runtimeInit.dexCooldownUntil;

  // Health endpoint (local only)
  const healthServer = startHealthServer({
    stateRef: state,
    getSnapshot: () => ({
      openPositions: positionCount(state),
      lastScanAtMs: loopState.lastScan || null,
      lastPositionsLoopAtMs: lastPosRef.value || null,
      dexCooldownUntilMs: loopState.dexCooldownUntil || null,
      loopDtMs: loopState.loopDtMs,
    }),
  });

  // Start RPC probe and heartbeat (writes ./state/heartbeat.json and rate-limited alerts)
  startRpcProbeAndHeartbeat({ cfg, state, conn, pub, tgSend });

  // Graceful shutdown: persist state and close the local health listener so PM2 reloads
  // don't leave stale state or lingering sockets.
  let streamingProvider = null;
  registerGracefulShutdown({
    cfg,
    state,
    globalTimers,
    clearAllTimers,
    saveState,
    birdEyeWs,
    healthServer,
    getStreamingProvider: () => streamingProvider,
  });

  // Candidate source feed caches are owned by createCandidatePipeline below.

  // Initialize TimescaleDB for historical data persistence
  initializeTimescaleDbIfEnabled();

  const streamingBoot = bootstrapStreamingCandidateSources({
    cfg,
    state,
    birdseye,
    tgSend,
    saveState,
    createStreamingProvider,
    createCandidatePipeline,
  });
  streamingProvider = streamingBoot.streamingProvider;
  loopState.lastStreamingHealthAt = streamingBoot.lastStreamingHealthAt;
  const fetchCandidateSources = streamingBoot.fetchCandidateSources;

  const { runScanPipeline, runEntryDispatch } = buildRuntimePipelines({
    createScanPipeline,
    createEntryDispatch,
    scanPipelineArgs: {
      cfg,
      state,
      tgSend,
      nowIso,
      pushDebug,
      saveState,
      jupCooldownRemainingMs,
      ensureNoPairTemporaryState,
      ensureNoPairDeadMintState,
      normalizeCandidateSource,
      bumpSourceCounter,
      bumpRouteCounter,
      bumpNoPairReason,
      recordNonTradableMint,
      shouldSkipNoPairTemporary,
      setNoPairTemporary,
      getCachedPairSnapshot,
      shouldApplyEarlyShortlistPrefilter,
      getBoostUsd,
      logCandidateDaily,
      getFreshRouteCacheEntry,
      cacheRouteReadyMint,
      toBaseUnits,
      DECIMALS,
      getRouteQuoteWithFallback,
      quickRouteRecheck,
      circuitHit,
      hitJup429,
      JUP_ROUTE_FIRST_ENABLED,
      JUP_SOURCE_PREFLIGHT_ENABLED,
      getMarketSnapshot,
      getTokenPairs,
      pickBestPair,
      birdseye,
      mapWithConcurrency,
      effectiveNoPairRetryAttempts,
      NO_PAIR_RETRY_TOTAL_BUDGET_MS,
      NO_PAIR_RETRY_BASE_MS,
      NO_PAIR_RETRY_MAX_BACKOFF_MS,
      jitter,
      parseJupQuoteFailure,
      isJup429,
      isDexScreener429,
      promoteRouteAvailableCandidate,
      classifyNoPairReason,
      NO_PAIR_DEAD_MINT_STRIKES,
      NO_PAIR_DEAD_MINT_TTL_MS,
      NO_PAIR_NON_TRADABLE_TTL_MS,
      getSnapshotStatus,
      trackerMaybeEnqueue,
      circuitOkForEntries,
      entryCapacityAvailable,
      isPaperModeActive,
      PLAYBOOK_MODE_DEGRADED,
    },
    entryDispatchArgs: {
      cfg,
      state,
      upsertWatchlistMint,
      evictWatchlist,
      evaluateWatchlistRows,
      pushDebug,
      nowIso,
      saveState,
      conn,
      pub,
      wallet,
      birdseye,
      normalizeCandidateSource,
      bumpSourceCounter,
      entryCapacityAvailable,
      bump,
      logCandidateDaily,
      getEntrySnapshotUnsafeReason,
      markMarketDataRejectImpact,
      holdersGateCheck,
      passesBaseFilters,
      getRugcheckReport,
      isTokenSafe,
      computeMcapUsd,
      evaluateMomentumSignal,
      canUseMomentumFallback,
      toBaseUnits,
      DECIMALS,
      getRouteQuoteWithFallback,
      getModels,
      preprocessCandidate,
      appendCost,
      estimateCostUsd,
      analyzeTrade,
      jupQuote,
      gatekeep,
      canOpenNewEntry,
      applySoftReserveToUsdTarget,
      confirmQualityGate,
      ensureWatchlistState,
      bumpWatchlistFunnel,
      enforceEntryCapacityGate,
      openPosition,
      didEntryFill,
      recordEntryOpened,
      safeMsg,
      recordPlaybookError,
      isPaperModeActive,
    },
  });

  while (true) {
    const t = Date.now();
    rollWatchlistMinuteWindow(counters, t);

    loopState.loopDtMs = t - loopState.loopPrevAtMs;
    loopState.loopPrevAtMs = t;

    maybeRefreshDiagSnapshot(t);

    const housekeeping = await runLoopHousekeeping({
      t,
      cfg,
      state,
      conn,
      wallet,
      lastExposureQueueDrainAt: loopState.lastExposureQueueDrainAt,
      lastStreamingHealthAt: loopState.lastStreamingHealthAt,
      spendSummaryCache,
      SPEND_CACHE_TTL_MS,
      refreshSpendSummaryCacheAsync,
      streamingProvider,
      syncExposureStateWithPositions,
      processExposureQueue,
      safeErr,
    });
    loopState.lastExposureQueueDrainAt = housekeeping.lastExposureQueueDrainAt;
    loopState.lastStreamingHealthAt = housekeeping.lastStreamingHealthAt;

    const opsCycle = await runOpsCycle({
      t,
      cfg,
      state,
      lastHb: loopState.lastHb,
      lastAlivePingCheckAt: loopState.lastAlivePingCheckAt,
      evaluatePlaybook,
      circuitOkForEntries,
      runSelfRecovery,
      tgSend,
      saveState,
      positionCount,
      maybeAlivePing,
    });
    loopState.lastHb = opsCycle.lastHb;
    loopState.lastAlivePingCheckAt = opsCycle.lastAlivePingCheckAt;

    // Manual force-close latch (handled early so scan-lane continues can't starve it).
    await runManualForceClose(t);

    // Check positions for exits (run early so scan-lane continues can't starve exits)
    if (t - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
      await runPositionsLoop(t);
    }

    const maintenance = await runMaintenanceChores({
      t,
      cfg,
      state,
      conn,
      pub,
      counters,
      lastLedgerPruneAt: loopState.lastLedgerPruneAt,
      lastReconcileAt: loopState.lastReconcileAt,
      lastAutoTune: loopState.lastAutoTune,
      lastHourlyDiag: loopState.lastHourlyDiag,
      nowIso,
      saveState,
      tgSend,
      positionCount,
      getTokenHoldingsByMint,
      getSplBalance,
      applyOnchainBalanceToPosition,
      maybeRotateBySize,
      maybePruneJsonlByAge,
      getDiagEventsPath,
      autoTuneFilters,
      snapshotAndReset,
      formatThroughputSummary,
      formatMarketDataProviderSummary,
    });
    loopState.lastLedgerPruneAt = maintenance.lastLedgerPruneAt;
    loopState.lastReconcileAt = maintenance.lastReconcileAt;
    loopState.lastAutoTune = maintenance.lastAutoTune;
    loopState.lastHourlyDiag = maintenance.lastHourlyDiag;
    counters = maintenance.counters;

    const tgPoll = await pollTelegramControls({
      t,
      cfg,
      state,
      counters,
      lastTgPoll: loopState.lastTgPoll,
      handleTelegramControls,
      tgSend,
      nowIso,
      getDiagSnapshotMessage,
      tgSendChunked,
      sendPositionsReport,
      safeErr,
    });
    loopState.lastTgPoll = tgPoll.lastTgPoll;

    // Forward tracking tick ("what would have happened")
    try {
      await trackerTick({ cfg, state, send: tgSend, nowIso, conn, wallet, solUsd: loopState.lastSolUsd || solUsd || null, birdseye });
    } catch {}

    const watchlistEval = await runWatchlistTriggerLane({
      t,
      cfg,
      state,
      counters,
      conn,
      pub,
      wallet,
      birdseye,
      lastWatchlistEval: loopState.lastWatchlistEval,
      lastSolUsd: loopState.lastSolUsd,
      lastSolUsdAt: loopState.lastSolUsdAt,
      solUsdFallback: solUsd,
      ensureWatchlistState,
      evictWatchlist,
      pruneRouteCache,
      circuitOkForEntries,
      entryCapacityAvailable,
      isPaperModeActive,
      watchlistEntriesPrioritized,
      getSolUsdPrice,
      evaluateWatchlistRows,
    });
    loopState.lastWatchlistEval = watchlistEval.lastWatchlistEval;
    loopState.lastSolUsd = watchlistEval.lastSolUsd;
    loopState.lastSolUsdAt = watchlistEval.lastSolUsdAt;

    const rejectionSummary = await runRejectionSummary({
      t,
      cfg,
      state,
      counters,
      lastRej: loopState.lastRej,
      snapshotAndReset,
      tgSend,
    });
    loopState.lastRej = rejectionSummary.lastRej;
    counters = rejectionSummary.counters;

    const risk = await runPortfolioRiskCycle({
      t,
      cfg,
      conn,
      pub,
      state,
      nowIso,
      tgSend,
      shouldStopPortfolio,
      circuitClear,
      circuitHit,
      recordPlaybookError,
      saveState,
      safeErr,
      lastRpcAlertRef: loopState.lastRpcAlertRef,
      getSolUsdPrice,
    });
    if (risk.halted) continue;

    const scan = await runScanCycle({
      t,
      cfg,
      state,
      conn,
      pub,
      counters,
      lastScan: loopState.lastScan,
      nextScanDelayMs: loopState.nextScanDelayMs,
      lastSolUsd: loopState.lastSolUsd,
      lastSolUsdAt: loopState.lastSolUsdAt,
      lastLowSolAlertAt: loopState.lastLowSolAlertAt,
      dexCooldownUntil: loopState.dexCooldownUntil,
      birdseye,
      nowIso,
      tgSend,
      appendJsonl,
      appendDiagEvent,
      saveState,
      safeMsg,
      pushDebug,
      bump,
      getSolUsdPrice,
      getSolBalanceLamports,
      hitDex429,
      computeAdaptiveScanDelayMs,
      createScanCompactEventPusher,
      createScanCycleState,
      fetchCandidateSources,
      runScanPipeline,
      runEntryDispatch,
      sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    loopState.lastScan = scan.lastScan;
    loopState.nextScanDelayMs = scan.nextScanDelayMs;
    loopState.lastSolUsd = scan.lastSolUsd;
    loopState.lastSolUsdAt = scan.lastSolUsdAt;
    loopState.lastLowSolAlertAt = scan.lastLowSolAlertAt;
    loopState.dexCooldownUntil = scan.dexCooldownUntil;
    counters = scan.counters;
    if (scan.continueLoop) continue;

    await runLoopTail({
      t,
      cfg,
      lastPosRef,
      runPositionsLoop,
      processOperatorCommands,
    });
  }
}

runMainWithFatalReporting({
  main,
  getConfig,
  safeErr,
  tgSend,
});
startMemoryMonitors({
  globalTimers,
  getRuntimeStateRef: () => runtimeStateRef,
  wsmgr,
  birdEyeWs,
  safeErr,
});
