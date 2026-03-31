import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PublicKey } from '@solana/web3.js';

import { getConfig, summarizeConfigForBoot } from './config.mjs';
import { applyOnchainBalanceToPosition } from './reconcile_positions.mjs';
import { loadKeypairFromEnv, loadKeypairFromSopsFile, getPublicKeyBase58 } from './wallet.mjs';
import { makeConnection, getSolBalanceLamports, getSplBalance, getTokenHoldingsByMint } from './portfolio.mjs';
import { getBoostedTokens, getTokenPairs, pickBestPair } from './dexscreener.mjs';
import { getRugcheckReport, isTokenSafe, getConcentrationMetrics } from './rugcheck.mjs';
import { getTokenSupply } from './helius.mjs';
import { passesBaseFilters, evaluateMomentumSignal, canUseMomentumFallback } from './strategy.mjs';
import { paperComputeMomentumWindows } from './paper_momentum.mjs';
import { executeSwap, toBaseUnits, DECIMALS } from './trader.mjs';
import { appendTradingLog, nowIso, safeErr } from './logger.mjs';
import { loadState, saveState } from './state.mjs';
import { tgSend, tgSetMyCommands } from './telegram.mjs';
import { makeCounters, bump, bumpSourceCounter, snapshotAndReset, formatThroughputSummary, bumpWatchlistFunnel, rollWatchlistMinuteWindow } from './metrics.mjs';
import { handleTelegramControls } from './telegram_control.mjs';
import { trackerMaybeEnqueue, trackerTick, formatTrackerIngestionSummary, formatTrackerSamplingBreakdown } from './tracker.mjs';
import { pushDebug, getLastDebug } from './debug_buffer.mjs';
import { safeMsg } from './ai.mjs';
import { getModels, preprocessCandidate, analyzeTrade, gatekeep } from './ai_pipeline.mjs';
import { appendCost, estimateCostUsd, parseRange, readLedger, summarize } from './cost.mjs';
import { jupQuote } from './jupiter.mjs';
import { autoTuneFilters } from './autotune.mjs';
import { logCandidateDaily, appendJsonl } from './candidates_ledger.mjs';
import { fetchJupTokenList } from './jup_tokenlist.mjs';
import { ensureDexState, getDexCooldownUntilMs, hitDex429, isDexScreener429 } from './dex_cooldown.mjs';
import { ensureMarketDataState, computeAdaptiveScanDelayMs, getCachedPairSnapshot } from './market_data_reliability.mjs';
import { getMarketSnapshot, getEntrySnapshotUnsafeReason, isEntrySnapshotSafe, isStopSnapshotUsable, getWatchlistEntrySnapshotUnsafeReason, getSnapshotStatus, snapshotFromBirdseye, formatMarketDataProviderSummary, markMarketDataRejectImpact } from './market_data_router.mjs';
import { hitJup429, isJup429, jupCooldownRemainingMs } from './jup_cooldown.mjs';
import { maybeAlivePing } from './alive_ping.mjs';
import { ensureCircuitState, circuitOkForEntries, circuitHit, circuitClear } from './circuit_breaker.mjs';
import { maybePruneJsonlByAge, maybeRotateBySize } from './ledger_retention.mjs';
import { ensureCapitalGuardrailsState, canOpenNewEntry, recordEntryOpened, applySoftReserveToUsdTarget } from './capital_guardrails.mjs';
import { ensurePlaybookState, recordPlaybookRestart, recordPlaybookError, evaluatePlaybook, runSelfRecovery, PLAYBOOK_MODE_DEGRADED } from './incident_playbook.mjs';
import { createStreamingProvider } from './streaming_provider.mjs';
import { createBirdseyeLiteClient } from './birdeye_lite.mjs';
import { didEntryFill } from './entry_reliability.mjs';
import createWatchlistPipeline from './control_tower/watchlist_pipeline.mjs';
import { openPosition, processExposureQueue } from './control_tower/entry_engine.mjs';
import createExitEngine from './control_tower/exit_engine.mjs';
import { estimateEquityUsd, shouldStopPortfolio, reconcilePositions, syncExposureStateWithPositions } from './control_tower/portfolio_control.mjs';
import { createOpsReporting, createSpendSummaryCache, fmtUsd } from './control_tower/ops_reporting.mjs';
import { startWatchlistCleanupTimer, startObservabilityHeartbeatTimer, startPositionsLoopTimer } from './control_tower/runtime_timers.mjs';
import { createPositionsLoop } from './control_tower/positions_loop.mjs';
import { createDiagReporting } from './control_tower/diag_reporting.mjs';
import { createCandidatePipeline } from './control_tower/candidate_pipeline.mjs';
import { createOperatorSurfaces } from './control_tower/operator_surfaces.mjs';
import { createScanPipeline } from './control_tower/scan_pipeline/index.mjs';
import { confirmContinuationGate as runConfirmContinuationGate } from './lib/confirm_continuation.mjs';
import { isMicroFreshEnough, applyMomentumPassHysteresis, getCachedMintCreatedAt, scheduleMintCreatedAtLookup } from './lib/momentum_gate_controls.mjs';
import { computePreTrailStopPrice } from './lib/stop_policy.mjs';
import { resolveConfirmTxMetricsFromDiagEvent } from './diag_event_invariants.mjs';
import { CORE_MOMO_CHECKS, canaryMomoShouldSample, recordCanaryMomoFailChecks, coreMomentumProgress, decideMomentumBranch, normalizeEpochMs, pickEpochMsWithSource, applySnapshotToLatest, buildNormalizedMomentumInput, pruneMomentumRepeatFailMap } from './watchlist_eval_helpers.mjs';
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
  pruneForceAttemptPolicyWindows,
  evaluateForceAttemptPolicyGuards,
  recordForceAttemptPolicyAttempt,
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
  resolveWatchlistRouteMeta,
  readPct,
  queueHotWatchlistMint,
  watchlistEntriesPrioritized,
  resolvePairCreatedAtGlobal,
  evictWatchlist,
  formatWatchlistSummary,
  bumpImmediateBlockedReason,
} from './control_tower/watchlist_control.mjs';
import {
  positionCount,
  entryCapacityAvailable,
  enforceEntryCapacityGate,
  cleanTokenText,
  tokenDisplayName,
  tokenDisplayWithSymbol,
  conservativeExitMark,
} from './control_tower/position_policy.mjs';
import cache from './global_cache.mjs';
import birdEyeWs from './providers/birdeye_ws.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const wsmgr = require('../../src/services/wsSubscriptionManager.js');
let runtimeStateRef = null;

// Global timer registry for proper cleanup
const globalTimers = {
  birdeyeWsPoll: null,
  scanLoop: null,
  positionsLoop: null,
  heartbeatLoop: null,
  telegramPoll: null,
  watchlistCleanup: null,
};

function clearAllTimers() {
  for (const [name, timer] of Object.entries(globalTimers)) {
    if (timer) {
      clearInterval(timer);
      globalTimers[name] = null;
    }
  }
}
// bind clients/listeners exactly once (prevents duplicate handlers on reconnect/restart cycles)
if (!globalThis.__WSMGR_BOUND__) {
  wsmgr.bindClients({ wsClient: birdEyeWs, restClient: { fetchSnapshot: snapshotFromBirdseye } });
  globalThis.__WSMGR_BOUND__ = true;
}

if (!globalThis.__BIRDEYE_PRICE_HANDLER_BOUND__) {
  try {
    // Primary event handler - processes WS price events instantly (no polling)
    birdEyeWs.on?.('price', ({ mint, price, ts, volume }) => {
      try { 
        wsmgr.onWsEvent(mint, { 
          price: Number(price), 
          ts: Number(ts) || Date.now(), 
          volume 
        }); 
      } catch {}
    });
    
    // Fallback: poll cache only if WS events aren't flowing
    // This provides redundancy if event emitter has issues
    const FALLBACK_POLL_MS = Math.max(5000, Number(process.env.BIRDEYE_WS_FALLBACK_POLL_MS || 10000));
    let lastEventTime = Date.now();
    
    // Track event flow
    const originalOnWsEvent = wsmgr.onWsEvent;
    wsmgr.onWsEvent = function(...args) {
      lastEventTime = Date.now();
      return originalOnWsEvent.apply(this, args);
    };
    
    // Fallback polling (only if events stopped)
    if (!globalTimers.birdeyeWsPoll) {
      globalTimers.birdeyeWsPoll = setInterval(() => {
        try {
          const timeSinceLastEvent = Date.now() - lastEventTime;
          // Only poll if no events received in last 5 seconds
          if (timeSinceLastEvent < 5000) return;
          
          const subs = Array.from(birdEyeWs.subscribed || []);
          const now = Date.now();
          for (const mint of subs) {
            const p = cache.get(`birdeye:ws:price:${mint}`) || null;
            if (p && p.priceUsd != null) {
              wsmgr.onWsEvent(mint, { price: Number(p.priceUsd), ts: Number(p.tsMs) || now });
            }
          }
        } catch {}
      }, FALLBACK_POLL_MS);
    }
    
    globalThis.__BIRDEYE_PRICE_HANDLER_BOUND__ = true;
  } catch {}
}

if (!globalThis.__WSMGR_SUB_EVENTS_BOUND__) {
  wsmgr.on('subscribe', ({ mint }) => {
    try { cache.set(`birdeye:sub:${mint}`, true, Math.ceil((process.env.BIRDEYE_LITE_CACHE_TTL_MS || 45000) / 1000)); } catch {}
  });
  wsmgr.on('unsubscribe', ({ mint }) => {
    try { cache.delete && cache.delete(`birdeye:sub:${mint}`); } catch {}
  });
  globalThis.__WSMGR_SUB_EVENTS_BOUND__ = true;
}



const execFileAsync = promisify(execFile);

const CT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
  hour12: true,
});
const fmtCt = (ms) => {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return `${CT_FORMATTER.format(new Date(n)).replace(',', '')} CT`;
};

function confirmQualityGate({ cfg, sigReasons, snapshot }) {
  if (!cfg.CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM) return { ok: true };
  const buySellRatio = Number(sigReasons?.buySellRatio || 0);
  const tx1m = Number(sigReasons?.tx_1m || 0);
  const tx5mAvg = Number(sigReasons?.tx_5m_avg || 0);
  const txMetricsMissing = !(Number.isFinite(tx1m) && Number.isFinite(tx5mAvg) && tx1m > 0 && tx5mAvg > 0);
  if (txMetricsMissing) return { ok: false, reason: 'txMetricMissing' };
  const confirmBuySellMin = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
  if (!(buySellRatio > confirmBuySellMin)) return { ok: false, reason: 'confirmWeakBuyDominance' };
  const txAccelMin = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
  if (!((tx1m / Math.max(1, tx5mAvg)) > txAccelMin)) return { ok: false, reason: 'confirmNoTxAcceleration' };

  const freshnessMs = Number(snapshot?.freshnessMs ?? Infinity);
  if (!Number.isFinite(freshnessMs) || freshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
    return { ok: false, reason: 'confirmStaleSnapshot' };
  }
  return { ok: true };
}

async function confirmContinuationGate({ cfg, mint, row, snapshot, pair, confirmMinLiqUsd, confirmPriceImpactPct, confirmStartLiqUsd = null }) {
  return runConfirmContinuationGate({
    cfg,
    mint,
    row,
    snapshot,
    pair,
    confirmMinLiqUsd,
    confirmPriceImpactPct,
    confirmStartLiqUsd,
    cacheImpl: cache,
  });
}

function recordConfirmCarryTrace(state, mint, stage, payload = {}) {
  state.runtime ||= {};
  state.runtime.confirmCarryTrace ||= [];
  const ev = { tMs: Date.now(), mint: String(mint || 'unknown'), stage, ...payload };
  state.runtime.confirmCarryTrace.push(ev);
  if (state.runtime.confirmCarryTrace.length > 100) state.runtime.confirmCarryTrace = state.runtime.confirmCarryTrace.slice(-100);
}

async function resolveConfirmTxMetrics({ state, row, snapshot, pair, mint, birdseye = null }) {
  const stateRowCarry = state?.watchlist?.mints?.[mint]?.meta?.confirmTxCarry || null;
  const carryByMint = state?.runtime?.confirmTxCarryByMint?.[mint] || null;
  const carryTx1m = Number(carryByMint?.tx1m ?? row?.meta?.confirmTxCarry?.tx1m ?? stateRowCarry?.tx1m ?? 0);
  const carryTx5mAvg = Number(carryByMint?.tx5mAvg ?? row?.meta?.confirmTxCarry?.tx5mAvg ?? stateRowCarry?.tx5mAvg ?? 0);
  const carryTx30mAvg = Number(carryByMint?.tx30mAvg ?? row?.meta?.confirmTxCarry?.tx30mAvg ?? stateRowCarry?.tx30mAvg ?? 0);
  const carryBsr = Number(carryByMint?.buySellRatio ?? row?.meta?.confirmTxCarry?.buySellRatio ?? stateRowCarry?.buySellRatio ?? 0);
  if (carryTx1m > 0 || carryTx5mAvg > 0 || carryTx30mAvg > 0 || carryBsr > 0) {
    return { tx1m: carryTx1m, tx5mAvg: carryTx5mAvg, tx30mAvg: carryTx30mAvg, buySellRatio: carryBsr, source: 'momentum.carried' };
  }

  const latestTx1m = Number(row?.latest?.tx1m || 0);
  const latestTx5mAvg = Number(row?.latest?.tx5mAvg || 0);
  const latestTx30mAvg = Number(row?.latest?.tx30mAvg || 0);
  const latestBsr = Number(row?.latest?.buySellRatio || 0);
  if (latestTx1m > 0 || latestTx5mAvg > 0 || latestTx30mAvg > 0 || latestBsr > 0) {
    return { tx1m: latestTx1m, tx5mAvg: latestTx5mAvg, tx30mAvg: latestTx30mAvg, buySellRatio: latestBsr, source: 'row.latest' };
  }

  const snapTx1m = Number(snapshot?.tx_1m ?? snapshot?.pair?.birdeye?.tx_1m ?? 0);
  const snapTx5mAvg = Number(snapshot?.tx_5m_avg ?? snapshot?.pair?.birdeye?.tx_5m_avg ?? 0);
  const snapTx30mAvg = Number(snapshot?.tx_30m_avg ?? snapshot?.pair?.birdeye?.tx_30m_avg ?? 0);
  const snapBsr = Number(snapshot?.buySellRatio ?? snapshot?.pair?.birdeye?.buySellRatio ?? 0);
  if (snapTx1m > 0 || snapTx5mAvg > 0 || snapTx30mAvg > 0 || snapBsr > 0) {
    return { tx1m: snapTx1m, tx5mAvg: snapTx5mAvg, tx30mAvg: snapTx30mAvg, buySellRatio: snapBsr, source: 'snapshot' };
  }

  const pairTx1m = Number(pair?.wsCache?.birdeye?.tx_1m ?? pair?.birdeye?.tx_1m ?? 0);
  const pairTx5mAvg = Number(pair?.wsCache?.birdeye?.tx_5m_avg ?? pair?.birdeye?.tx_5m_avg ?? 0);
  const pairTx30mAvg = Number(pair?.wsCache?.birdeye?.tx_30m_avg ?? pair?.birdeye?.tx_30m_avg ?? 0);
  const pairBsr = Number(pair?.wsCache?.birdeye?.buySellRatio ?? pair?.birdeye?.buySellRatio ?? 0);
  if (pairTx1m > 0 || pairTx5mAvg > 0 || pairTx30mAvg > 0 || pairBsr > 0) {
    return { tx1m: pairTx1m, tx5mAvg: pairTx5mAvg, tx30mAvg: pairTx30mAvg, buySellRatio: pairBsr, source: 'pair.ws' };
  }

  if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function' && mint) {
    try {
      const lite = await birdseye.getTokenSnapshot(mint);
      const liteSnapshot = snapshotFromBirdseye(lite, Date.now());
      const beTx1m = Number(liteSnapshot?.tx_1m ?? lite?.tx_1m ?? lite?.pair?.birdeye?.tx_1m ?? 0);
      const beTx5mAvg = Number(liteSnapshot?.tx_5m_avg ?? lite?.tx_5m_avg ?? lite?.pair?.birdeye?.tx_5m_avg ?? 0);
      const beTx30mAvg = Number(liteSnapshot?.tx_30m_avg ?? lite?.tx_30m_avg ?? lite?.pair?.birdeye?.tx_30m_avg ?? 0);
      const beBsr = Number(liteSnapshot?.buySellRatio ?? lite?.buySellRatio ?? lite?.pair?.birdeye?.buySellRatio ?? 0);
      if (beTx1m > 0 || beTx5mAvg > 0 || beTx30mAvg > 0 || beBsr > 0) {
        return { tx1m: beTx1m, tx5mAvg: beTx5mAvg, tx30mAvg: beTx30mAvg, buySellRatio: beBsr, source: 'birdeyeFallback.normalized' };
      }
    } catch {}
  }

  return { tx1m: 0, tx5mAvg: 0, tx30mAvg: 0, buySellRatio: 0, source: 'unknown' };
}

