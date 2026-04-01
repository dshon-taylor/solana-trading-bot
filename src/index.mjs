import 'dotenv/config';

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
import { shouldStopPortfolio, reconcilePositions, syncExposureStateWithPositions, enforcePortfolioStopGate } from './control_tower/portfolio_control.mjs';
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
import { createScanPipeline, createScanCycleState } from './control_tower/scan_pipeline.mjs';
import { createEntryDispatch, bindWsManagerExitHandler } from './control_tower/entry_dispatch/index.mjs';
import { announceBootStatus, seedOpenPositionsOnBoot, resolveBootSolUsdWithRetry, sendBootBalancesMessage, reconcileStartupState } from './control_tower/startup.mjs';
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

const resolveConfirmTxMetricsWithFallback = (args) => resolveConfirmTxMetrics({
  ...args,
  snapshotFromBirdseye,
});

const computeMcapUsd = (cfg, pair, rpcUrl) => computeMcapUsdCore(cfg, pair, rpcUrl, { getTokenSupply });

const runNodeScriptJson = (scriptPath, args, timeoutMs = 90_000) => runNodeScriptJsonCore(scriptPath, args, { timeoutMs, safeErr });

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
  const cfg = getConfig();
  console.log(summarizeConfigForBoot(cfg));

  const wallet = loadWallet();
  const pub = getPublicKeyBase58(wallet);

  const conn = makeConnection(cfg.SOLANA_RPC_URL);
  const state = loadState(cfg.STATE_PATH);
  runtimeStateRef = state;
  const birdseye = createBirdseyeLiteClient({
    enabled: cfg.BIRDEYE_LITE_ENABLED,
    apiKey: cfg.BIRDEYE_API_KEY,
    chain: cfg.BIRDEYE_LITE_CHAIN,
    maxRps: cfg.BIRDEYE_LITE_MAX_RPS,
    cacheTtlMs: cfg.BIRDEYE_LITE_CACHE_TTL_MS,
    perMintMinIntervalMs: cfg.BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS,
  });

  // BirdEye websocket (real-time updates) + dynamic subscriptions from cache birdeye:sub:<mint>
  try {
    initBirdEyeRuntimeListeners({ state, wsmgr, birdEyeWs, safeErr });
    birdEyeWs.start();
  } catch (e) {
    console.warn('[birdeye-ws] start failed', safeErr(e).message);
  }

  bindWsManagerExitHandler({
    wsmgr,
    state,
    cfg,
    conn,
    wallet,
    getSplBalance,
    executeSwap,
    getSolUsdPrice,
    closePosition,
    safeErr,
  });

  // detect stale live mints and trigger restResync once-per-incident
  startWatchlistCleanupTimer({ globalTimers, cfg, wsmgr });

  state.positions ||= {};
  state.portfolio ||= { maxEquityUsd: cfg.STARTING_CAPITAL_USDC };
  state.paperAttempts ||= [];
  state.runtime ||= {};
  state.runtime.botStartTimeMs = Date.now();
  ensureWatchlistState(state);

  await seedOpenPositionsOnBoot({
    state,
    cfg,
    wsmgr,
    cache,
    birdseye,
    closePosition,
    conn,
    wallet,
  });

  await announceBootStatus({
    cfg,
    pub,
    tgSend,
    tgSetMyCommands,
  });

  const solUsd = await resolveBootSolUsdWithRetry({
    getSolUsdPrice,
    tgSend,
    cfg,
    safeMsg,
  });

  await sendBootBalancesMessage({
    cfg,
    conn,
    pub,
    solUsd,
    getSolBalanceLamports,
    tgSend,
    fmtUsd,
  });

  await reconcileStartupState({
    cfg,
    conn,
    pub,
    state,
    reconcilePositions,
    positionCount,
    syncExposureStateWithPositions,
    safeErr,
  });

  let {
    lastScan,
    nextScanDelayMs,
    lastPosRef,
    lastHb,
    lastRej,
    lastTgPoll,
    lastAutoTune,
    lastHourlyDiag,
    lastWatchlistEval,
    lastExposureQueueDrainAt,
    loopPrevAtMs: _loopPrevAtMs,
    loopDtMs: _loopDtMs,
  } = createMainLoopState({ cfg });

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
    getLoopState: () => ({ dexCooldownUntil, lastScan, lastSolUsdAt }),
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

  let dexCooldownUntil = runtimeInit.dexCooldownUntil;
  let lastSolUsd = null;
  let lastSolUsdAt = 0;

  // Ops hygiene timers
  let lastAlivePingCheckAt = 0;
  let lastLedgerPruneAt = 0;

  // Health endpoint (local only)
  const healthServer = startHealthServer({
    stateRef: state,
    getSnapshot: () => ({
      openPositions: positionCount(state),
      lastScanAtMs: lastScan || null,
      lastPositionsLoopAtMs: lastPosRef.value || null,
      dexCooldownUntilMs: dexCooldownUntil || null,
      loopDtMs: _loopDtMs,
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

  const lastRpcAlertRef = { value: 0 };
  let lastLowSolAlertAt = 0;
  let lastReconcileAt = 0;

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
  let lastStreamingHealthAt = streamingBoot.lastStreamingHealthAt;
  const fetchCandidateSources = streamingBoot.fetchCandidateSources;

  const { runScanPipeline } = createScanPipeline({
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
  });

  const { runEntryDispatch } = createEntryDispatch({
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
  });

  while (true) {
    const t = Date.now();
    rollWatchlistMinuteWindow(counters, t);

    _loopDtMs = t - _loopPrevAtMs;
    _loopPrevAtMs = t;

    maybeRefreshDiagSnapshot(t);

    if ((t - lastExposureQueueDrainAt) >= Math.max(2_000, Number(process.env.EXPOSURE_QUEUE_EVERY_MS || 7_500))) {
      lastExposureQueueDrainAt = t;
      try {
        syncExposureStateWithPositions({ cfg, state });
        if (Array.isArray(state.exposure?.queue) && state.exposure.queue.length > 0) {
          await processExposureQueue(cfg, conn, wallet, state);
        }
      } catch (e) {
        console.warn('[exposure] periodic queue drain failed', safeErr(e).message);
      }
    }

    if (!spendSummaryCache.inFlight && (t - Number(spendSummaryCache.loadedAtMs || 0) >= SPEND_CACHE_TTL_MS)) {
      refreshSpendSummaryCacheAsync();
    }

    if (t - lastStreamingHealthAt > 60_000) {
      lastStreamingHealthAt = t;
      state.streaming ||= {};
      state.streaming.health = streamingProvider?.getHealth?.(t) || null;
      state.streaming.metrics = streamingProvider?.getMetrics?.() || null;
    }

    // Incident playbook: degraded-mode transitions + autonomous reopen when stable.
    if (cfg.PLAYBOOK_ENABLED) {
      const pb = evaluatePlaybook({
        state,
        cfg,
        nowMs: t,
        circuitOpen: !circuitOkForEntries({ state, nowMs: t }),
      });

      if (pb.transition === 'enter_degraded') {
        state.tradingEnabled = false;
        state.flags ||= {};
        state.flags.playbookDegraded = true;

        // Self-recovery: clear transient backoffs so we can re-test health quickly.
        state.marketDataReliability = { dex: { failures: 0, backoffUntilMs: 0 } };
        state.dexCooldown = { level: 0, cooldownUntilMs: 0, lastHitMs: 0, reason: null };
        runSelfRecovery({ state, nowMs: t, note: 'reset_backoffs_and_pause_entries' });

        await tgSend(cfg, `🚧 Playbook degraded mode ON (${pb.reason}). Entries paused; running self-recovery.`);
        console.warn(`[playbook] enter_degraded reason=${pb.reason} restarts=${pb.recentRestarts} errors=${pb.recentErrors}`);
        saveState(cfg.STATE_PATH, state);
      } else if (pb.transition === 'exit_degraded') {
        state.tradingEnabled = cfg.EXECUTION_ENABLED && cfg.FORCE_TRADING_ENABLED;
        state.flags ||= {};
        state.flags.playbookDegraded = false;
        await tgSend(cfg, '✅ Playbook recovered to normal mode. Re-opening execution gate.');
        console.warn(`[playbook] exit_degraded reason=${pb.reason}`);
        saveState(cfg.STATE_PATH, state);
      }
    }

    // Heartbeat
    if (t - lastHb >= cfg.HEARTBEAT_EVERY_MS) {
      lastHb = t;
      const pc = positionCount(state);
      console.log(`[hb] ${new Date(t).toISOString()} open_positions=${pc}`);
      saveState(cfg.STATE_PATH, state);
    }

    // Daily alive ping (optional; requires ALIVE_PING_URL). Best-effort + rate-limited.
    if (t - lastAlivePingCheckAt > 60_000) {
      lastAlivePingCheckAt = t;
      try {
        await maybeAlivePing({
          cfg,
          state,
          nowMs: t,
          reason: `open_positions=${positionCount(state)}`,
          persist: () => saveState(cfg.STATE_PATH, state),
        });
      } catch {}
    }

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
      lastLedgerPruneAt,
      lastReconcileAt,
      lastAutoTune,
      lastHourlyDiag,
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
    lastLedgerPruneAt = maintenance.lastLedgerPruneAt;
    lastReconcileAt = maintenance.lastReconcileAt;
    lastAutoTune = maintenance.lastAutoTune;
    lastHourlyDiag = maintenance.lastHourlyDiag;
    counters = maintenance.counters;

    const tgPoll = await pollTelegramControls({
      t,
      cfg,
      state,
      counters,
      lastTgPoll,
      handleTelegramControls,
      tgSend,
      nowIso,
      getDiagSnapshotMessage,
      tgSendChunked,
      sendPositionsReport,
      safeErr,
    });
    lastTgPoll = tgPoll.lastTgPoll;

    // Forward tracking tick ("what would have happened")
    try {
      await trackerTick({ cfg, state, send: tgSend, nowIso, conn, wallet, solUsd: lastSolUsd || solUsd || null, birdseye });
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
      lastWatchlistEval,
      lastSolUsd,
      lastSolUsdAt,
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
    lastWatchlistEval = watchlistEval.lastWatchlistEval;
    lastSolUsd = watchlistEval.lastSolUsd;
    lastSolUsdAt = watchlistEval.lastSolUsdAt;

    const rejectionSummary = await runRejectionSummary({
      t,
      cfg,
      state,
      counters,
      lastRej,
      snapshotAndReset,
      tgSend,
    });
    lastRej = rejectionSummary.lastRej;
    counters = rejectionSummary.counters;

    // SOLUSD refresh periodically
    let solPrice;
    try {
      solPrice = (await getSolUsdPrice()).solUsd;
    } catch {
      solPrice = null;
    }

    // Portfolio stop checks (RPC can be flaky; never crash on transient failure)
    const portfolioGate = await enforcePortfolioStopGate({
      cfg,
      conn,
      pub,
      state,
      solPrice,
      nowMs: t,
      nowIso,
      tgSend,
      shouldStopPortfolio,
      circuitClear,
      circuitHit,
      recordPlaybookError,
      saveState,
      safeErr,
      lastRpcAlertRef,
    });
    if (portfolioGate.halted) continue;

    // Scan for entries
    if (t - lastScan >= nextScanDelayMs) {
      lastScan = t;
      counters.scanCycles += 1;
      const scanCycleStartedAtMs = Date.now();
      const prevScanAtMs = Number(counters.scanLastAtMs || 0);
      const scanIntervalMs = prevScanAtMs > 0 ? Math.max(0, t - prevScanAtMs) : null;
      counters.scanLastAtMs = t;
      const scanWatchlistIngestStart = Number(counters?.watchlist?.ingested || 0);
      const scanPairFetchStart = Number(counters?.pairFetch?.started || 0);
      const scanRateLimitedStart = Number(counters?.pairFetch?.rateLimited || 0) + Number(counters?.reject?.noPairReasons?.rateLimited || 0);
      const scanBirdeyeReqStart = Number(state?.marketData?.providers?.birdeye?.requests || 0);
      const scanCycle = createScanCycleState({
        cfg,
        counters,
        state,
        scanWatchlistIngestStart,
        scanPairFetchStart,
        scanBirdeyeReqStart,
      });
      const scanPhase = scanCycle.scanPhase;
      nextScanDelayMs = computeAdaptiveScanDelayMs({
        state,
        nowMs: t,
        baseScanMs: cfg.SCAN_EVERY_MS,
        maxScanMs: cfg.SCAN_BACKOFF_MAX_MS,
      });

      const pushScanCompactEvent = createScanCompactEventPusher({
        counters,
        cfg,
        appendJsonl,
      });

      try {
      // BirdEye CU guard: if projected CU budget exceeded, slow scan cadence
      try {
        if (birdseye && typeof birdseye.getStats === 'function') {
          const bs = birdseye.getStats(t) || {};
          if (bs.cuGuardEnabled && bs.cuBudgetExceeded) {
            const oldDelay = nextScanDelayMs;
            nextScanDelayMs = Math.min(cfg.SCAN_BACKOFF_MAX_MS || (5 * 60_000), Math.max(nextScanDelayMs * 2, nextScanDelayMs + cfg.SCAN_EVERY_MS));
            pushDebug(state, { t: nowIso(), reason: 'birdeye_cu_guard', oldDelay, newDelay: nextScanDelayMs });
            console.warn(`[scan] BirdEye CU budget exceeded -> slowing scans ${oldDelay}ms -> ${nextScanDelayMs}ms (projectedDailyCu=${bs.projectedDailyCu})`);
          }
        }
      } catch {
        // ignore getStats errors
      }

      if (!cfg.DATA_CAPTURE_ENABLED) {
        // Data capture disabled explicitly.
      } else if (!cfg.SCANNER_TRACKING_ENABLED && !cfg.SCANNER_ENTRIES_ENABLED) {
        // Scanner fully disabled.
      } else {
        // If DexScreener is rate-limiting, cool down instead of hammering.
        if (t < dexCooldownUntil) {
          await new Promise(r => setTimeout(r, 250));
          continue;
        }

        // SOLUSD: cache for a few minutes to reduce DexScreener calls.
        let solUsdNow;
        const SOLUSD_TTL_MS = 5 * 60_000;
        if (lastSolUsd && (t - lastSolUsdAt) < SOLUSD_TTL_MS) {
          solUsdNow = lastSolUsd;
        } else {
          try {
            const _tSol = Date.now();
            solUsdNow = (await getSolUsdPrice()).solUsd;
            scanCycle.markCallDuration(_tSol);
            lastSolUsd = solUsdNow;
            lastSolUsdAt = t;
          } catch (e) {
            // DexScreener can rate-limit; use cached value if we have it.
            pushDebug(state, { t: nowIso(), mint: 'SOL', symbol: 'SOL', reason: `solUsdFetch(${safeMsg(e)})` });
            if (lastSolUsd) {
              solUsdNow = lastSolUsd;
              await tgSend(cfg, '⚠️ SOLUSD fetch rate-limited. Using cached SOLUSD and continuing.');
            } else {
              await tgSend(cfg, '⚠️ SOLUSD fetch failed (DexScreener rate limit). Cooling down before retry.');
              const { cooldownUntilMs } = hitDex429({
                state,
                nowMs: t,
                baseMs: 2 * 60_000,
                reason: 'solUsdFetch(DEXSCREENER_429?)',
                persist: () => saveState(cfg.STATE_PATH, state),
              });
              dexCooldownUntil = cooldownUntilMs;
              continue;
            }
          }
        }

        // Ensure we keep some SOL for fees
        const _tBal = Date.now();
        scanCycle.scanRpcCalls += 1;
        const solLam = await getSolBalanceLamports(conn, pub);
        scanCycle.markCallDuration(_tBal, 'rpc');
        const sol = solLam / 1e9;
        state.flags ||= {};
        if (sol < cfg.MIN_SOL_FOR_FEES) {
          state.flags.lowSolPauseEntries = true;
          bump(counters, 'reject.lowSolFees');
          // Rate-limit low-SOL pause alerts (avoid spam)
          if (t - lastLowSolAlertAt > 30 * 60_000) {
            lastLowSolAlertAt = t;
            await tgSend(cfg, `⚠️ Low SOL balance for fees: ${sol.toFixed(4)} SOL (< ${cfg.MIN_SOL_FOR_FEES.toFixed(4)} SOL reserve). Pausing new entries until balance recovers.`);
          }
        } else {
          if (state.flags.lowSolPauseEntries) {
            state.flags.lowSolPauseEntries = false;
            await tgSend(cfg, `✅ SOL fee reserve recovered (${sol.toFixed(4)} SOL). New entries resumed.`);
          }
          // Candidate source ingestion extracted to candidate_pipeline.mjs
          const {
            boostedRaw,
            boosted,
            newDexCooldownUntil,
          } = await fetchCandidateSources({ t, scanPhase, solUsdNow, counters });
          if (newDexCooldownUntil != null) dexCooldownUntil = newDexCooldownUntil;


          const scanPipelineResult = await runScanPipeline({
            t,
            solUsdNow,
            boostedRaw,
            boosted,
            counters,
            scanPhase,
            scanRateLimitedStart,
            scanState: {
              scanCandidatesFound: scanCycle.scanCandidatesFound,
              scanPairFetchConcurrency: scanCycle.scanPairFetchConcurrency,
              scanJupCooldownActive: scanCycle.scanJupCooldownActive,
              scanJupCooldownRemainingMs: scanCycle.scanJupCooldownRemainingMs,
              scanRoutePrefilterDegraded: scanCycle.scanRoutePrefilterDegraded,
              scanUsableSnapshotWithoutPairCount: scanCycle.scanUsableSnapshotWithoutPairCount,
              scanNoPairTempActiveCount: scanCycle.scanNoPairTempActiveCount,
              scanNoPairTempRevisitCount: scanCycle.scanNoPairTempRevisitCount,
            },
            pushScanCompactEvent,
          });

          if (scanPipelineResult?.scanState) {
            scanCycle.applyScanState(scanPipelineResult.scanState);
          }

          if (scanPipelineResult?.skipCycle) {
            continue;
          }

          const {
            probeEnabled,
            probeShortlist,
            executionAllowed,
            executionAllowedReason,
            routeAvailableImmediateRows,
          } = scanPipelineResult;

          const entryDispatchResult = await runEntryDispatch({
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
          });
          if (entryDispatchResult?.continueCycle) continue;
        }
      }
      } finally {
        scanCycle.finalize({
          scanCycleStartedAtMs,
          scanIntervalMs,
          nextScanDelayMs,
          appendDiagEvent,
          appendJsonl,
        });
      }
    }

    await processOperatorCommands(t);

    // Re-check positions after operator commands when due.
    if (t - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
      await runPositionsLoop(t);
    }

    await new Promise(r => setTimeout(r, 250));
  }
}

main().catch(async (e) => {
  const cfg = (() => {
    try { return getConfig(); } catch { return null; }
  })();
  console.error('[fatal]', safeErr(e));
  if (cfg) await tgSend(cfg, `❌ Bot crashed: ${safeErr(e).message}`);
  process.exit(1);
});
startMemoryMonitors({
  globalTimers,
  getRuntimeStateRef: () => runtimeStateRef,
  wsmgr,
  birdEyeWs,
  safeErr,
});
