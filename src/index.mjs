import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PublicKey } from '@solana/web3.js';

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
import { makeCounters, bump, bumpSourceCounter, snapshotAndReset, formatThroughputSummary, bumpWatchlistFunnel, rollWatchlistMinuteWindow } from './observability/metrics.mjs';
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
import { shouldStopPortfolio, reconcilePositions, syncExposureStateWithPositions } from './control_tower/portfolio_control.mjs';
import { createOpsReporting, createSpendSummaryCache, fmtUsd } from './control_tower/ops_reporting.mjs';
import { startWatchlistCleanupTimer, startObservabilityHeartbeatTimer, startPositionsLoopTimer } from './control_tower/runtime_timers.mjs';
import { createPositionsLoop } from './control_tower/positions_loop.mjs';
import { createDiagReporting } from './control_tower/diag_reporting.mjs';
import { appendDiagEvent, getCompactWindowForDiagRequest, getDiagEventsPath } from './control_tower/diag_reporting/diag_event_store.mjs';
import { createCandidatePipeline } from './control_tower/candidate_pipeline.mjs';
import { createOperatorSurfaces } from './control_tower/operator_surfaces.mjs';
import { createScanPipeline } from './control_tower/scan_pipeline.mjs';
import { createEntryDispatch } from './control_tower/entry_dispatch/index.mjs';
import { confirmContinuationGate as runConfirmContinuationGate } from './signals/confirm_continuation.mjs';
import { computePreTrailStopPrice } from './signals/stop_policy.mjs';
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

function loadWallet() {
  const sopsPath = String(process.env.SOPS_WALLET_FILE || '').trim();
  if (sopsPath) return loadKeypairFromSopsFile(sopsPath);
  return loadKeypairFromEnv();
}

function readLastSolUsdFallback() {
  try {
    const p = path.resolve(process.cwd(), 'state/last_sol_price.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw || '{}');
    const v = Number(j?.solUsd ?? j?.priceUsd ?? 0);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeLastSolUsdFallback(solUsd) {
  try {
    const v = Number(solUsd || 0);
    if (!(Number.isFinite(v) && v > 0)) return;
    const p = path.resolve(process.cwd(), 'state/last_sol_price.json');
    fs.writeFileSync(p, JSON.stringify({ solUsd: v, at: Date.now() }));
  } catch {}
}

async function getSolUsdPrice() {
  try {
    const pairs = await getTokenPairs('So11111111111111111111111111111111111111112');
    const best = pickBestPair(pairs);
    const solUsd = Number(best?.priceUsd || 0);
    if (Number.isFinite(solUsd) && solUsd > 0) {
      writeLastSolUsdFallback(solUsd);
      return { solUsd };
    }
  } catch {}
  return { solUsd: readLastSolUsdFallback() };
}

function startHealthServer({ stateRef, getSnapshot }) {
  const port = Number(process.env.HEALTH_PORT || 0);
  if (!Number.isFinite(port) || port <= 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const snapshot = (typeof getSnapshot === 'function') ? getSnapshot() : {};
    const payload = {
      ok: true,
      nowMs: Date.now(),
      ...snapshot,
      positions: Object.keys(stateRef?.positions || {}).length,
    };

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });

  server.listen(port, '0.0.0.0');
  return server;
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
                }catch{}
                anySuccess = true;
                remaining = Math.max(0, remaining - take);
                // small, fast pause between chunks
                await new Promise(r=>setTimeout(r, 80));
                // if process is taking too long, abort chunking
                if (Date.now() - startMs > 1000) break;
              }catch{
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
                try{ state.positions[mint].status='closed'; state.positions[mint].exitAt = new Date().toISOString(); }catch{}
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

  await tgSend(cfg, `🟢 *Candle Carl online*\n\n👛 Wallet: ${pub}\n🪙 Base: SOL`);

  // Register command menu in Telegram UI (best-effort; must not block online ping)
  void tgSetMyCommands(cfg);

  // Boot-time SOLUSD fetch: do NOT crash the bot if DexScreener is rate-limiting.
  // We'll cool down and retry until we have a price.
  let solUsd;
  let bootPriceWarned = false;
  while (!solUsd) {
    try {
      solUsd = (await getSolUsdPrice()).solUsd;
      if (!solUsd) {
        if (!bootPriceWarned) {
          bootPriceWarned = true;
          await tgSend(cfg, '⚠️ SOLUSD unavailable at boot (empty snapshot). Cooling down and retrying...');
        }
        await new Promise(r => setTimeout(r, 60_000));
      }
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
  // Single source of truth: replay retained events from canonical diag stream (family logs are mirrors).
  try {
    const compactHasData = Array.isArray(counters?.watchlist?.compactWindow?.momentumAgeSamples)
      && counters.watchlist.compactWindow.momentumAgeSamples.length > 0;
    if (!compactHasData) {
      const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
      const nowMsForHydrate = Date.now();
      state.runtime.compactWindow = getCompactWindowForDiagRequest({
        statePath: cfg.STATE_PATH,
        mode: 'compact',
        nowMs: nowMsForHydrate,
        windowStartMs: nowMsForHydrate - retainMs,
        retainMs,
      });
      counters.watchlist.compactWindow = state.runtime.compactWindow;
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
      const { jupiterPreflight } = await import('./providers/jupiter/client.mjs');
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
  import('./persistence/rpc_probe.mjs').then(({ startRpcProbe }) => {
    try {
      const rpcHealth = startRpcProbe({ cfg, intervalMs: Number(process.env.RPC_PROBE_EVERY_MS || 30000) });
      import('./observability/heartbeat.mjs').then(({ startHeartbeat }) => {
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
    try { const { closeTimescaleDB } = await import('./analytics/timeseries_db.mjs'); await closeTimescaleDB(); } catch {}
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
    import('./analytics/timeseries_db.mjs').then(({ initializeTimescaleDB }) => {
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
        } catch {
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
        } catch {
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
          const diagEventsPath = getDiagEventsPath(cfg.STATE_PATH);
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
          try {
            appendDiagEvent({
              appendJsonl,
              statePath: cfg.STATE_PATH,
              event: { tMs: now, kind: 'candidateSeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } },
            });
          } catch {}
          return;
        }
        if (kind === 'candidateRouteable') {
          if (!Array.isArray(w.candidateRouteable)) w.candidateRouteable = [];
          w.candidateRouteable.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
          while (w.candidateRouteable.length && Number(w.candidateRouteable[0]?.tMs || 0) < cutoff) w.candidateRouteable.shift();
          try {
            appendDiagEvent({
              appendJsonl,
              statePath: cfg.STATE_PATH,
              event: { tMs: now, kind: 'candidateRouteable', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } },
            });
          } catch {}
          return;
        }
        if (kind === 'candidateLiquiditySeen') {
          if (!Array.isArray(w.candidateLiquiditySeen)) w.candidateLiquiditySeen = [];
          w.candidateLiquiditySeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
          while (w.candidateLiquiditySeen.length && Number(w.candidateLiquiditySeen[0]?.tMs || 0) < cutoff) w.candidateLiquiditySeen.shift();
          try {
            appendDiagEvent({
              appendJsonl,
              statePath: cfg.STATE_PATH,
              event: { tMs: now, kind: 'candidateLiquiditySeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) } },
            });
          } catch {}
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
        try {
          appendDiagEvent({
            appendJsonl,
            statePath: cfg.STATE_PATH,
            event: { tMs: Number(scanCycleEvent.tMs || Date.now()), kind: 'scanCycle', reason: null, extra: { ...scanCycleEvent } },
          });
        } catch {}
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