async function runNodeScriptJson(scriptPath, args, timeoutMs = 90_000) {
  const maxBuffer = Math.max(512 * 1024, Number(process.env.RUN_SCRIPT_MAX_BUFFER_BYTES || (2 * 1024 * 1024)));
  const parseLimitBytes = Math.max(64 * 1024, Number(process.env.RUN_SCRIPT_PARSE_LIMIT_BYTES || (512 * 1024)));
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    maxBuffer,
    env: process.env,
  });
  const stdoutText = String(stdout || '').trim();
  const outBytes = Buffer.byteLength(stdoutText, 'utf8');
  console.log('[runNodeScriptJson]', { script: scriptPath, stdoutBytes: outBytes, parseLimitBytes, maxBuffer });
  if (outBytes > parseLimitBytes) {
    throw new Error(`script stdout too large for JSON parse path (${outBytes} > ${parseLimitBytes})`);
  }

  const lines = stdoutText
    .split(/\r?\n/g)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : '';
  const looksLikeJson = lastLine.startsWith('{') || lastLine.startsWith('[');
  if (!looksLikeJson) {
    const preview = lastLine.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`script JSON parse failed: last non-empty stdout line is not JSON; preview="${preview}"`);
  }

  try {
    return JSON.parse(lastLine);
  } catch (e) {
    const preview = lastLine.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`script JSON parse failed (${safeErr(e).message}); stdoutBytes=${outBytes}; lastLinePreview="${preview}"`);
  }
}

async function resolveMintCreatedAtFromRpc({ state, conn, mint, nowMs, maxPages = 3 }) {
  if (!conn || !mint) return { createdAtMs: null, source: 'rpc.mintSignatures.missingInput' };
  state.runtime ||= {};
  state.runtime.mintCreatedAtCache ||= {};
  const cache = state.runtime.mintCreatedAtCache;
  const cached = cache[mint] || null;
  if (cached && Number(cached?.checkedAtMs || 0) > (nowMs - (60 * 60_000))) {
    return { createdAtMs: Number(cached?.createdAtMs || 0) || null, source: String(cached?.source || 'rpc.mintSignatures.cache') };
  }

  let before = null;
  let oldestBlockTimeSec = null;
  try {
    const pk = new PublicKey(mint);
    for (let i = 0; i < Math.max(1, Number(maxPages || 1)); i += 1) {
      const sigs = await conn.getSignaturesForAddress(pk, before ? { before, limit: 1000 } : { limit: 1000 });
      if (!Array.isArray(sigs) || !sigs.length) break;
      const withTime = sigs.filter((x) => Number.isFinite(Number(x?.blockTime)) && Number(x.blockTime) > 0);
      if (withTime.length) {
        const localOldest = withTime.reduce((min, x) => Math.min(min, Number(x.blockTime)), Number.POSITIVE_INFINITY);
        if (Number.isFinite(localOldest) && localOldest > 0) {
          oldestBlockTimeSec = oldestBlockTimeSec == null ? localOldest : Math.min(oldestBlockTimeSec, localOldest);
        }
      }
      before = sigs[sigs.length - 1]?.signature || null;
      if (!before || sigs.length < 1000) break;
    }
  } catch {
    cache[mint] = { createdAtMs: null, checkedAtMs: nowMs, source: 'rpc.mintSignatures.error' };
    return { createdAtMs: null, source: 'rpc.mintSignatures.error' };
  }

  const createdAtMs = oldestBlockTimeSec ? (Math.round(oldestBlockTimeSec * 1000)) : null;
  cache[mint] = { createdAtMs: createdAtMs || null, checkedAtMs: nowMs, source: createdAtMs ? 'rpc.mintSignatures.blockTime' : 'rpc.mintSignatures.missingBlockTime' };
  return { createdAtMs: createdAtMs || null, source: createdAtMs ? 'rpc.mintSignatures.blockTime' : 'rpc.mintSignatures.missingBlockTime' };
}


const {
  upsertWatchlistMint,
  promoteRouteAvailableCandidate,
  evaluateWatchlistRows,
} = createWatchlistPipeline({
  confirmQualityGate,
  confirmContinuationGate,
  recordConfirmCarryTrace,
  resolveConfirmTxMetrics,
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

async function computeMcapUsd(cfg, pair, rpcUrl) {
  const priceUsd = Number(pair?.priceUsd || 0);
  if (!priceUsd) return { ok: false, reason: 'missing priceUsd', mcapUsd: null, decimals: null };

  const mint = pair?.baseToken?.address;
  if (!mint) return { ok: false, reason: 'missing base token mint', mcapUsd: null, decimals: null };

  const supply = await getTokenSupply(rpcUrl, mint);
  const uiAmount = supply?.value?.uiAmount;
  const decimals = supply?.value?.decimals;
  if (typeof uiAmount !== 'number') return { ok: false, reason: 'missing uiAmount supply', mcapUsd: null, decimals: null };
  if (typeof decimals !== 'number') return { ok: false, reason: 'missing decimals', mcapUsd: null, decimals: null };

  const mcapUsd = uiAmount * priceUsd;
  // Note: do NOT apply any threshold here; thresholds belong in the scan loop
  // so state overrides (/setfilter mcap) work consistently.
  return { ok: true, reason: 'ok', mcapUsd, decimals };
}

function initBirdEyeRuntimeListeners(state) {
  if (globalThis.__BIRDEYE_RUNTIME_LISTENERS_BOUND__) return;

  birdEyeWs.on?.('open', () => {
    for (const mint of Object.keys(state?.positions || {})) {
      if (wsmgr.diag && wsmgr.diag[mint]) wsmgr.diag[mint].ws_connected = true;
    }
    const priceListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('price') : 'n/a';
    const openListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('open') : 'n/a';
    const closeListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('close') : 'n/a';
    const errorListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('error') : 'n/a';
    console.log('[birdeye-ws] connected', { priceListeners, openListeners, closeListeners, errorListeners, wsmgrBound: !!globalThis.__WSMGR_BOUND__ });
  });

  birdEyeWs.on?.('close', () => {
    for (const mint of Object.keys(state?.positions || {})) {
      if (wsmgr.diag && wsmgr.diag[mint]) wsmgr.diag[mint].ws_connected = false;
    }
    console.warn('[birdeye-ws] closed');
  });

  birdEyeWs.on?.('error', (e) => {
    console.warn('[birdeye-ws] error', safeErr(e).message);
  });

  globalThis.__BIRDEYE_RUNTIME_LISTENERS_BOUND__ = true;

  console.log('[birdeye-ws] listeners', {
    price: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('price') : 'n/a',
    open: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('open') : 'n/a',
    close: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('close') : 'n/a',
    error: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('error') : 'n/a',
  });
}

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
    initBirdEyeRuntimeListeners(state);
    birdEyeWs.start();
  } catch (e) {
    console.warn('[birdeye-ws] start failed', safeErr(e).message);
  }

  // manager exit -> closePosition (immediate). Manager marks diag fields itself.
  wsmgr.on('exit', async ({mint, price, reason, chunked})=>{
    try{
      const pair = state.positions[mint] ? { priceUsd: state.positions[mint].lastSeenPriceUsd } : null;
      // If manager suggested chunked exit, attempt 2-3 quick chunks before falling back to full close
      if (chunked) {
        try{
          const pos = state.positions[mint];
          const bal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
          const amountRaw = Number(bal.amount || 0);
          if (amountRaw > 0) {
            const chunks = [0.35, 0.35, 0.30]; // attempt up to 3 quick chunks
            let remaining = amountRaw;
            const startMs = Date.now();
            let anySuccess = false;
            for (let i=0;i<chunks.length;i++){
              if (remaining <= 0) break;
              const take = Math.max(1, Math.round(amountRaw * chunks[i]));
              const submitMs = Date.now();
              try{
                const res = await executeSwap({ conn, wallet, inputMint: mint, outputMint: cfg.SOL_MINT, inAmountBaseUnits: take, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                // update diagnostics if available
                try{
                  const d = wsmgr.diag && wsmgr.diag[mint];
                  if (d && d.triggerAtMs) d.trigger_to_order_ms = (submitMs - d.triggerAtMs);
                  if (d) {
                    d.order_to_fill_ms = Date.now() - submitMs;
                    const triggerP = Number(d.trigger_price || 0) || price || null;
                    const soldTokens = Number(res?.fill?.inAmountRaw || 0) / (10 ** (res?.fill?.inDecimals || pos?.decimals || 0) );
                    const outSolRaw = Number(res?.fill?.outAmountRaw || 0);
                    const outSol = outSolRaw > 0 ? (outSolRaw / 1e9) : null;
                    const solUsd = (await getSolUsdPrice()).solUsd || null;
                    if (triggerP && soldTokens && outSol && solUsd) {
                      const exitPriceUsd = (outSol * solUsd) / soldTokens;
                      d.slippage_vs_trigger_price_pct = ((exitPriceUsd - triggerP) / triggerP) * 100;
                    }
                  }
                }catch(e){}
                anySuccess = true;
                remaining = Math.max(0, remaining - take);
                // small, fast pause between chunks
                await new Promise(r=>setTimeout(r, 80));
                // if process is taking too long, abort chunking
                if (Date.now() - startMs > 1000) break;
              }catch(e){
                // stop attempting further chunks on first error
                break;
              }
            }
            if (!anySuccess || (Date.now() - startMs) > 1000) {
              // fallback to single full exit (do not delay)
              await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule||'auto'}:fallback`);
            } else {
              // mark closed if balance consumed, else delegate to closePosition to finish
              const finalBal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
              if (!finalBal || Number(finalBal.amount||0) <= 0) {
                // create minimal bookkeeping similar to closePosition by marking closed and saving state
                try{ state.positions[mint].status='closed'; state.positions[mint].exitAt = new Date().toISOString(); }catch(e){}
              } else {
                // still tokens remain — call closePosition to finish with full amount
                await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule||'auto'}:post_chunks`);
              }
            }
            saveState(cfg.STATE_PATH, state);
            return;
          }
        }catch(e){ console.warn('[wsmgr glue] chunked exit attempt failed', safeErr(e)); }
        // fallthrough to full exit
      }

      await closePosition(cfg, conn, wallet, state, mint, pair, `ws_exit:${reason?.rule||'auto'}${chunked?':chunked':''}`);
      saveState(cfg.STATE_PATH, state);
    }catch(e){ console.error('[wsmgr glue] exit handler err', safeErr(e)); }
  });

  // detect stale live mints and trigger restResync once-per-incident
  startWatchlistCleanupTimer({ globalTimers, cfg, wsmgr });

  state.positions ||= {};
  state.portfolio ||= { maxEquityUsd: cfg.STARTING_CAPITAL_USDC };
  state.paperAttempts ||= [];
  state.runtime ||= {};
  state.runtime.botStartTimeMs = Date.now();
  ensureWatchlistState(state);

  // Ensure CURRENT open positions are immediately enrolled in WS LIVE tier on boot.
  try {
    for (const [mint, pos] of Object.entries(state.positions || {})) {
      if (pos?.status !== 'open') continue;
      try {
        wsmgr.onFill(mint, {
          entryPrice: Number(pos.entryPriceUsd || 0) || null,
          stopPrice: Number(pos.stopPriceUsd || 0) || null,
          stopPct: null,
          trailingPct: Number(pos?.trailDistancePct || 0) || null,
        });
      } catch {}
      try {
        cache.set(`birdeye:sub:${mint}`, true, Math.ceil((cfg.BIRDEYE_LITE_CACHE_TTL_MS || 45000) / 1000));
      } catch {}

      // Boot-time safety reconcile: if fresh REST mark is already at/below stop, close immediately.
      try {
        const snap = await birdseye.getTokenSnapshot(mint);
        const px = Number(snap?.priceUsd || 0);
        const st = Number(pos?.stopPriceUsd || 0);
        if (px > 0 && st > 0 && px <= st) {
          const pairBoot = { baseToken: { symbol: pos?.symbol || null }, priceUsd: px, url: pos?.pairUrl || null };
          const rr = pos?.trailingActive
            ? `trailing stop hit @ ${px.toFixed(6)} <= ${st.toFixed(6)} (boot_reconcile)`
            : `stop hit @ ${px.toFixed(6)} <= ${st.toFixed(6)} (boot_reconcile)`;
          await closePosition(cfg, conn, wallet, state, mint, pairBoot, rr);
          saveState(cfg.STATE_PATH, state);
        }
      } catch {}
    }
  } catch {}

  console.log(`[wallet] publicKey=${pub}`);
  console.log(
    `[boot] data_capture=${cfg.DATA_CAPTURE_ENABLED} execution=${cfg.EXECUTION_ENABLED} sim_tracking=${cfg.SIM_TRACKING_ENABLED} ` +
      `live_momo=${cfg.LIVE_MOMO_ENABLED} scanner_entries=${cfg.SCANNER_ENTRIES_ENABLED} scanner_tracking=${cfg.SCANNER_TRACKING_ENABLED} ` +
      `stopAtEntry=${cfg.LIVE_MOMO_STOP_AT_ENTRY} bufferPct=${cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT} ` +
      `trailActivatePct=${cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT} trailDistancePct=${cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT}`,
  );

  // Register command menu in Telegram UI
  await tgSetMyCommands(cfg);

  await tgSend(cfg, `🟢 *Candle Carl online*\n\n👛 Wallet: ${pub}\n🪙 Base: SOL`);

  // Boot-time SOLUSD fetch: do NOT crash the bot if DexScreener is rate-limiting.
  // We'll cool down and retry until we have a price.
  let solUsd;
  let bootPriceWarned = false;
  while (!solUsd) {
    try {
      solUsd = (await getSolUsdPrice()).solUsd;
    } catch (e) {
      if (!bootPriceWarned) {
        bootPriceWarned = true;
        await tgSend(cfg, `⚠️ SOLUSD fetch failed at boot (${safeMsg(e)}). Cooling down and retrying...`);
      }
      await new Promise(r => setTimeout(r, 60_000));
    }
  }

  const solLamports = await getSolBalanceLamports(conn, pub);

  await tgSend(cfg, [
    '📊 *Balances*',
    '',
    `• SOL: ${(solLamports / 1e9).toFixed(4)}`,
    `• SOLUSD: $${solUsd.toFixed(2)}`,
    `• Equity≈: ${fmtUsd((solLamports / 1e9) * solUsd)}`,
  ].join('\n'));

  // Startup sanity: if state claims open positions, reconcile with on-chain balances before we do anything else.
  try {
    const anyOpen = Object.values(state.positions || {}).some(p => p?.status === 'open');
    if (anyOpen) {
      const reconcileSummary = await reconcilePositions({ cfg, conn, ownerPubkey: pub, state });
      saveState(cfg.STATE_PATH, state);
      console.log(`[startup] reconciled open positions: now open=${positionCount(state)} prunedClosed=${Number(reconcileSummary?.prunedClosedPositions || 0)} activeRunners=${Number(reconcileSummary?.activeRunnerCount || 0)}`);
    }
  } catch (e) {
    console.warn('[startup] reconcilePositions failed (continuing):', safeErr(e).message);
  }
  try {
    syncExposureStateWithPositions({ cfg, state });
  } catch {}

  let lastScan = 0;
  let nextScanDelayMs = cfg.SCAN_EVERY_MS;
  const lastPosRef = { value: 0 };
  let lastHb = 0;
  let lastRej = 0;
  let lastTgPoll = 0;
  let lastAutoTune = 0;
  let lastHourlyDiag = 0;
  let lastWatchlistEval = 0;
  let lastExposureQueueDrainAt = 0;

  // loop timing (for /healthz)
  let _loopPrevAtMs = Date.now();
  let _loopDtMs = 0;

  // Use persisted diagnostic counters as single source of truth across restarts.
  state.runtime ||= {};
  let counters = (state.runtime.diagCounters && typeof state.runtime.diagCounters === 'object')
    ? state.runtime.diagCounters
    : makeCounters();
  state.runtime.diagCounters = counters;

  // Hydrate confirm carry runtime cache from persisted watchlist state on boot.
  state.runtime.compactWindow ||= {};
  counters.watchlist ||= {};
  counters.watchlist.compactWindow = state.runtime.compactWindow;
  state.runtime.confirmTxCarryByMint ||= {};
  const pushCompactWindowEvent = (kind, reason = null, extra = null, opts = {}) => {
    state.runtime.compactWindow ||= {};
    const cw = state.runtime.compactWindow;
    const tMs = Number(opts?.tMs || Date.now());
    const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
    const cutoff = tMs - retainMs;
    const ensureArr = (k) => {
      cw[k] ||= [];
      return cw[k];
    };
    const pushTs = (k) => {
      const arr = ensureArr(k);
      arr.push(tMs);
      while (arr.length && Number(arr[0] || 0) < cutoff) arr.shift();
    };
    const pushObj = (k, obj) => {
      const arr = ensureArr(k);
      arr.push({ tMs, ...(obj || {}) });
      while (arr.length && Number(arr[0]?.tMs || 0) < cutoff) arr.shift();
    };

    const tsKinds = new Set(['watchlistSeen', 'watchlistEvaluated', 'momentumEval', 'momentumPassed', 'confirmReached', 'confirmPassed', 'attempt', 'fill']);
    if (tsKinds.has(kind)) return pushTs(kind);

    if (kind === 'blocker') return pushObj('blockers', { reason: String(reason || 'unknown'), mint: String(extra?.mint || 'unknown'), stage: String(extra?.stage || 'unknown') });
    if (kind === 'momentumFailChecks') return pushObj('momentumFailChecks', { checks: Array.isArray(extra?.checks) ? extra.checks.slice(0, 16) : [], mint: String(extra?.mint || 'unknown') });
    if (kind === 'momentumLiq') return pushObj('momentumLiqValues', { liqUsd: Number(extra?.liqUsd || 0) });
    if (kind === 'stalkableSeen') return pushObj('stalkableSeen', { mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
    if (kind === 'candidateSeen') return pushObj('candidateSeen', { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
    if (kind === 'candidateRouteable') return pushObj('candidateRouteable', { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
    if (kind === 'candidateLiquiditySeen') return pushObj('candidateLiquiditySeen', { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
    if (kind === 'scanCycle') return pushObj('scanCycles', extra || {});
    if (kind === 'repeatSuppressed') return pushObj('repeatSuppressed', { mint: String(extra?.mint || 'unknown'), reason: String(extra?.reason || 'unknown') });
    if (kind === 'momentumRecent') return pushObj('momentumRecent', extra || {});
    if (kind === 'momentumScoreSample') return pushObj('momentumScoreSamples', extra || {});
    if (kind === 'momentumInputSample') return pushObj('momentumInputSamples', extra || {});
    if (kind === 'momentumAgeSample') return pushObj('momentumAgeSamples', extra || {});
    if (kind === 'postMomentumFlow') return pushObj('postMomentumFlow', extra || {});
  };

  // Hydrate compact diagnostic window from durable diag events log for retro windows across restarts.
  // Skip replay if compact window is already populated in persisted counters.
  try {
    const compactHasData = Array.isArray(counters?.watchlist?.compactWindow?.momentumAgeSamples) && counters.watchlist.compactWindow.momentumAgeSamples.length > 0;
    const diagEventsPath = path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl');
    if (!compactHasData && fs.existsSync(diagEventsPath)) {
      const raw = fs.readFileSync(diagEventsPath, 'utf8');
      const replayMaxLines = Math.max(10_000, Number(process.env.DIAG_HYDRATE_MAX_LINES || 500_000));
      const lines = raw.trim().split('\n').slice(-replayMaxLines);
      const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
      const cutoff = Date.now() - retainMs;
      for (const ln of lines) {
        try {
          const ev = JSON.parse(ln);
          const tMs = Number(ev?.tMs || 0);
          if (!Number.isFinite(tMs) || tMs < cutoff) continue;
          pushCompactWindowEvent(String(ev?.kind || ''), ev?.reason ?? null, ev?.extra ?? null, { persist: false, tMs });
        } catch {}
      }
    }
  } catch {}
  try {
    const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};
    for (const [mint, row] of Object.entries(wlMints)) {
      const c = row?.meta?.confirmTxCarry || null;
      if (c && Number(c?.atMs || 0) > 0) state.runtime.confirmTxCarryByMint[mint] = { ...c };
    }
  } catch {}

  // Jupiter preflight: verify we can reach JUP and headers are accepted. If preflight fails
  // mark Jupiter as unhealthy and hit the circuit so we avoid attempts that will fail.
  if (JUP_SOURCE_PREFLIGHT_ENABLED) {
    try {
      const { jupiterPreflight } = await import('./jupiter.mjs');
      const pref = await jupiterPreflight();
      state.marketData ||= {};
      state.marketData.providers ||= {};
      state.marketData.providers.jupiter ||= {};
      if (!pref || !pref.ok) {
        state.marketData.providers.jupiter.status = 'unhealthy';
        const prefReason = String(pref?.reason || 'unknown');
        pushDebug(state, { t: nowIso(), reason: `jupPreflightFailed(${safeMsg(prefReason)})` });
        const parsed = parseJupQuoteFailure({ message: prefReason });
        // Non-tradable token errors are candidate-quality issues, not system-risk circuit triggers.
        if (parsed !== 'nonTradableMint') {
          // hit circuit for Jupiter to avoid repeated failing attempts; use a short base cooldown.
          circuitHit({ state, nowMs: Date.now(), dep: 'jup', note: `preflight(${prefReason})`, persist: () => saveState(cfg.STATE_PATH, state) });
        }
      } else {
        state.marketData.providers.jupiter.status = 'ok';
      }
    } catch (e) {
      pushDebug(state, { t: nowIso(), reason: `jupPreflightException(${safeMsg(e)})` });
      circuitHit({ state, nowMs: Date.now(), dep: 'jup', note: `preflightException(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
    }
  }


  // Positions enforcement must not be starved by long scan lanes.
  // runPositionsLoop is extracted to positions_loop.mjs; lastPosRef shared across all positions check blocks.
  const { runPositionsLoop } = createPositionsLoop({
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

  // Cached spend summaries to keep /spend off the hot loop path.
  const SPEND_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SPEND_CACHE_TTL_MS || 5 * 60_000));
  const {
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
  } = createSpendSummaryCache({
    cfg,
    parseRange,
    readLedger,
    summarize,
    safeErr,
  });


  // Operator surfaces (Telegram state.flags.* handlers) extracted to operator_surfaces.mjs.
  const { processOperatorCommands } = createOperatorSurfaces({
    cfg,
    state,
    conn,
    pub,
    tgSend,
    tgSendChunked,
    getDiagSnapshotMessage,
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
    SPEND_CACHE_TTL_MS,
    runNodeScriptJson,
    appendLearningNote: undefined,
    getSolUsdPrice: undefined,
    sendPositionsReport,
    getLoopState: () => ({ dexCooldownUntil, lastScan, lastSolUsdAt }),
  });

  // DexScreener rate-limit handling (centralized module)
  ensureDexState(state);
  ensureMarketDataState(state);
  ensureCircuitState(state);
  ensureCapitalGuardrailsState(state);
  ensurePlaybookState(state);
  ensureForceAttemptPolicyState(state);
  const bootNowMs = Date.now();
  if (cfg.PLAYBOOK_ENABLED) {
    recordPlaybookRestart({ state, nowMs: bootNowMs });
  }
  let dexCooldownUntil = getDexCooldownUntilMs(state);
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
  import('./rpc_probe.mjs').then(({ startRpcProbe }) => {
    try {
      const rpcHealth = startRpcProbe({ cfg, intervalMs: Number(process.env.RPC_PROBE_EVERY_MS || 30000) });
      import('./heartbeat.mjs').then(({ startHeartbeat }) => {
        try {
          startHeartbeat({ cfg, state, conn, walletPub: pub, tgSend, rpcHealth });
        } catch (e) {
          console.warn('[heartbeat] failed to start', e?.message || e);
        }
      }).catch(e => console.warn('[heartbeat] import failed', e?.message || e));
    } catch (e) {
      console.warn('[rpc_probe] failed to start', e?.message || e);
    }
  }).catch(e => console.warn('[rpc_probe] import failed', e?.message || e));

  // Graceful shutdown: persist state and close the local health listener so PM2 reloads
  // don't leave stale state or lingering sockets.
  let streamingProvider = null;
  let _shuttingDown = false;
  async function _shutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.warn('[shutdown] signal=' + signal);
    try { clearAllTimers(); } catch {}
    try { saveState(cfg.STATE_PATH, state); } catch {}
    try { streamingProvider?.stop?.(); } catch {}
    try { birdEyeWs?.stop?.(); } catch {}
    try { healthServer?.close(); } catch {}
    try { const { closeTimescaleDB } = await import('./timeseries_db.mjs'); await closeTimescaleDB(); } catch {}
    // Allow a brief tick for any in-flight I/O, then exit.
    setTimeout(() => process.exit(0), 250).unref();
  }
  process.on('SIGTERM', () => { _shutdown('SIGTERM'); });
  process.on('SIGINT', () => { _shutdown('SIGINT'); });

  // Candidate source feed caches are owned by createCandidatePipeline below.

  // Execution gate: explicit config + runtime toggle.
  // Backward-compatible: FORCE_TRADING_ENABLED can seed runtime enabled state.
  state.tradingEnabled = state.tradingEnabled ?? (cfg.EXECUTION_ENABLED && cfg.FORCE_TRADING_ENABLED);
  state.debug ||= {};
  state.debug.last ||= [];
  state.flags ||= {};
  state.filterOverrides ||= state.filterOverrides || null;
  state.modelOverrides ||= state.modelOverrides || null;

  // Initialize TimescaleDB for historical data persistence
  if (process.env.TIMESCALE_ENABLED === 'true') {
    import('./timeseries_db.mjs').then(({ initializeTimescaleDB }) => {
      initializeTimescaleDB().catch(err => {
        console.warn('[TimescaleDB] Failed to initialize (bot will continue without it):', err.message);
      });
    }).catch(err => {
      console.warn('[TimescaleDB] Import failed:', err.message);
    });
  }

  let lastRpcAlertAt = 0;
  let lastLowSolAlertAt = 0;
  let lastReconcileAt = 0;

  streamingProvider = createStreamingProvider(cfg, {
    log: (...args) => console.log(...args),
  });
  streamingProvider.start();
  let lastStreamingHealthAt = 0;

  const { fetchCandidateSources } = createCandidatePipeline({
    cfg, state, birdseye, streamingProvider, tgSend, saveState,
  });

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
    state.runtime ||= {};
    if (state.flags?.forceCloseMint) {
      state.runtime.forceCloseMint = String(state.flags.forceCloseMint || '').trim() || null;
      delete state.flags.forceCloseMint;
      saveState(cfg.STATE_PATH, state);
    }
    if (state.runtime?.forceCloseMint) {
      const mint = String(state.runtime.forceCloseMint || '').trim();
      const pos = mint ? state.positions?.[mint] : null;
      if (!mint || !pos || pos.status !== 'open') {
        delete state.runtime.forceCloseMint;
        saveState(cfg.STATE_PATH, state);
      } else {
        const lastTryMs = Number(pos._forceCloseLastTryAtMs || 0);
        if ((t - lastTryMs) >= 10_000) {
          pos._forceCloseLastTryAtMs = t;
          try {
            const pair = { baseToken: { symbol: pos?.symbol || null }, priceUsd: Number(pos?.lastSeenPriceUsd || pos?.entryPriceUsd || 0), url: pos?.pairUrl || null };
            await closePosition(cfg, conn, wallet, state, mint, pair, 'manual force close');
            if (state.positions?.[mint]?.status === 'closed') {
              delete state.runtime.forceCloseMint;
              await tgSend(cfg, `🛑 Manual force-close executed for ${pos?.symbol || mint.slice(0,6)+'…'} (${mint}).`);
            }
            saveState(cfg.STATE_PATH, state);
          } catch (e) {
            pos._forceCloseLastErrAtMs = t;
            pos._forceCloseLastErr = safeErr(e).message;
            saveState(cfg.STATE_PATH, state);
          }
        }
      }
    }

    // Check positions for exits (run early so scan-lane continues can't starve exits)
    if (t - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
      lastPosRef.value = t;

      for (const [mint, pos] of Object.entries(state.positions)) {
        if (pos.status !== 'open') continue;

        // Streaming-first stop enforcement: use fresh BirdEye WS tick immediately.
        try {
          const ws = cache.get(`birdeye:ws:price:${mint}`) || null;
          const wsTs = Number(ws?.tsMs || 0);
          const wsPrice = Number(ws?.priceUsd || 0);
          const wsFresh = wsTs > 0 && (Date.now() - wsTs) <= 15_000;
          if (wsFresh && wsPrice > 0 && Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(wsPrice, pos, null, cfg) <= Number(pos.stopPriceUsd)) {
            const pairWs = { baseToken: { symbol: pos?.symbol || null }, priceUsd: wsPrice, url: pos?.pairUrl || null };
            const r = pos.trailingActive
              ? `trailing stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`
              : `stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`;
            await closePosition(cfg, conn, wallet, state, mint, pairWs, r);
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch {}

        const snapshot = await getMarketSnapshot({
          state,
          mint,
          nowMs: t,
          maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS,
          getTokenPairs,
          pickBestPair,
          birdeyeEnabled: birdseye?.enabled,
          getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
        });
        let effectiveSnapshot = snapshot;
        if (!effectiveSnapshot?.priceUsd || !isStopSnapshotUsable(effectiveSnapshot)) {
          try {
            const pairsFallback = await getTokenPairs(mint);
            const bestFallback = pickBestPair(pairsFallback);
            const pxFallback = Number(bestFallback?.priceUsd || 0);
            if (pxFallback > 0) {
              effectiveSnapshot = {
                source: 'dex_fallback',
                confidence: 'low',
                freshnessMs: 0,
                priceUsd: pxFallback,
                pair: bestFallback,
              };
            }
          } catch {}
        }
        if (!effectiveSnapshot?.priceUsd) {
          pushDebug(state, {
            t: nowIso(),
            mint,
            symbol: pos?.symbol || null,
            reason: `positionsMarketData(skip src=${snapshot?.source || 'none'} conf=${snapshot?.confidence || 'none'} freshMs=${snapshot?.freshnessMs ?? 'n/a'})`,
          });
          continue;
        }
        const pair = effectiveSnapshot?.pair || { baseToken: { symbol: pos?.symbol || null }, priceUsd: effectiveSnapshot.priceUsd };
        const priceUsd = Number(effectiveSnapshot.priceUsd);

        // Stop has priority over time-stop labeling.
        if (Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= Number(pos.stopPriceUsd)) {
          const r = pos.trailingActive
            ? `trailing stop hit @ ${priceUsd.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (cycle_reconcile)`
            : `stop hit @ ${priceUsd.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (cycle_reconcile)`;
          await closePosition(cfg, conn, wallet, state, mint, pair, r);
          saveState(cfg.STATE_PATH, state);
          continue;
        }

        // Early failure kill: if still below entry after 60-90s, cut quickly.
        try {
          if (cfg.EARLY_FAILURE_KILL_ENABLED) {
            const entryTs = Date.parse(pos.entryAt) || 0;
            const entryPrice = Number(pos.entryPriceUsd || 0) || null;
            if (entryTs && entryPrice && entryPrice > 0) {
              if (!Number.isFinite(Number(pos.earlyFailureDeadlineMs))) {
                const minMs = Number(cfg.EARLY_FAILURE_KILL_MIN_MS || 60_000);
                const maxMs = Math.max(minMs, Number(cfg.EARLY_FAILURE_KILL_MAX_MS || 90_000));
                const jitter = Math.floor(minMs + (Math.random() * (maxMs - minMs)));
                pos.earlyFailureDeadlineMs = entryTs + jitter;
              }
              const deadlineMs = Number(pos.earlyFailureDeadlineMs || 0);
              if (deadlineMs > 0 && Date.now() >= deadlineMs && priceUsd < entryPrice) {
                await closePosition(cfg, conn, wallet, state, mint, pair, 'early-failure kill (below entry after 60-90s)');
                saveState(cfg.STATE_PATH, state);
                continue;
              }
            }
          }
        } catch (e) {
          // best-effort only; do not throw
        }

        // Secondary time-stop: after 4 minutes, if still weak (<+2%).
        try {
          const entryTs = Date.parse(pos.entryAt) || 0;
          const ageMs = Date.now() - entryTs;
          const entryPrice = Number(pos.entryPriceUsd || 0) || null;
          const profitPct = (entryPrice && entryPrice > 0) ? ((priceUsd - entryPrice) / entryPrice) : null;
          if (entryTs && ageMs >= (4 * 60_000) && (profitPct == null || profitPct < 0.02)) {
            await closePosition(cfg, conn, wallet, state, mint, pair, 'time-stop weak momentum');
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch (e) {
          // best-effort only; do not throw
        }

        // Repair missing entry/stop fields if we opened a position without a valid entry snapshot.
        if (!Number.isFinite(Number(pos.entryPriceUsd)) || Number(pos.entryPriceUsd) <= 0) {
          pos.entryPriceUsd = priceUsd;
          pos.peakPriceUsd = priceUsd;
          pos.lastSeenPriceUsd = priceUsd;
          pos.stopPriceUsd = priceUsd;
          pos.lastStopUpdateAt = nowIso();
          pos.note = (pos.note || '') + ` | repairedEntryPriceFromPriceFeed`;
          const label = tokenDisplayName({ name: pos?.tokenName, symbol: pos?.symbol, mint });
          await tgSend(cfg, `🛠️ Repaired missing entry price for ${label} using live price ${priceUsd.toFixed(6)}. New stop set to ${pos.stopPriceUsd.toFixed(6)}.`);
          saveState(cfg.STATE_PATH, state);
        }

        const stopUpdate = await updateStops(cfg, state, mint, priceUsd);
        if (stopUpdate.changed) {
          await tgSend(cfg, [
            `🟣 *TRAIL UPDATE* — ${tokenDisplayName({ name: pos?.tokenName, symbol: pos?.symbol, mint })}`,
            '',
            `• New stop: $${pos.stopPriceUsd.toFixed(6)}`,
            `• Peak: $${pos.peakPriceUsd.toFixed(6)}`,
          ].join('\n'));
        }

        if (conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= pos.stopPriceUsd) {
          const r = pos.trailingActive ? 'trailing stop hit' : 'stop loss hit';
          await closePosition(cfg, conn, wallet, state, mint, pair, r);
          saveState(cfg.STATE_PATH, state);
        }
      }
    }

    // Ledger hygiene (best-effort): prune/rotate JSONL so disks don't fill.
    if (t - lastLedgerPruneAt > 6 * 60 * 60_000) {
      lastLedgerPruneAt = t;
      try {
        const files = [
          cfg.LEDGER_PATH,
          cfg.TRADES_LEDGER_PATH,
          './state/candidates.jsonl',
          './state/paper_trades.jsonl',
          './state/paper_live_attempts.jsonl',
        ];
        for (const fp of files) {
          try {
            maybeRotateBySize({ filePath: fp, maxBytes: cfg.JSONL_ROTATE_MAX_BYTES, nowMs: t });
            maybePruneJsonlByAge({ filePath: fp, maxAgeDays: cfg.JSONL_RETENTION_DAYS, nowMs: t });
          } catch {}
        }
        try {
          const diagEventsPath = path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl');
          maybeRotateBySize({ filePath: diagEventsPath, maxBytes: cfg.JSONL_ROTATE_MAX_BYTES, nowMs: t });
          maybePruneJsonlByAge({ filePath: diagEventsPath, maxAgeDays: cfg.DIAG_RETENTION_DAYS, nowMs: t });
        } catch {}
      } catch {}
    }

    // Reconcile state positions with on-chain balances (helps sync after manual sells / RPC flakiness)
    if (t - lastReconcileAt >= 60_000) {
      lastReconcileAt = t;

      let holdings = null;
      try {
        holdings = await getTokenHoldingsByMint(conn, pub);
      } catch {
        holdings = null;
      }

      for (const [mint, pos] of Object.entries(state.positions || {})) {
        if (!pos) continue;
        if (pos.status !== 'open' && pos.status !== 'closed') continue;

        // Prefer full holdings map (covers TOKEN + TOKEN-2022). Fall back to per-mint balance.
        let bal = null;
        if (holdings) {
          const amt = holdings.get(mint) || 0;
          bal = { amount: amt, ata: null, source: 'holdings_map', fetchOk: true };
        } else {
          try {
            bal = await getSplBalance(conn, pub, mint);
          } catch {
            continue;
          }
        }

        applyOnchainBalanceToPosition({
          pos,
          bal,
          nowMs: Date.now(),
          nowIso: nowIso(),
        });
      }

      saveState(cfg.STATE_PATH, state);
    }

    // Auto-tune until first trade happens
    const anyTradesYet = Object.values(state.positions || {}).some(p => p.entryTx);

    if (cfg.AUTO_TUNE_ENABLED && t - lastAutoTune >= cfg.AUTO_TUNE_EVERY_MS) {
      lastAutoTune = t;
      if (!anyTradesYet) {
        const changes = autoTuneFilters({ state, cfg, nowIso });
        if (changes.length) {
          saveState(cfg.STATE_PATH, state);
          await tgSend(cfg, `🧠 Auto-tune adjusted filters: ${changes.join(', ')}`);
        }
      }
    }

    // Hourly throughput diagnostic (even when no changes are made)
    const hourlyDiagEnabled = (state?.flags?.hourlyDiagEnabled ?? cfg.HOURLY_DIAG_ENABLED);
    if (hourlyDiagEnabled && t - lastHourlyDiag >= cfg.HOURLY_DIAG_EVERY_MS) {
      lastHourlyDiag = t;
      if (!anyTradesYet) {
        const { snap, next } = snapshotAndReset(counters);
        counters = next;
        state.runtime.diagCounters = counters;
        const fo = state.filterOverrides || {};
        const msg = [
          formatThroughputSummary({
            counters: snap,
            title: '📈 *Throughput check* (last window)',
          }),
          '',
          '🎛️ current filters',
          `• liq >= ${fo.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD}`,
          `• age >= ${fo.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS}h`,
          `• mcap >= ${fo.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD}`,
          `• liqratio >= ${fo.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO}`,
          '',
          formatMarketDataProviderSummary(state),
          `🕒 ${nowIso()}`,
        ].join('\n');
        await tgSend(cfg, msg);
      }
    }

    // Telegram controls polling
    if (t - lastTgPoll >= cfg.TELEGRAM_POLL_EVERY_MS) {
      lastTgPoll = t;
      await handleTelegramControls({
        cfg,
        state,
        counters,
        send: tgSend,
        nowIso,
        onDiagRequest: (mode = 'compact', windowHours = null) => {
          const m = String(mode || 'compact').toLowerCase();
          const diagMode = (m === 'full' || m === 'momentum' || m === 'confirm' || m === 'execution' || m === 'scanner') ? m : 'compact';
          const msg = getDiagSnapshotMessage(Date.now(), diagMode, windowHours);
          Promise.resolve(tgSendChunked(msg)).catch((e) => {
            console.warn('[diag] send failed', safeErr(e).message);
          });
        },
        onPositionsRequest: () => sendPositionsReport(),
      });
    }

    // Forward tracking tick ("what would have happened")
    try {
      await trackerTick({ cfg, state, send: tgSend, nowIso, conn, wallet, solUsd: lastSolUsd || solUsd || null, birdseye });
    } catch {}

    // Watchlist trigger lane: decoupled high-cadence re-evaluation for entries.
    if (cfg.WATCHLIST_TRIGGER_MODE && (t - lastWatchlistEval >= cfg.WATCHLIST_EVAL_EVERY_MS)) {
      lastWatchlistEval = t;
      const wl = ensureWatchlistState(state);
      wl.stats.lastEvalAtMs = t;
      evictWatchlist({ state, cfg, nowMs: t, counters });
      pruneRouteCache({ state, cfg, nowMs: t });

      const circuitOk = circuitOkForEntries({ state, nowMs: t });
      const playbookBlocks = cfg.PLAYBOOK_ENABLED && (state.playbook?.mode === PLAYBOOK_MODE_DEGRADED);
      const lowSolPaused = state.flags?.lowSolPauseEntries === true;
      const capOk = entryCapacityAvailable(state, cfg);
      const paperModeActive = isPaperModeActive({ state, cfg, nowMs: t });
      const executionAllowed = (cfg.EXECUTION_ENABLED || paperModeActive) && state.tradingEnabled && !playbookBlocks && circuitOk && !lowSolPaused && capOk;
      const executionAllowedReason = !(cfg.EXECUTION_ENABLED || paperModeActive) ? 'cfgExecutionOff'
        : (!state.tradingEnabled ? 'stateTradingOff'
          : (playbookBlocks ? 'playbookDegraded'
            : (!circuitOk ? 'circuitOpen' : (lowSolPaused ? 'lowSolPause' : (!capOk ? 'maxPositionsHysteresis' : null)))));
      const watchlistRows = watchlistEntriesPrioritized({ state, cfg, limit: cfg.LIVE_CANDIDATE_SHORTLIST_N, nowMs: t });

      let solUsdNow = lastSolUsd || solUsd || null;
      if (!solUsdNow || (t - lastSolUsdAt) > 5 * 60_000) {
        try {
          solUsdNow = (await getSolUsdPrice()).solUsd;
          lastSolUsd = solUsdNow;
          lastSolUsdAt = t;
        } catch {}
      }

      await evaluateWatchlistRows({
        rows: watchlistRows,
        cfg,
        state,
        counters,
        nowMs: t,
        executionAllowed,
        executionAllowedReason,
        solUsdNow,
        conn,
        pub,
        wallet,
        birdseye,
      });
    }

    // Periodic rejection summary (debug)
    const rejEnabled = state.debug?.rejections ?? cfg.DEBUG_REJECTIONS;
    const rejEveryMs = state.debug?.rejectionsEveryMs ?? cfg.DEBUG_REJECTIONS_EVERY_MS;
    if (rejEnabled && t - lastRej >= rejEveryMs) {
      lastRej = t;
      const { snap, next } = snapshotAndReset(counters);
      counters = next;
      state.runtime.diagCounters = counters;
      const msg = [
        `DEBUG 📊 scanner summary (last ${(rejEveryMs/60000).toFixed(0)}m)`,
        `scanned=${snap.scanned} consideredPairs=${snap.consideredPairs}`,
        `reject(noPair)=${snap.reject.noPair}`,
        `reject(noPair.providerEmpty)=${snap.reject.noPairReasons?.providerEmpty ?? 0}`,
        `reject(noPair.rateLimited)=${snap.reject.noPairReasons?.rateLimited ?? 0}`,
        `reject(noPair.routeNotFound)=${snap.reject.noPairReasons?.routeNotFound ?? 0}`,
        `reject(noPair.nonTradableMint)=${snap.reject.noPairReasons?.nonTradableMint ?? 0}`,
        `reject(noPair.deadMint)=${snap.reject.noPairReasons?.deadMint ?? 0}`,
        `reject(noPair.routeableNoMarketData)=${snap.reject.noPairReasons?.routeableNoMarketData ?? 0}`,
        `reject(noPair.providerCooldown)=${snap.reject.noPairReasons?.providerCooldown ?? 0}`,
        `reject(noPair.staleData)=${snap.reject.noPairReasons?.staleData ?? 0}`,
        `reject(noPair.retriesExhausted)=${snap.reject.noPairReasons?.retriesExhausted ?? 0}`,
        `route(prefilterChecks)=${snap.route?.prefilterChecks ?? 0}`,
        `route(prefilterRouteable)=${snap.route?.prefilterRouteable ?? 0}`,
        `route(prefilterRejected)=${snap.route?.prefilterRejected ?? 0}`,
        `route(shortlistPrefilter pass/drop)=${snap.route?.shortlistPrefilterPassed ?? 0}/${snap.route?.shortlistPrefilterDropped ?? 0}`,
        `route(tempSkips/revisits/deadSkips)=${snap.route?.noPairTempSkips ?? 0}/${snap.route?.noPairTempRevisits ?? 0}/${snap.route?.deadMintSkips ?? 0}`,
        `route(routeAvailable seen/promoted)=${snap.route?.routeAvailableSeen ?? 0}/${snap.route?.routeAvailablePromotedToWatchlist ?? 0}`,
        `route(routeAvailable dropped)=${Object.entries(snap.route?.routeAvailableDropped || {}).filter(([, v]) => Number(v || 0) > 0).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
        `reject(baseFilters)=${snap.reject.baseFilters}`,
        `reject(rugcheckFetch)=${snap.reject.rugcheckFetch}`,
        `reject(rugUnsafe)=${snap.reject.rugUnsafe}`,
        `reject(mcapFetch)=${snap.reject.mcapFetch}`,
        `reject(mcapLowOrMissing)=${snap.reject.mcapLowOrMissing}`,
        `reject(momentum)=${snap.reject.momentum}`,
        `reject(noSocialMeta)=${snap.reject.noSocialMeta}`,
        `reject(alreadyOpen)=${snap.reject.alreadyOpen}`,
        `reject(lowSolFees)=${snap.reject.lowSolFees}`,
        `reject(swapError)=${snap.reject.swapError}`,
      ].join('\n');
      await tgSend(cfg, msg);
    }

    // SOLUSD refresh periodically
    let solPrice;
    try {
      solPrice = (await getSolUsdPrice()).solUsd;
    } catch {
      solPrice = null;
    }

    // Portfolio stop checks (RPC can be flaky; never crash on transient failure)
    if (solPrice) {
      try {
        const stopInfo = await shouldStopPortfolio(cfg, conn, pub, state, solPrice);
        if (stopInfo.stop) {
          // One-time alert + latch, to prevent Telegram spam loops.
          state.flags ||= {};
          state.flags.portfolioStopActive = true;
          state.flags.portfolioStopReason = stopInfo.reason;
          state.flags.portfolioStopAtIso = nowIso();
          state.flags.lastPortfolioStopAlertAtMs ||= 0;

          state.tradingEnabled = false;

          if (t - state.flags.lastPortfolioStopAlertAtMs > 60 * 60_000) {
            state.flags.lastPortfolioStopAlertAtMs = t;
            await tgSend(cfg, `🛑 Trading halted: ${stopInfo.reason}`);
          }

          saveState(cfg.STATE_PATH, state);
          // Do NOT throw; keep process alive for monitoring/controls.
          continue;
        }
        circuitClear({ state, nowMs: t, dep: 'rpc', persist: () => saveState(cfg.STATE_PATH, state) });
      } catch (e) {
        // RPC failure. Hit circuit breaker and alert (rate-limited), but do not hard-toggle tradingEnabled.
        if (cfg.PLAYBOOK_ENABLED) {
          recordPlaybookError({ state, nowMs: t, kind: 'rpc_error', note: safeErr(e).message });
        }
        circuitHit({ state, nowMs: t, dep: 'rpc', note: `portfolioCheck(${safeErr(e).message})`, persist: () => saveState(cfg.STATE_PATH, state) });
        if (t - lastRpcAlertAt > 10 * 60_000) {
          lastRpcAlertAt = t;
          await tgSend(cfg, `⚠️ RPC/balance check failed. Pausing entries until it recovers. (${safeErr(e).message})`);
        }
      }
    }

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
      let scanCandidatesFound = 0;
      let scanPairFetchCalls = 0;
      let scanBirdeyeCalls = 0;
      let scanRpcCalls = 0;
      let scanPairFetchConcurrency = Math.max(1, Math.min(8, Number(cfg.PAIR_FETCH_CONCURRENCY || 1)));
      let scanJupCooldownActive = false;
      let scanJupCooldownRemainingMs = 0;
      let scanRoutePrefilterDegraded = false;
      let scanUsableSnapshotWithoutPairCount = 0;
      let scanNoPairTempActiveCount = 0;
      let scanNoPairTempRevisitCount = 0;
      let scanMaxSingleCallDurationMs = 0;
      const scanPhase = {
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
      };
      const markCallDuration = (startedAtMs, kind = null) => {
        const d = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
        if (d > scanMaxSingleCallDurationMs) scanMaxSingleCallDurationMs = d;
        if (kind === 'rpc') scanPhase.rpcMs += d;
      };
      nextScanDelayMs = computeAdaptiveScanDelayMs({
        state,
        nowMs: t,
        baseScanMs: cfg.SCAN_EVERY_MS,
        maxScanMs: cfg.SCAN_BACKOFF_MAX_MS,
      });

      const pushScanCompactEvent = (kind, extra = {}) => {
        counters.watchlist ||= {};
        counters.watchlist.compactWindow ||= {};
        const w = counters.watchlist.compactWindow;
        const now = Date.now();
        const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
        const cutoff = now - retainMs;
        if (kind === 'candidateSeen') {
          if (!Array.isArray(w.candidateSeen)) w.candidateSeen = [];
          w.candidateSeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
          while (w.candidateSeen.length && Number(w.candidateSeen[0]?.tMs || 0) < cutoff) w.candidateSeen.shift();
          try { appendJsonl(path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl'), { tMs: now, kind: 'candidateSeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } }); } catch {}
          return;
        }
        if (kind === 'candidateRouteable') {
          if (!Array.isArray(w.candidateRouteable)) w.candidateRouteable = [];
          w.candidateRouteable.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
          while (w.candidateRouteable.length && Number(w.candidateRouteable[0]?.tMs || 0) < cutoff) w.candidateRouteable.shift();
          try { appendJsonl(path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl'), { tMs: now, kind: 'candidateRouteable', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } }); } catch {}
          return;
        }
        if (kind === 'candidateLiquiditySeen') {
          if (!Array.isArray(w.candidateLiquiditySeen)) w.candidateLiquiditySeen = [];
          w.candidateLiquiditySeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
          while (w.candidateLiquiditySeen.length && Number(w.candidateLiquiditySeen[0]?.tMs || 0) < cutoff) w.candidateLiquiditySeen.shift();
          try { appendJsonl(path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl'), { tMs: now, kind: 'candidateLiquiditySeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) } }); } catch {}
        }
      };

      const finalizeScanTelemetry = () => {
        const scanDurationMs = Math.max(0, Date.now() - scanCycleStartedAtMs);
        const watchlistIngestPerScan = Math.max(0, Number(counters?.watchlist?.ingested || 0) - scanWatchlistIngestStart);
        scanPairFetchCalls = Math.max(0, Number(counters?.pairFetch?.started || 0) - scanPairFetchStart);
        scanBirdeyeCalls = Math.max(0, Number(state?.marketData?.providers?.birdeye?.requests || 0) - scanBirdeyeReqStart);
        counters.scanDurationMsTotal = Number(counters.scanDurationMsTotal || 0) + scanDurationMs;
        counters.scanDurationSamples = Number(counters.scanDurationSamples || 0) + 1;
        counters.scanCandidatesFoundTotal = Number(counters.scanCandidatesFoundTotal || 0) + Number(scanCandidatesFound || 0);
        counters.scanWatchlistIngestTotal = Number(counters.scanWatchlistIngestTotal || 0) + watchlistIngestPerScan;

        counters.watchlist ||= {};
        counters.watchlist.compactWindow ||= {};
        const w = counters.watchlist.compactWindow;
        if (!Array.isArray(w.scanCycles)) w.scanCycles = [];
        const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
        const cutoff = Date.now() - retainMs;
        scanPhase.candidateOtherMs = Math.max(0,
          Number(scanPhase.candidateDiscoveryMs || 0)
          - Number(scanPhase.candidateSourcePollingMs || 0)
          - Number(scanPhase.candidateSourceMergingMs || 0)
          - Number(scanPhase.candidateSourceTransformsMs || 0)
          - Number(scanPhase.candidateStreamDrainMs || 0)
          - Number(scanPhase.candidateTokenlistFetchMs || 0)
          - Number(scanPhase.candidateTokenlistPoolBuildMs || 0)
          - Number(scanPhase.candidateTokenlistSamplingMs || 0)
          - Number(scanPhase.candidateTokenlistQuoteabilityChecksMs || 0)
          - Number(scanPhase.candidateDedupeMs || 0)
          - Number(scanPhase.candidateIterationMs || 0)
          - Number(scanPhase.candidateStateLookupMs || 0)
          - Number(scanPhase.candidateCacheReadsMs || 0)
          - Number(scanPhase.candidateCacheWritesMs || 0)
          - Number(scanPhase.candidateFilterLoopsMs || 0)
          - Number(scanPhase.candidateAsyncWaitUnclassifiedMs || 0)
          - Number(scanPhase.candidateCooldownFilteringMs || 0)
          - Number(scanPhase.candidateShortlistPrefilterMs || 0)
          - Number(scanPhase.candidateRouteabilityChecksMs || 0));
        scanPhase.snapshotOtherMs = Math.max(0,
          Number(scanPhase.snapshotBuildMs || 0)
          - Number(scanPhase.snapshotBirdseyeFetchMs || 0)
          - Number(scanPhase.snapshotPairEnrichmentMs || 0)
          - Number(scanPhase.snapshotLiqMcapNormalizationMs || 0)
          - Number(scanPhase.snapshotValidationMs || 0)
          - Number(scanPhase.snapshotWatchlistRowConstructionMs || 0));
        const totalWorkMs = Number(scanPhase.candidateDiscoveryMs || 0)
          + Number(scanPhase.routePrepMs || 0)
          + Number(scanPhase.pairFetchMs || 0)
          + Number(scanPhase.birdeyeMs || 0)
          + Number(scanPhase.rpcMs || 0)
          + Number(scanPhase.snapshotBuildMs || 0)
          + Number(scanPhase.shortlistMs || 0)
          + Number(scanPhase.watchlistWriteMs || 0);
        const scanCycleEvent = {
          tMs: Date.now(),
          intervalMs: Number.isFinite(Number(scanIntervalMs)) ? Number(scanIntervalMs) : null,
          durationMs: scanDurationMs,
          candidatesFound: Number(scanCandidatesFound || 0),
          watchlistIngest: watchlistIngestPerScan,
          pairFetchCalls: Number(scanPairFetchCalls || 0),
          pairFetchConcurrency: Number(scanPairFetchConcurrency || 1),
          birdeyeCalls: Number(scanBirdeyeCalls || 0),
          rpcCalls: Number(scanRpcCalls || 0),
          jupCooldownActive: !!scanJupCooldownActive,
          jupCooldownRemainingMs: Number(scanJupCooldownRemainingMs || 0),
          degradedRoutePrefilterMode: !!scanRoutePrefilterDegraded,
          usableSnapshotWithoutPairCount: Number(scanUsableSnapshotWithoutPairCount || 0),
          noPairTempActiveCount: Number(scanNoPairTempActiveCount || 0),
          noPairTempRevisitCount: Number(scanNoPairTempRevisitCount || 0),
          maxSingleCallDurationMs: Number(scanMaxSingleCallDurationMs || 0),
          candidateDiscoveryMs: Number(scanPhase.candidateDiscoveryMs || 0),
          candidateSourcePollingMs: Number(scanPhase.candidateSourcePollingMs || 0),
          candidateSourceMergingMs: Number(scanPhase.candidateSourceMergingMs || 0),
          candidateSourceTransformsMs: Number(scanPhase.candidateSourceTransformsMs || 0),
          candidateStreamDrainMs: Number(scanPhase.candidateStreamDrainMs || 0),
          candidateTokenlistFetchMs: Number(scanPhase.candidateTokenlistFetchMs || 0),
          candidateTokenlistPoolBuildMs: Number(scanPhase.candidateTokenlistPoolBuildMs || 0),
          candidateTokenlistSamplingMs: Number(scanPhase.candidateTokenlistSamplingMs || 0),
          candidateTokenlistQuoteabilityChecksMs: Number(scanPhase.candidateTokenlistQuoteabilityChecksMs || 0),
          tokenlistCandidatesFilteredByLiquidity: Number(scanPhase.tokenlistCandidatesFilteredByLiquidity || 0),
          tokenlistQuoteChecksPerformed: Number(scanPhase.tokenlistQuoteChecksPerformed || 0),
          tokenlistQuoteChecksSkipped: Number(scanPhase.tokenlistQuoteChecksSkipped || 0),
          candidateDedupeMs: Number(scanPhase.candidateDedupeMs || 0),
          candidateIterationMs: Number(scanPhase.candidateIterationMs || 0),
          candidateStateLookupMs: Number(scanPhase.candidateStateLookupMs || 0),
          candidateCacheReadsMs: Number(scanPhase.candidateCacheReadsMs || 0),
          candidateCacheWritesMs: Number(scanPhase.candidateCacheWritesMs || 0),
          candidateFilterLoopsMs: Number(scanPhase.candidateFilterLoopsMs || 0),
          candidateAsyncWaitUnclassifiedMs: Number(scanPhase.candidateAsyncWaitUnclassifiedMs || 0),
          candidateCooldownFilteringMs: Number(scanPhase.candidateCooldownFilteringMs || 0),
          candidateShortlistPrefilterMs: Number(scanPhase.candidateShortlistPrefilterMs || 0),
          candidateRouteabilityChecksMs: Number(scanPhase.candidateRouteabilityChecksMs || 0),
          candidateOtherMs: Number(scanPhase.candidateOtherMs || 0),
          routePrepMs: Number(scanPhase.routePrepMs || 0),
          pairFetchMs: Number(scanPhase.pairFetchMs || 0),
          birdeyeMs: Number(scanPhase.birdeyeMs || 0),
          rpcMs: Number(scanPhase.rpcMs || 0),
          snapshotBuildMs: Number(scanPhase.snapshotBuildMs || 0),
          snapshotBirdseyeFetchMs: Number(scanPhase.snapshotBirdseyeFetchMs || 0),
          snapshotPairEnrichmentMs: Number(scanPhase.snapshotPairEnrichmentMs || 0),
          snapshotLiqMcapNormalizationMs: Number(scanPhase.snapshotLiqMcapNormalizationMs || 0),
          snapshotValidationMs: Number(scanPhase.snapshotValidationMs || 0),
          snapshotWatchlistRowConstructionMs: Number(scanPhase.snapshotWatchlistRowConstructionMs || 0),
          snapshotOtherMs: Number(scanPhase.snapshotOtherMs || 0),
          shortlistMs: Number(scanPhase.shortlistMs || 0),
          watchlistWriteMs: Number(scanPhase.watchlistWriteMs || 0),
          adaptiveDelayMs: Number(nextScanDelayMs || 0),
          totalWorkMs: Number(totalWorkMs || 0),
          totalCycleMs: Number(scanDurationMs || 0),
          scanAggregateTaskMs: Number(totalWorkMs || 0),
          scanWallClockMs: Number(scanDurationMs || 0),
        };
        w.scanCycles.push(scanCycleEvent);
        while (w.scanCycles.length && Number(w.scanCycles[0]?.tMs || 0) < cutoff) w.scanCycles.shift();
        try { appendJsonl(path.join(path.dirname(cfg.STATE_PATH), 'diag_events.jsonl'), { tMs: Number(scanCycleEvent.tMs || Date.now()), kind: 'scanCycle', reason: null, extra: { ...scanCycleEvent } }); } catch {}
      };

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
      } catch (e) {
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
            markCallDuration(_tSol);
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
        scanRpcCalls += 1;
        const solLam = await getSolBalanceLamports(conn, pub);
        markCallDuration(_tBal, 'rpc');
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
              scanCandidatesFound,
              scanPairFetchConcurrency,
              scanJupCooldownActive,
              scanJupCooldownRemainingMs,
              scanRoutePrefilterDegraded,
              scanUsableSnapshotWithoutPairCount,
              scanNoPairTempActiveCount,
              scanNoPairTempRevisitCount,
            },
            pushScanCompactEvent,
          });

          if (scanPipelineResult?.scanState) {
            ({
              scanCandidatesFound,
              scanPairFetchConcurrency,
              scanJupCooldownActive,
              scanJupCooldownRemainingMs,
              scanRoutePrefilterDegraded,
              scanUsableSnapshotWithoutPairCount,
              scanNoPairTempActiveCount,
              scanNoPairTempRevisitCount,
            } = scanPipelineResult.scanState);
          }

          if (scanPipelineResult?.skipCycle) {
            continue;
          }

          const {
            preCandidates,
            probeEnabled,
            probeShortlist,
            executionAllowed,
            executionAllowedReason,
            routeAvailableImmediateRows,
          } = scanPipelineResult;

          const _tWatchlistWrite = Date.now();
          if (cfg.WATCHLIST_TRIGGER_MODE) {
            const immediateRows = [...routeAvailableImmediateRows];
            const immediateRowMints = new Set(routeAvailableImmediateRows.map(([mint]) => mint));
            for (const { tok, mint, pair, snapshot, routeHint } of probeShortlist) {
              const _tRowBuild = Date.now();
              await upsertWatchlistMint({ state, cfg, nowMs: t, tok, mint, pair, snapshot, counters, routeHint, birdseye });
              scanPhase.snapshotWatchlistRowConstructionMs += Math.max(0, Date.now() - _tRowBuild);
              if (routeHint === true) {
                const row = state.watchlist?.mints?.[mint] || null;
                const dedupMs = Number(cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS || 0);
                const lastImmediateAtMs = Number(row?.lastImmediateEvalAtMs || 0);
                const dedupPass = cfg.CONVERSION_CANARY_MODE ? true : (dedupMs <= 0 || (t - lastImmediateAtMs) >= dedupMs);
                if (row && dedupPass && !immediateRowMints.has(mint)) {
                  immediateRows.push([mint, row, true]);
                  immediateRowMints.add(mint);
                  row.lastImmediateEvalAtMs = t;
                  counters.watchlist.immediateRoutePromoted += 1;
                }
              }
            }
            evictWatchlist({ state, cfg, nowMs: t, counters });
            const immediateCap = Math.max(0, Math.min(cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE, cfg.LIVE_CANDIDATE_SHORTLIST_N));
            if (immediateCap > 0 && immediateRows.length > 0) {
              const selectedRows = immediateRows.slice(0, immediateCap);
              let canary = null;
              let rowsForEval = selectedRows;
              const canaryEnabled = cfg.CONVERSION_CANARY_MODE || cfg.DEBUG_CANARY_ENABLED;
              if (canaryEnabled) {
                state.debug ||= {};
                state.debug.canary ||= { mint: null, lastRunAtMs: 0, latest: null };
                const canaryState = state.debug.canary;
                const canaryCooldownMs = cfg.CONVERSION_CANARY_MODE ? cfg.CONVERSION_CANARY_COOLDOWN_MS : cfg.DEBUG_CANARY_COOLDOWN_MS;
                const canaryEligible = [...selectedRows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
                if (canaryEligible.length > 0 && (t - Number(canaryState.lastRunAtMs || 0)) >= canaryCooldownMs) {
                  const chosen = canaryEligible[0][0];
                  canaryState.mint = chosen;
                  canaryState.lastRunAtMs = t;
                  let emitted = false;
                  const recordOnce = (stage, reason, mint, meta = null) => {
                    if (emitted) return;
                    emitted = true;
                    emitCanaryCycleEvent({ cfg, state, mint, stage, reason, nowMs: t, meta });
                  };
                  const record = (stage, reason, mint, meta = null) => {
                    emitCanaryCycleEvent({ cfg, state, mint, stage, reason, nowMs: t, meta });
                  };
                  canary = { enabled: true, verbose: cfg.DEBUG_CANARY_VERBOSE, mint: chosen, recordOnce, record };
                  pushDebug(state, { t: nowIso(), mint: chosen, symbol: state.watchlist?.mints?.[chosen]?.pair?.baseToken?.symbol || null, reason: `canary:selected(executionAllowed=${executionAllowed ? 1 : 0})` });
                  if (cfg.CONVERSION_CANARY_MODE) {
                    rowsForEval = canaryEligible.filter(([mint]) => mint === chosen);
                  }
                } else if (cfg.CONVERSION_CANARY_MODE) {
                  emitCanaryCycleEvent({ cfg, state, mint: null, stage: 'select', reason: 'cooldownOrNoEligible', nowMs: t });
                }
              }
              await evaluateWatchlistRows({
                rows: rowsForEval,
                cfg,
                state,
                counters,
                nowMs: t,
                executionAllowed,
                executionAllowedReason,
                solUsdNow,
                conn,
                pub,
                wallet,
                birdseye,
                immediateMode: true,
                canary,
              });
            } else if (cfg.CONVERSION_CANARY_MODE) {
              emitCanaryCycleEvent({ cfg, state, mint: null, stage: 'select', reason: immediateCap <= 0 ? 'immediateDisabled' : 'noRouteAvailableCandidates', nowMs: t });
            }
            saveState(cfg.STATE_PATH, state);
            scanPhase.watchlistWriteMs += Math.max(0, Date.now() - _tWatchlistWrite);
            continue;
          }
          scanPhase.watchlistWriteMs += Math.max(0, Date.now() - _tWatchlistWrite);

          for (const { tok, mint, pair, snapshot } of probeShortlist) {
            counters.scanned++;
            const candidateSource = normalizeCandidateSource(tok?._source || 'dex');
            bumpSourceCounter(counters, candidateSource, 'considered');
            if (executionAllowed && cfg.SCANNER_ENTRIES_ENABLED && !entryCapacityAvailable(state, cfg)) break;

            if (state.positions[mint]?.status === 'open') {
              bump(counters, 'reject.alreadyOpen');
              continue;
            }

            counters.consideredPairs++;
            counters.funnel.signals += 1;
            if (probeEnabled) counters.funnel.probeShortlist += 1;

            // Candidate ledger baseline (log once per candidate with final outcome)
            const createdAt = Number(pair?.pairCreatedAt || 0);
            const ageHours = createdAt ? (Date.now() - createdAt) / 1000 / 3600 : null;
            const liqUsd0 = Number(pair?.liquidity?.usd || 0);
            const v1h0 = Number(pair?.volume?.h1 || 0);
            const v4h0 = Number(pair?.volume?.h4 || 0);
            const buys1h0 = Number(pair?.txns?.h1?.buys || 0);
            const sells1h0 = Number(pair?.txns?.h1?.sells || 0);
            const tx1h0 = buys1h0 + sells1h0;
            const pc1h0 = Number(pair?.priceChange?.h1 || 0);
            const pc4h0 = Number(pair?.priceChange?.h4 || 0);

            const baseEvent = {
              t: nowIso(),
              bot: 'candle-carl',
              mint,
              symbol: pair?.baseToken?.symbol || tok?.tokenSymbol || null,
              source: tok?._source || 'dex',
              marketDataSource: snapshot?.source || null,
              marketDataFreshnessMs: snapshot?.freshnessMs ?? null,
              marketDataConfidence: snapshot?.confidence || null,
              priceUsd: Number(snapshot?.priceUsd || pair?.priceUsd || 0) || null,
              liqUsd: liqUsd0,
              ageHours,
              mcapUsd: null,
              rugScore: null,
              v1h: v1h0,
              v4h: v4h0,
              buys1h: buys1h0,
              sells1h: sells1h0,
              tx1h: tx1h0,
              pc1h: pc1h0,
              pc4h: pc4h0,
              outcome: null,
              reason: null,
            };

            const entryUnsafeReason = getEntrySnapshotUnsafeReason(snapshot);
            if (entryUnsafeReason) {
              bump(counters, 'reject.baseFilters');
              markMarketDataRejectImpact(state, snapshot?.source);
              pushDebug(state, {
                t: nowIso(),
                mint,
                symbol: pair?.baseToken?.symbol,
                reason: `marketData(${entryUnsafeReason} src=${snapshot?.source} conf=${snapshot?.confidence} freshMs=${snapshot?.freshnessMs})`,
              });
              logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: `marketData(${entryUnsafeReason})` } });
              continue;
            }

            const holders = Number(snapshot?.entryHints?.participation?.holders ?? pair?.participation?.holders ?? tok?.holders ?? 0) || null;
            const pairCreatedAtForHolders = Number(pair?.pairCreatedAt || 0) || null;
            const poolAgeSecForHolders = pairCreatedAtForHolders ? Math.max(0, (Date.now() - pairCreatedAtForHolders) / 1000) : null;
            const holdersGate = holdersGateCheck({ cfg, holders, poolAgeSec: poolAgeSecForHolders });
            if (!holdersGate.ok) {
              bump(counters, 'reject.baseFilters');
              pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: holdersGate.reason, holders, poolAgeSec: poolAgeSecForHolders, requiredHolders: holdersGate.required });
              logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: holdersGate.reason } });
              continue;
            }

            // Pass 1: always persist candidate capture once it reaches evaluation,
            // regardless of execution gate state.
            logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'seen', reason: 'evaluated' } });

            if (state.positions[mint]?.status === 'open') {
              bump(counters, 'reject.alreadyOpen');
              logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: 'alreadyOpen' } });
              continue;
            }

            const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
            const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;

            const base = passesBaseFilters({
              pair,
              // Only enforce absolute floor here; ratio check happens after mcap is known.
              minLiquidityUsd: effLiqFloor,
              minAgeHours: effMinAge,
            });
            if (cfg.BASE_FILTERS_ENABLED && !base.ok) {
              bump(counters, 'reject.baseFilters');
              pushDebug(state, {
                t: nowIso(),
                mint,
                symbol: pair?.baseToken?.symbol,
                reason: `baseFilters(${base.reason})`,
                liqUsd: pair?.liquidity?.usd,
                createdAt: pair?.pairCreatedAt,
              });
              logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: `baseFilters(${base.reason})` } });
              continue;
            }

            let report = null;
            if (cfg.RUGCHECK_ENABLED) {
              try {
                report = await getRugcheckReport(mint);
              } catch {
                bump(counters, 'reject.rugcheckFetch');
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'rugcheckFetch(failed)' });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: 'rugcheckFetch(failed)' } });
                continue;
              }
              const safe = isTokenSafe(report);
              if (!safe.ok) {
                bump(counters, 'reject.rugUnsafe');
                pushDebug(state, {
                  t: nowIso(),
                  mint,
                  symbol: pair?.baseToken?.symbol,
                  reason: `rugUnsafe(${safe.reason})`,
                  rugScore: report?.score_normalised,
                  mintAuthority: !!report?.mintAuthority,
                  freezeAuthority: !!report?.freezeAuthority,
                });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, outcome: 'reject', reason: `rugUnsafe(${safe.reason})` } });
                continue;
              }
            }

            // Market cap gate (optional)
            let mcap = { ok: true, reason: 'skipped', mcapUsd: null, decimals: null };
            if (cfg.MCAP_FILTER_ENABLED || cfg.LIQ_RATIO_FILTER_ENABLED) {
              try {
                mcap = await computeMcapUsd(cfg, pair, cfg.SOLANA_RPC_URL);
              } catch {
                bump(counters, 'reject.mcapFetch');
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'mcapFetch(failed)' });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, outcome: 'reject', reason: 'mcapFetch(failed)' } });
                continue;
              }
            }

            const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
            if (cfg.MCAP_FILTER_ENABLED) {
              if (!mcap.ok || !mcap.mcapUsd || mcap.mcapUsd < effMinMcap) {
                bump(counters, 'reject.mcapLowOrMissing');
                pushDebug(state, {
                  t: nowIso(),
                  mint,
                  symbol: pair?.baseToken?.symbol,
                  reason: `mcap(${mcap.reason})`,
                  mcapUsd: mcap.mcapUsd,
                  minMcapUsd: effMinMcap,
                });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `mcap(<${effMinMcap})` } });
                continue;
              }
            }

            // Dynamic liquidity requirement: liq >= max(floor, ratio * mcap)
            const liqUsd = Number(pair?.liquidity?.usd || 0);
            const effRatio = state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO;
            const reqLiq = Math.max(effLiqFloor, effRatio * (mcap?.mcapUsd || 0));
            if (cfg.LIQ_RATIO_FILTER_ENABLED && liqUsd < reqLiq) {
              bump(counters, 'reject.baseFilters');
              pushDebug(state, {
                t: nowIso(),
                mint,
                symbol: pair?.baseToken?.symbol,
                reason: `liq<req (liq=${Math.round(liqUsd)} req=${Math.round(reqLiq)} ratio=${effRatio})`,
                liqUsd,
                mcapUsd: mcap.mcapUsd,
              });
              logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `liq<req (liq=${Math.round(liqUsd)} req=${Math.round(reqLiq)} ratio=${effRatio})` } });
              continue;
            }

            // Two-tier momentum: thinner liquidity requires stricter confirmation.
            const useStrict = !cfg.AGGRESSIVE_MODE && liqUsd > 0 && liqUsd < cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD;
            const sig = evaluateMomentumSignal(pair, { profile: cfg.MOMENTUM_PROFILE, strict: useStrict });
            const momentumLiqGuardrail = Number(sig?.reasons?.momentumLiqGuardrailUsd || 60000);
            counters.watchlist.momentumLiqGuardrail = momentumLiqGuardrail;
            if (liqUsd >= momentumLiqGuardrail) counters.watchlist.momentumLiqCandidatesAboveGuardrail = Number(counters.watchlist.momentumLiqCandidatesAboveGuardrail || 0) + 1;
            else counters.watchlist.momentumLiqCandidatesBelowGuardrail = Number(counters.watchlist.momentumLiqCandidatesBelowGuardrail || 0) + 1;
            let signalTrigger = 'standard';
            if (cfg.MOMENTUM_FILTER_ENABLED && !sig.ok) {
              let fallbackUsed = false;
              if (cfg.MOMENTUM_FALLBACK_ENABLED && canUseMomentumFallback(sig, { tolerance: cfg.MOMENTUM_FALLBACK_TOLERANCE })) {
                const tx1hFallback = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
                const strongLiq = liqUsd >= cfg.MOMENTUM_FALLBACK_MIN_LIQ_USD;
                const strongTx = tx1hFallback >= cfg.MOMENTUM_FALLBACK_MIN_TX1H;
                if (strongLiq && strongTx) {
                  try {
                    const probeLamports = toBaseUnits((Math.max(1, cfg.JUP_PREFILTER_AMOUNT_USD) / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                    const fallbackRoute = await getRouteQuoteWithFallback({
                      cfg,
                      mint,
                      amountLamports: probeLamports,
                      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                      solUsdNow,
                      source: 'momentum-fallback',
                    });
                    const routeableFallback = !!fallbackRoute.routeAvailable;
                    if (routeableFallback) {
                      fallbackUsed = true;
                      signalTrigger = 'fallback';
                      counters.funnel.signalFallbackPass += 1;
                    }
                  } catch {
                    // keep hard reject path below
                  }
                }
              }

              if (!fallbackUsed) {
                bump(counters, 'reject.momentum');
                pushDebug(state, {
                  t: nowIso(),
                  mint,
                  symbol: pair?.baseToken?.symbol,
                  reason: 'momentum(false)',
                  v1h: sig.reasons?.v1h,
                  v4h: sig.reasons?.v4h,
                  buys1h: sig.reasons?.buys1h,
                  sells1h: sig.reasons?.sells1h,
                  pc1h: sig.reasons?.pc1h,
                  pc4h: sig.reasons?.pc4h,
                  tx1h: sig.reasons?.tx1h,
                });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `momentum(false)${useStrict ? '[strict]' : ''}` } });
                continue;
              }
            }

            // Optional Social proxy: require some metadata link/desc
            if (cfg.REQUIRE_SOCIAL_META) {
              if (!tok.description && !tok.links && !tok.url) {
                bump(counters, 'reject.noSocialMeta');
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'noSocialMeta' });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: 'noSocialMeta' } });
                continue;
              }
            }

            try {
              const candidate = {
                mint,
                symbol: pair?.baseToken?.symbol,
                priceUsd: Number(pair?.priceUsd || 0),
                liqUsd,
                mcapUsd: mcap.mcapUsd,
                ageHours: (Date.now() - Number(pair?.pairCreatedAt || Date.now())) / 1000 / 3600,
                rugScore: report?.score_normalised,
                momentum: sig.reasons,
                signalTrigger,
                filters: {
                  liqFloor: effLiqFloor,
                  liqRatio: effRatio,
                  minMcap: effMinMcap,
                  minAge: effMinAge,
                },
              };

              // If AI pipeline is disabled, trade purely on deterministic filters + momentum.
              let sizeMultiplier = 1;
              let slippageBps = cfg.DEFAULT_SLIPPAGE_BPS;
              let pre = null;
              let analysis = null;

              if (cfg.AI_PIPELINE_ENABLED) {
                const models = getModels(cfg, state);

                const preRes = await preprocessCandidate({ model: models.preprocess, candidate });
                appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
                  t: nowIso(), bot: 'candle-carl', op: 'preprocess', model: models.preprocess,
                  inputTokens: preRes.usage?.input_tokens ?? null,
                  outputTokens: preRes.usage?.output_tokens ?? null,
                  costUsd: estimateCostUsd({ model: models.preprocess, inputTokens: preRes.usage?.input_tokens || 0, outputTokens: preRes.usage?.output_tokens || 0 }),
                }});
                pre = preRes.json;

                const analysisRes = await analyzeTrade({
                  model: models.analyze,
                  context: {
                    candidate,
                    preprocess: pre,
                    openPositions: Object.values(state.positions || {}).filter(p => p.status === 'open').length,
                    equityHintUsd: state.portfolio?.maxEquityUsd,
                  },
                });
                appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
                  t: nowIso(), bot: 'candle-carl', op: 'analyze', model: models.analyze,
                  inputTokens: analysisRes.usage?.input_tokens ?? null,
                  outputTokens: analysisRes.usage?.output_tokens ?? null,
                  costUsd: estimateCostUsd({ model: models.analyze, inputTokens: analysisRes.usage?.input_tokens || 0, outputTokens: analysisRes.usage?.output_tokens || 0 }),
                }});
                analysis = analysisRes.json;

                if (String(analysis.decision).toUpperCase() !== 'TRADE') {
                  const why = `ai(NO_TRADE:${analysis.note || ''})`;
                  pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
                  logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
                  continue;
                }

                sizeMultiplier = analysis.sizeMultiplier;
                slippageBps = analysis.slippageBps;
              }

              const usdTarget = cfg.MAX_POSITION_USDC * sizeMultiplier;
              const usdTargetCapped = Math.min(cfg.MAX_POSITION_USDC * 1.1, Math.max(cfg.MAX_POSITION_USDC * 0.1, usdTarget));

              // Gatekeeper (AI) gets the quote before signing.
              // NOTE: Intentionally Jupiter-only — this is an execution quote for priceImpact/outAmount display,
              // not a routeability check. The alt-route fallback (getRouteQuoteWithFallback) is used upstream
              // in the scanner pipeline; swap execution always uses Jupiter directly.
              const solLamports = toBaseUnits((usdTargetCapped / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
              const quote = await jupQuote({
                inputMint: cfg.SOL_MINT,
                outputMint: mint,
                amount: solLamports,
                slippageBps,
              });

              // Execution sanity checks (don’t enter if quote is awful)
              const route0 = quote;
              const pi = Number(route0?.priceImpactPct || 0);
              if (pi && pi > cfg.MAX_PRICE_IMPACT_PCT) {
                const why = `quote(priceImpact>${cfg.MAX_PRICE_IMPACT_PCT}%)`;
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
                logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
                continue;
              }

              // If AI pipeline is enabled, run final gatekeeper before signing.
              let finalUsdTarget = usdTargetCapped;
              let finalSlip = slippageBps;

              if (cfg.AI_PIPELINE_ENABLED) {
                const models = getModels(cfg, state);

                const gkRes = await gatekeep({
                  model: models.gatekeeper,
                  context: {
                    candidate,
                    preprocess: pre,
                    analysis,
                    quoteSummary: {
                      inAmount: solLamports,
                      outAmount: quote?.outAmount,
                      priceImpactPct: quote?.priceImpactPct,
                      routeLabel: quote?.routePlan?.[0]?.swapInfo?.label || null,
                    },
                  },
                });
                appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
                  t: nowIso(), bot: 'candle-carl', op: 'gatekeeper', model: models.gatekeeper,
                  inputTokens: gkRes.usage?.input_tokens ?? null,
                  outputTokens: gkRes.usage?.output_tokens ?? null,
                  costUsd: estimateCostUsd({ model: models.gatekeeper, inputTokens: gkRes.usage?.input_tokens || 0, outputTokens: gkRes.usage?.output_tokens || 0 }),
                }});
                const gk = gkRes.json;

                if (String(gk.decision).toUpperCase() !== 'APPROVE') {
                  const why = `gatekeeper(REJECT:${gk.note || ''})`;
                  pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
                  logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
                  continue;
                }

                finalUsdTarget = Math.min(cfg.MAX_POSITION_USDC * 1.1, cfg.MAX_POSITION_USDC * gk.sizeMultiplier);
                finalSlip = gk.slippageBps;
              }

              // Capital guardrail #1: max new entries/hour throttle.
              const throttle = canOpenNewEntry({
                state,
                nowMs: t,
                maxNewEntriesPerHour: cfg.MAX_NEW_ENTRIES_PER_HOUR,
              });
              if (!throttle.ok) {
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: throttle.reason });
                continue;
              }

              // Capital guardrail #2: soft reserve (fees + reserve + retry buffer).
              const softReserve = applySoftReserveToUsdTarget({
                solBalance: sol,
                solUsd: solUsdNow,
                usdTarget: finalUsdTarget,
                minSolForFees: cfg.MIN_SOL_FOR_FEES,
                softReserveSol: cfg.CAPITAL_SOFT_RESERVE_SOL,
                retryBufferPct: cfg.CAPITAL_RETRY_BUFFER_PCT,
              });
              if (!softReserve.ok || softReserve.adjustedUsdTarget < 1) {
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `capitalGuardrail(${softReserve.reason})` });
                continue;
              }

              finalUsdTarget = softReserve.adjustedUsdTarget;

              // Re-quote with final sizing right before execution.
              // NOTE: Intentionally Jupiter-only — must use a live Jupiter quote for the actual swap transaction.
              const solLamportsFinal = toBaseUnits((finalUsdTarget / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
              const quoteFinal = await jupQuote({
                inputMint: cfg.SOL_MINT,
                outputMint: mint,
                amount: solLamportsFinal,
                slippageBps: finalSlip,
              });
              const pi2 = Number(quoteFinal?.priceImpactPct || 0);
              const confirmMaxPi = probeEnabled ? cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT : cfg.MAX_PRICE_IMPACT_PCT;
              if (pi2 && pi2 > confirmMaxPi) {
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `quoteFinal(priceImpact>${confirmMaxPi}%)` });
                continue;
              }
              if (probeEnabled) {
                const liqConfirm = Number(pair?.liquidity?.usd || 0);
                if (!quoteFinal?.routePlan?.length || liqConfirm < cfg.LIVE_CONFIRM_MIN_LIQ_USD) {
                  pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'confirmGate(route/liquidity)' });
                  continue;
                }
              }
              const confirmGate = confirmQualityGate({ cfg, sigReasons: sig?.reasons || {}, snapshot });
              if (!confirmGate.ok) {
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: confirmGate.reason });
                continue;
              }
              counters.funnel.confirmPassed += 1;

              // Aggressive-only: if confirm gate passes, optionally force an immediate attempt (bounded + anti-thrash).
              let forcedAttempted = false;
              if (cfg.FORCE_ATTEMPT_POLICY_ACTIVE && executionAllowed) {
                counters.guardrails.forceAttempt.considered += 1;

                // State-backed rate limits (persist across restarts).
                state.forceAttemptPolicy ||= { mints: {}, global: { attempts1m: [] } };
                state.forceAttemptPolicy.mints ||= {};
                state.forceAttemptPolicy.global ||= { attempts1m: [] };
                state.forceAttemptPolicy.global.attempts1m ||= [];

                const wl = ensureWatchlistState(state);
                const wlRow = wl.mints?.[mint] || null;

                const nowMs = t;
                const pruneWindow = (arr, windowMs) => (Array.isArray(arr) ? arr.filter(x => Number(x || 0) > (nowMs - windowMs)) : []);

                const mintPolicy = state.forceAttemptPolicy.mints[mint] || { attempts1h: [], cooldownUntilMs: 0 };
                mintPolicy.attempts1h = pruneWindow(mintPolicy.attempts1h, 60 * 60_000);
                state.forceAttemptPolicy.global.attempts1m = pruneWindow(state.forceAttemptPolicy.global.attempts1m, 60_000);

                const effectiveCooldownUntil = Math.max(
                  Number(wlRow?.cooldownUntilMs || 0),
                  Number(mintPolicy.cooldownUntilMs || 0)
                );

                let blockReason = null;
                if (effectiveCooldownUntil > nowMs) {
                  blockReason = 'mintCooldown';
                } else if (mintPolicy.attempts1h.length >= cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR) {
                  blockReason = 'mintHourlyCap';
                } else if (state.forceAttemptPolicy.global.attempts1m.length >= cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE) {
                  blockReason = 'globalMinuteCap';
                }

                if (blockReason) {
                  if (blockReason === 'mintCooldown') {
                    counters.guardrails.forceAttempt.blockedMintCooldown += 1;
                    bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardMintCooldown' });
                  } else if (blockReason === 'mintHourlyCap') {
                    counters.guardrails.forceAttempt.blockedMintHourlyCap += 1;
                    bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardMintHourlyCap' });
                  } else if (blockReason === 'globalMinuteCap') {
                    counters.guardrails.forceAttempt.blockedGlobalMinuteCap += 1;
                    bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardGlobalMinuteCap' });
                  }
                } else {
                  // Execute forced attempt.
                  counters.guardrails.forceAttempt.executed += 1;
                  counters.entryAttempts += 1;
                  counters.funnel.attempts += 1;
                  if (signalTrigger === 'fallback') counters.funnel.attemptsFromFallback += 1;
                  else counters.funnel.attemptsFromStandard += 1;

                  // Record policy accounting before signing to prevent loops on slow swaps.
                  mintPolicy.attempts1h.push(nowMs);
                  mintPolicy.cooldownUntilMs = nowMs + cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS;
                  state.forceAttemptPolicy.mints[mint] = mintPolicy;
                  state.forceAttemptPolicy.global.attempts1m.push(nowMs);

                  if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: pair?.baseToken?.symbol, tag: 'scanner_forced' })) continue;
                  const decimalsHintForAttempt = [
                    mcap?.decimals,
                    pair?.baseToken?.decimals,
                    pair?.birdeye?.raw?.decimals,
                  ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
                  const entryRes = await openPosition(cfg, conn, wallet, state, solUsdNow, pair, mcap.mcapUsd, decimalsHintForAttempt, report, sig.reasons, {
                    mint,
                    tokenName: pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
                    symbol: pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
                    entrySnapshot: null,
                    birdeyeEnabled: birdseye?.enabled,
                    getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
                    usdTarget: finalUsdTarget,
                    slippageBps: finalSlip,
                    expectedOutAmount: Number(quoteFinal?.outAmount || 0),
                    expectedInAmount: Number(quoteFinal?.inAmount || 0),
                    paperOnly: paperModeActive,
                    // Apply the same stop/trailing rules as LIVE momo
                    stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
                    stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
                    trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
                    trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
                  });

                  if (entryRes?.blocked) {
                    counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
                    counters.guardrails.entryBlockedReasons ||= {};
                    counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
                    counters.guardrails.entryBlockedLast10 ||= [];
                    counters.guardrails.entryBlockedLast10.push({
                      t: nowIso(), mint, reason: String(entryRes?.reason || 'unknown'),
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
                    pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(blocked reason=${entryRes.reason}) forced=1` });
                    saveState(cfg.STATE_PATH, state);
                    continue;
                  }

                  counters.entrySuccesses += 1;
                  counters.funnel.fills += 1;
                  if (signalTrigger === 'fallback') counters.funnel.entriesFromFallback += 1;
                  else counters.funnel.entriesFromStandard += 1;
                  if (entryRes?.swapMeta?.attempted) {
                    counters.retry.slippageRetryAttempted += 1;
                    if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
                    else counters.retry.slippageRetryFailed += 1;
                  }
                  recordEntryOpened({ state, nowMs: t });

                  // Mirror watchlist-style cooldown tracking if the mint is present there.
                  if (wlRow) {
                    wlRow.lastAttemptAtMs = nowMs;
                    wlRow.attempts = Number(wlRow.attempts || 0) + 1;
                    wlRow.totalAttempts = Number(wlRow.totalAttempts || 0) + 1;
                    wlRow.cooldownUntilMs = Math.max(Number(wlRow.cooldownUntilMs || 0), mintPolicy.cooldownUntilMs);
                    if (didEntryFill(entryRes)) {
                      wlRow.lastFillAtMs = nowMs;
                      wlRow.totalFills = Number(wlRow.totalFills || 0) + 1;
                    }
                  }

                  saveState(cfg.STATE_PATH, state);
                  pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(opened${entryRes?.swapMeta?.attempted ? ` retry=${entryRes.swapMeta.reason}` : ''}) forced=1` });
                  forcedAttempted = true;
                }
              }

              // Default behavior: attempt only when scanner entries are enabled.
              if (!forcedAttempted && cfg.SCANNER_ENTRIES_ENABLED && executionAllowed) {
                counters.entryAttempts += 1;
                counters.funnel.attempts += 1;
                if (signalTrigger === 'fallback') counters.funnel.attemptsFromFallback += 1;
                else counters.funnel.attemptsFromStandard += 1;
                if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: pair?.baseToken?.symbol, tag: 'scanner_standard' })) continue;
                const decimalsHintForAttempt = [
                  mcap?.decimals,
                  pair?.baseToken?.decimals,
                  pair?.birdeye?.raw?.decimals,
                ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
                const entryRes = await openPosition(cfg, conn, wallet, state, solUsdNow, pair, mcap.mcapUsd, decimalsHintForAttempt, report, sig.reasons, {
                  mint,
                  tokenName: pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
                  symbol: pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
                  entrySnapshot: null,
                  birdeyeEnabled: birdseye?.enabled,
                  getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
                  usdTarget: finalUsdTarget,
                  slippageBps: finalSlip,
                  expectedOutAmount: Number(quoteFinal?.outAmount || 0),
                  expectedInAmount: Number(quoteFinal?.inAmount || 0),
                  paperOnly: paperModeActive,
                  // Apply the same stop/trailing rules as LIVE momo
                  stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
                  stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
                  trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
                  trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
                });

                if (entryRes?.blocked) {
                  counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
                  counters.guardrails.entryBlockedReasons ||= {};
                  counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
                  counters.guardrails.entryBlockedLast10 ||= [];
                  counters.guardrails.entryBlockedLast10.push({
                    t: nowIso(), mint, reason: String(entryRes?.reason || 'unknown'),
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
                  pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(blocked reason=${entryRes.reason})` });
                  saveState(cfg.STATE_PATH, state);
                  continue;
                }

                counters.entrySuccesses += 1;
                counters.funnel.fills += 1;
                if (signalTrigger === 'fallback') counters.funnel.entriesFromFallback += 1;
                else counters.funnel.entriesFromStandard += 1;
                if (entryRes?.swapMeta?.attempted) {
                  counters.retry.slippageRetryAttempted += 1;
                  if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
                  else counters.retry.slippageRetryFailed += 1;
                }
                recordEntryOpened({ state, nowMs: t });
                saveState(cfg.STATE_PATH, state);
                pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(opened${entryRes?.swapMeta?.attempted ? ` retry=${entryRes.swapMeta.reason}` : ''})` });
              }
              // If scanner entries or execution are disabled, we still captured/logged/tracked candidates above.
            } catch (e) {
              bump(counters, 'reject.swapError');
              if (cfg.PLAYBOOK_ENABLED) {
                recordPlaybookError({ state, nowMs: t, kind: 'swap_error', note: safeMsg(e) });
              }
              pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `swapError(${safeMsg(e)})` });
            }
          }
        }
      }
      } finally {
        finalizeScanTelemetry();
      }
    }

    await processOperatorCommands(t);

    // Check positions for exits
    if (t - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
      lastPosRef.value = t;

      for (const [mint, pos] of Object.entries(state.positions)) {
        if (pos.status !== 'open') continue;

        // Streaming-first stop enforcement: use fresh BirdEye WS tick immediately.
        try {
          const ws = cache.get(`birdeye:ws:price:${mint}`) || null;
          const wsTs = Number(ws?.tsMs || 0);
          const wsPrice = Number(ws?.priceUsd || 0);
          const wsFresh = wsTs > 0 && (Date.now() - wsTs) <= 15_000;
          if (wsFresh && wsPrice > 0 && Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(wsPrice, pos, null, cfg) <= Number(pos.stopPriceUsd)) {
            const pairWs = { baseToken: { symbol: pos?.symbol || null }, priceUsd: wsPrice, url: pos?.pairUrl || null };
            const r = pos.trailingActive
              ? `trailing stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`
              : `stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`;
            await closePosition(cfg, conn, wallet, state, mint, pairWs, r);
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch {}

        const snapshot = await getMarketSnapshot({
          state,
          mint,
          nowMs: t,
          maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS,
          preferWsPrice: true,
          getTokenPairs,
          pickBestPair,
          birdeyeEnabled: birdseye?.enabled,
          getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
        });

        let effectiveSnapshot = snapshot;
        if (!effectiveSnapshot?.priceUsd) {
          // Fallback: direct Dex fetch for open-position safety if router has no usable price.
          try {
            const pairsFallback = await getTokenPairs(mint);
            const bestFallback = pickBestPair(pairsFallback);
            const pxFallback = Number(bestFallback?.priceUsd || 0);
            if (pxFallback > 0) {
              effectiveSnapshot = {
                source: 'dex_fallback',
                confidence: 'low',
                freshnessMs: 0,
                priceUsd: pxFallback,
                pair: bestFallback,
              };
            }
          } catch {}
        }
        if (!effectiveSnapshot?.priceUsd) {
          pushDebug(state, {
            t: nowIso(),
            mint,
            symbol: pos?.symbol || null,
            reason: `positionsMarketData(skip_no_price src=${snapshot?.source || 'none'} conf=${snapshot?.confidence || 'none'} freshMs=${snapshot?.freshnessMs ?? 'n/a'})`,
          });
          continue;
        }

        const pair = effectiveSnapshot?.pair || { baseToken: { symbol: pos?.symbol || null }, priceUsd: effectiveSnapshot.priceUsd };
        const priceUsd = Number(effectiveSnapshot.priceUsd);

        const usableForTrailing = isStopSnapshotUsable(effectiveSnapshot);
        if (!usableForTrailing) {
          pushDebug(state, {
            t: nowIso(),
            mint,
            symbol: pos?.symbol || null,
            reason: `positionsMarketData(stale_ok_for_stop src=${effectiveSnapshot?.source || 'none'} conf=${effectiveSnapshot?.confidence || 'none'} freshMs=${effectiveSnapshot?.freshnessMs ?? 'n/a'})`,
          });
          if (Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= Number(pos.stopPriceUsd)) {
            const r = pos.trailingActive ? 'trailing stop hit (stale snapshot)' : 'stop loss hit (stale snapshot)';
            await closePosition(cfg, conn, wallet, state, mint, pair, r);
            saveState(cfg.STATE_PATH, state);
          }
          continue;
        }

        // Repair missing entry/stop fields if we opened a position without a valid entry snapshot.
        if (!Number.isFinite(Number(pos.entryPriceUsd)) || Number(pos.entryPriceUsd) <= 0) {
          pos.entryPriceUsd = priceUsd;
          pos.peakPriceUsd = priceUsd;
          pos.lastSeenPriceUsd = priceUsd;
          pos.stopPriceUsd = priceUsd;
          pos.lastStopUpdateAt = nowIso();
          pos.note = (pos.note || '') + ` | repairedEntryPriceFromPriceFeed`;
          const label = tokenDisplayName({ name: pos?.tokenName, symbol: pos?.symbol, mint });
          await tgSend(cfg, `🛠️ Repaired missing entry price for ${label} using live price ${priceUsd.toFixed(6)}. New stop set to ${pos.stopPriceUsd.toFixed(6)}.`);
          saveState(cfg.STATE_PATH, state);
        }

        const stopUpdate = await updateStops(cfg, state, mint, priceUsd);
        if (stopUpdate.changed) {
          await tgSend(cfg, [
            `🟣 *TRAIL UPDATE* — ${tokenDisplayName({ name: pos?.tokenName, symbol: pos?.symbol, mint })}`,
            '',
            `• New stop: $${pos.stopPriceUsd.toFixed(6)}`,
            `• Peak: $${pos.peakPriceUsd.toFixed(6)}`,
          ].join('\n'));
        }

        if (conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= pos.stopPriceUsd) {
          const r = pos.trailingActive ? 'trailing stop hit' : 'stop loss hit';
          await closePosition(cfg, conn, wallet, state, mint, pair, r);
          saveState(cfg.STATE_PATH, state);
        }
      }
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

function pruneRuntimeMaps() {
  try {
    const runtime = runtimeStateRef?.runtime;
    if (!runtime) return;
    const now = Date.now();
    const maxAgeMs = Math.max(5 * 60_000, Number(process.env.RUNTIME_MAP_MAX_AGE_MS || (6 * 60 * 60_000)));
    const maxSize = Math.max(200, Number(process.env.RUNTIME_MAP_MAX_SIZE || 5000));

    const pruneObjectMap = (obj, tsKey = 'atMs') => {
      if (!obj || typeof obj !== 'object') return 0;
      let removed = 0;
      for (const [k, v] of Object.entries(obj)) {
        const t = Number(v?.[tsKey] ?? v?.tsMs ?? v?.checkedAtMs ?? 0);
        if (t > 0 && (now - t) > maxAgeMs) { delete obj[k]; removed += 1; }
      }
      const keys = Object.keys(obj);
      if (keys.length > maxSize) {
        keys
          .sort((a, b) => Number(obj?.[a]?.[tsKey] ?? obj?.[a]?.tsMs ?? obj?.[a]?.checkedAtMs ?? 0) - Number(obj?.[b]?.[tsKey] ?? obj?.[b]?.tsMs ?? obj?.[b]?.checkedAtMs ?? 0))
          .slice(0, keys.length - maxSize)
          .forEach((k) => { delete obj[k]; removed += 1; });
      }
      return removed;
    };

    const removed = {
      mintCreatedAtCache: pruneObjectMap(runtime.mintCreatedAtCache, 'checkedAtMs'),
      confirmTxCarryByMint: pruneObjectMap(runtime.confirmTxCarryByMint, 'atMs'),
      confirmLiqTrack: pruneObjectMap(runtime.confirmLiqTrack, 'tsMs'),
      wsmgrDiag: pruneObjectMap(wsmgr?.diag, 'atMs'),
      momentumRepeatFail: pruneObjectMap(runtime.momentumRepeatFail, 'tMs'),
    };

    if (Object.values(removed).some((n) => n > 0)) {
      console.log('[mem-prune]', { removed, maxAgeMs, maxSize });
    }
  } catch (e) {
    console.log('[mem-prune] failed', safeErr(e).message);
  }
}

if (!globalTimers.memoryMonitor) {
  globalTimers.memoryMonitor = setInterval(() => {
    const m = process.memoryUsage();

    console.log("[memory]", {
      rss_mb: Math.round(m.rss / 1024 / 1024),
      heap_used_mb: Math.round(m.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(m.heapTotal / 1024 / 1024),
    external_mb: Math.round(m.external / 1024 / 1024),
  });

}, 60000);
setInterval(() => {
  try {
    pruneRuntimeMaps();
    const runtime = runtimeStateRef?.runtime || {};
    const watchlist = runtimeStateRef?.watchlist || {};

    console.log("[mem-debug]", {
      trackedMints: Object.keys(watchlist.mints || {}).length,
      hotQueue: Array.isArray(watchlist.hotQueue) ? watchlist.hotQueue.length : 0,
      routeCache: Object.keys(watchlist.routeCache || {}).length,
      mintCreatedAtCache: Object.keys(runtime.mintCreatedAtCache || {}).length,
      confirmTxCarryByMint: Object.keys(runtime.confirmTxCarryByMint || {}).length,
      confirmLiqTrack: Object.keys(runtime.confirmLiqTrack || {}).length,
      momentumRepeatFail: Object.keys(runtime.momentumRepeatFail || {}).length,
      wsmgrDiag: Object.keys(wsmgr?.diag || {}).length,
      birdEyeSubscribed: birdEyeWs?.subscribed ? Array.from(birdEyeWs.subscribed).length : 0
    });
  } catch (e) {
    console.log("[mem-debug] failed", e?.message || e);
  }
  }, 60000);
}
