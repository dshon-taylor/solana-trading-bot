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
import { confirmContinuationGate as runConfirmContinuationGate } from './lib/confirm_continuation.mjs';
import { isMicroFreshEnough, applyMomentumPassHysteresis, getCachedMintCreatedAt, scheduleMintCreatedAtLookup } from './lib/momentum_gate_controls.mjs';
import { resolveConfirmTxMetricsFromDiagEvent } from './diag_event_invariants.mjs';
import { CORE_MOMO_CHECKS, canaryMomoShouldSample, recordCanaryMomoFailChecks, coreMomentumProgress, decideMomentumBranch, normalizeEpochMs, pickEpochMsWithSource, applySnapshotToLatest, buildNormalizedMomentumInput, pruneMomentumRepeatFailMap } from './watchlist_eval_helpers.mjs';
import {
  JUP_ROUTE_FIRST_ENABLED,
  JUP_SOURCE_PREFLIGHT_ENABLED,
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
  applyMomentumDefaultsToPosition,
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

function recordHardStopAndMaybePause({ cfg, state, nowMs, reason }) {
  if (!cfg.HARD_STOP_COOLDOWN_ENABLED) return { tripped: false };
  const why = String(reason || '').toLowerCase();
  const isHardStop = why.includes('stop hit') && !why.includes('trailing stop');
  if (!isHardStop) return { tripped: false };

  state.runtime ||= {};
  state.runtime.hardStopEventsMs ||= [];
  const windowMs = Number(cfg.HARD_STOP_COOLDOWN_WINDOW_MS || (15 * 60_000));
  const cutoff = nowMs - windowMs;
  state.runtime.hardStopEventsMs = state.runtime.hardStopEventsMs.filter((ts) => Number(ts || 0) >= cutoff);
  state.runtime.hardStopEventsMs.push(nowMs);

  const trigger = Number(cfg.HARD_STOP_COOLDOWN_TRIGGER_COUNT || 3);
  if (state.runtime.hardStopEventsMs.length >= trigger) {
    state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
    const pauseMs = Number(cfg.HARD_STOP_COOLDOWN_PAUSE_MS || (20 * 60_000));
    const until = nowMs + pauseMs;
    state.exposure.pausedUntilMs = Math.max(Number(state.exposure.pausedUntilMs || 0), until);
    state.runtime.hardStopEventsMs = [];
    return { tripped: true, untilMs: state.exposure.pausedUntilMs };
  }
  return { tripped: false };
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

async function estimateEquityUsd(cfg, conn, owner, state, solUsd) {
  const solLamports = await getSolBalanceLamports(conn, owner);
  const sol = solLamports / 1e9;
  let equityUsd = sol * solUsd;

  // Add value of open token positions (approx via DexScreener priceUsd)
  for (const [mint, pos] of Object.entries(state.positions || {})) {
    if (pos.status !== 'open') continue;
    try {
      const tokenBal = await getSplBalance(conn, owner, mint);
      const amt = tokenBal.amount;
      if (!amt || amt <= 0) continue;

      // Get current price from DexScreener
      const pairs = await getTokenPairs('solana', mint);
      const pair = pickBestPair(pairs);
      const priceUsd = Number(pair?.priceUsd || 0);
      const decimals = typeof pos.decimals === 'number' ? pos.decimals : (pair?.baseToken?.decimals ?? null);

      // If decimals unknown, skip valuation to avoid bogus equity.
      if (typeof decimals !== 'number') continue;
      const ui = amt / (10 ** decimals);
      equityUsd += ui * priceUsd;
    } catch {
      // ignore valuation failures
    }
  }

  return { equityUsd, solLamports };
}

async function shouldStopPortfolio(cfg, conn, owner, state, solUsd) {
  const { equityUsd } = await estimateEquityUsd(cfg, conn, owner, state, solUsd);

  // If both portfolio safety guards are explicitly disabled by config, skip stop logic.
  if (cfg.PORTFOLIO_STOP_USDC <= 0 && cfg.MAX_DRAWDOWN_PCT >= 1) {
    return { stop: false, reason: 'portfolio guards disabled', equityUsd };
  }

  state.portfolio.maxEquityUsd = Math.max(state.portfolio.maxEquityUsd || equityUsd, equityUsd);
  const maxEquity = state.portfolio.maxEquityUsd;

  if (equityUsd < cfg.PORTFOLIO_STOP_USDC) {
    return { stop: true, reason: `portfolio stop: equity ${fmtUsd(equityUsd)} < ${fmtUsd(cfg.PORTFOLIO_STOP_USDC)}`, equityUsd };
  }

  const drawdown = maxEquity > 0 ? (maxEquity - equityUsd) / maxEquity : 0;
  if (drawdown >= cfg.MAX_DRAWDOWN_PCT) {
    return { stop: true, reason: `max drawdown hit: ${(drawdown * 100).toFixed(1)}%`, equityUsd };
  }

  return { stop: false, reason: 'ok', equityUsd };
}

async function reconcilePositions({ cfg, conn, ownerPubkey, state }) {
  // Build on-chain holdings map: mint -> raw amount
  const holdings = await getTokenHoldingsByMint(conn, ownerPubkey);

  // 1) For any position we track: ensure state matches reality
  for (const [mint, pos] of Object.entries(state.positions || {})) {
    const amt = holdings.get(mint) || 0;

    if (amt > 0) {
      // We hold it: it must be open.
      if (pos.status !== 'open') {
        pos.status = 'open';
        delete pos.exitAt;
        delete pos.exitReason;
        delete pos.exitTx;
      }
      applyMomentumDefaultsToPosition(cfg, pos);
    } else {
      // We do not hold it: it must be closed.
      if (pos.status === 'open') {
        pos.status = 'closed';
        pos.exitAt = nowIso();
        pos.exitReason = 'reconciled: no on-chain token holdings';
      }
    }
  }

  // 2) If we hold tokens that aren't in state at all, optionally add them.
  // (We only add when there is at least one known position already, to avoid pulling in random dust.)
  if (Object.keys(state.positions || {}).length) {
    for (const [mint, amt] of holdings.entries()) {
      if (!state.positions[mint]) {
        state.positions[mint] = {
          status: 'open',
          mint,
          symbol: null,
          decimals: null,
          pairUrl: null,
          entryAt: nowIso(),
          entryPriceUsd: null,
          peakPriceUsd: null,
          trailingActive: false,
          stopAtEntry: true,
          stopPriceUsd: null,
          trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
          trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
          lastStopUpdateAt: nowIso(),
          lastSeenPriceUsd: null,
          note: `reconciled: found on-chain balance=${amt}`,
          exitPending: true,
        };
      }
    }
  }
}

async function closePosition(cfg, conn, wallet, state, mint, pair, reason) {
  const pos = state.positions[mint];
  if (!pos || pos.status !== 'open') return;

  const tokenBal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
  const amount = tokenBal.amount;

  // If we can't reliably fetch balance, do NOT mark the position closed.
  if (tokenBal.fetchOk === false) {
    pos.exitPending = true;
    pos.lastExitAttemptAt = nowIso();
    pos.lastExitAttemptReason = reason;
    // Rate-limit noisy alerts (once / 10m per mint)
    pos._lastNoBalAlertAtMs = pos._lastNoBalAlertAtMs || 0;
    const nowMs = Date.now();
    if (nowMs - pos._lastNoBalAlertAtMs > 10 * 60_000) {
      pos._lastNoBalAlertAtMs = nowMs;
      await tgSend(cfg, `⚠️ EXIT blocked for ${pos.symbol || mint.slice(0,6)+'…'}: couldn't fetch token balance reliably (${tokenBal.error || 'unknown'}). Will keep retrying.`);
    }
    return;
  }

  // Balance fetch succeeded but is zero. This can happen if the token account view is delayed.
  // Do not auto-close; instead retry and alert sparingly.
  if (!amount || amount <= 0) {
    pos.exitPending = true;
    pos.lastExitAttemptAt = nowIso();
    pos.lastExitAttemptReason = reason;
    pos._lastNoBalAlertAtMs = pos._lastNoBalAlertAtMs || 0;
    const nowMs = Date.now();
    if (nowMs - pos._lastNoBalAlertAtMs > 10 * 60_000) {
      pos._lastNoBalAlertAtMs = nowMs;
      await tgSend(cfg, `⚠️ EXIT blocked for ${pos.symbol || mint.slice(0,6)+'…'}: token balance read as 0 (source=${tokenBal.source || 'unknown'}, ata=${tokenBal.ata}). If you still see the token in wallet, this is an RPC/indexing mismatch; I'll keep retrying.`);
    }
    return;
  }

  const res = await executeSwap({
    conn,
    wallet,
    inputMint: mint,
    outputMint: cfg.SOL_MINT,
    inAmountBaseUnits: amount,
    slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
  });

  const entryPriceUsd = Number(pos.entryPriceUsd || 0) || null;
  const soldRaw = Number(res?.fill?.inAmountRaw || amount || 0);
  let soldDecimals = Number(res?.fill?.inDecimals);
  if (!Number.isFinite(soldDecimals) || soldDecimals < 0) soldDecimals = Number(pos.decimals);
  if (!Number.isFinite(soldDecimals) || soldDecimals < 0) {
    try {
      const sup = await getTokenSupply(cfg.SOLANA_RPC_URL, mint);
      soldDecimals = Number(sup?.decimals);
      if (Number.isFinite(soldDecimals) && soldDecimals >= 0) pos.decimals = soldDecimals;
    } catch {}
  }
  const soldTokens = (soldRaw > 0 && Number.isFinite(soldDecimals) && soldDecimals >= 0)
    ? (soldRaw / (10 ** soldDecimals))
    : null;
  const outSolRaw = Number(res?.fill?.outAmountRaw || 0);
  const outSol = outSolRaw > 0 ? (outSolRaw / 1e9) : null;

  let solUsdExit = Number(pos.solUsdAtEntry || 0) || null;
  try {
    const q = await getSolUsdPrice();
    if (Number.isFinite(Number(q?.solUsd)) && Number(q.solUsd) > 0) solUsdExit = Number(q.solUsd);
  } catch {}

  const liveExitPriceUsd = (soldTokens && outSol && solUsdExit)
    ? ((outSol * solUsdExit) / soldTokens)
    : null;
  const exitPriceUsd = Number(liveExitPriceUsd || pair.priceUsd || pos.lastSeenPriceUsd || 0) || null;

  const pnlPct = (entryPriceUsd && exitPriceUsd) ? ((exitPriceUsd - entryPriceUsd) / entryPriceUsd) : null;
  const entryUsdApprox = (Number(pos.spentSolApprox || 0) && Number(pos.solUsdAtEntry || 0))
    ? (Number(pos.spentSolApprox || 0) * Number(pos.solUsdAtEntry || 0))
    : null;
  const pnlUsdApprox = (entryUsdApprox != null && pnlPct != null) ? (entryUsdApprox * pnlPct) : null;
  const exitFeeLamports = Number(res?.fill?.feeLamports || 0) || 0;
  const entryFeeUsd = Number(pos.entryFeeUsd || 0) || 0;
  const exitFeeUsd = (solUsdExit && exitFeeLamports > 0) ? ((exitFeeLamports / 1e9) * solUsdExit) : 0;
  const pnlUsdNetApprox = (pnlUsdApprox == null) ? null : (pnlUsdApprox - entryFeeUsd - exitFeeUsd);

  pos.status = 'closed';
  pos.exitAt = nowIso();
  pos.exitTx = res.signature;
  pos.exitReason = reason;
  pos.exitPriceUsd = exitPriceUsd;

  // Requalification guard trigger: after stop-outs, require fresh momentum pass before re-attempting this mint.
  try {
    const why = String(reason || '').toLowerCase();
    const isStopExit = why.includes('stop hit') || why.includes('stop loss hit') || why.includes('trailing stop hit');
    if (isStopExit) {
      const nowMsLocal = Date.now();
      const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMsLocal;
      const heldMs = Math.max(0, nowMsLocal - entryAtMs);
      const fastStopMaxAgeMs = Math.max(0, Number(cfg.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS || 45_000));
      const fastStopWindowMs = Math.max(0, Number(cfg.LIVE_FAST_STOP_REENTRY_WINDOW_MS || 180_000));
      const isFastStop = heldMs <= fastStopMaxAgeMs;
      state.runtime ||= {};
      state.runtime.requalifyAfterStopByMint ||= {};
      state.runtime.requalifyAfterStopByMint[mint] = {
        blockedAtMs: nowMsLocal,
        trigger: 'stop',
        entryPriceUsd: Number(pos.entryPriceUsd || 0) || null,
        exitPriceUsd: Number(exitPriceUsd || 0) || null,
        fastStopActive: isFastStop,
        holdUntilMs: isFastStop ? (nowMsLocal + fastStopWindowMs) : null,
        holdMs: heldMs,
        breakoutAboveUsd: Number(pos.lastPeakPrice || pos.peakPriceUsd || pos.entryPriceUsd || 0) || null,
        requireNewHigh: cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH === true,
        requireTradeUpticks: cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS === true,
        minConsecutiveTradeUpticks: Math.max(1, Number(cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2)),
      };
    }
  } catch {}

  // Cooldown after consecutive hard stops to prevent death-spirals.
  try {
    const hs = recordHardStopAndMaybePause({ cfg, state, nowMs: Date.now(), reason });
    if (hs?.tripped && Number.isFinite(Number(hs.untilMs || 0))) {
      const untilIso = new Date(Number(hs.untilMs)).toISOString();
      await tgSend(cfg, `🧯 Hard-stop cooldown engaged: 3 hard stops in 15m. Pausing new entries until ${untilIso}.`);
    }
  } catch {}
  pos.exitPriceSource = Number.isFinite(Number(liveExitPriceUsd)) && Number(liveExitPriceUsd) > 0 ? 'jupiter_fill_math' : 'snapshot';
  pos.exitSoldTokens = soldTokens || null;
  pos.exitOutSol = outSol || null;
  pos.exitFeeLamports = exitFeeLamports || null;
  pos.exitFeeUsd = exitFeeUsd || null;
  pos.pnlPct = pnlPct;
  pos.pnlUsdApprox = pnlUsdApprox;
  pos.pnlUsdNetApprox = pnlUsdNetApprox;
  pos.lastSeenPriceUsd = exitPriceUsd ?? (Number(pos.lastSeenPriceUsd || 0) || null);

  // Compact runner-capture diagnostics
  try {
    state.runtime ||= {};
    state.runtime.diagCounters ||= {};
    const dc = state.runtime.diagCounters;
    dc.runnerCapture ||= {
      exitsUnder15s: 0,
      holdSecSamples: [],
      reached5BeforeExit: 0,
      reached10BeforeExit: 0,
      reached20BeforeExit: 0,
      reached30BeforeExit: 0,
      exitedBeforePostEntryLocalMax10m: 0,
      totalExitsMeasured: 0,
    };
    const rc = dc.runnerCapture;
    const entryMs = Date.parse(String(pos.entryAt || 0));
    const exitMs = Date.parse(String(pos.exitAt || 0));
    const holdSec = (Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs > entryMs)
      ? ((exitMs - entryMs) / 1000)
      : null;
    if (Number.isFinite(holdSec)) {
      if (holdSec < 15) rc.exitsUnder15s = Number(rc.exitsUnder15s || 0) + 1;
      rc.holdSecSamples = Array.isArray(rc.holdSecSamples) ? rc.holdSecSamples : [];
      rc.holdSecSamples.push(Number(holdSec.toFixed(3)));
      if (rc.holdSecSamples.length > 400) rc.holdSecSamples = rc.holdSecSamples.slice(-400);
    }
    const peak = Number(pos.lastPeakPrice || pos.peakPriceUsd || 0);
    const entryPxN = Number(pos.entryPriceUsd || 0);
    if (entryPxN > 0 && peak > 0) {
      const peakRet = (peak / entryPxN) - 1;
      if (peakRet >= 0.05) rc.reached5BeforeExit = Number(rc.reached5BeforeExit || 0) + 1;
      if (peakRet >= 0.10) rc.reached10BeforeExit = Number(rc.reached10BeforeExit || 0) + 1;
      if (peakRet >= 0.20) rc.reached20BeforeExit = Number(rc.reached20BeforeExit || 0) + 1;
      if (peakRet >= 0.30) rc.reached30BeforeExit = Number(rc.reached30BeforeExit || 0) + 1;
    }
    const peakAtMs = Number(pos.peakAtMs || pos.lastPeakAtMs || 0);
    if (Number.isFinite(exitMs) && exitMs > 0 && Number.isFinite(peakAtMs) && peakAtMs > 0 && Number.isFinite(entryMs) && entryMs > 0) {
      if (exitMs < peakAtMs && (peakAtMs - entryMs) <= 10 * 60_000) {
        rc.exitedBeforePostEntryLocalMax10m = Number(rc.exitedBeforePostEntryLocalMax10m || 0) + 1;
      }
    }
    rc.totalExitsMeasured = Number(rc.totalExitsMeasured || 0) + 1;
  } catch {}

  const symbol = tokenDisplayName({
    name: pos?.tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
    symbol: pos?.symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
    mint,
  });
  const exitHeader = tokenDisplayWithSymbol({
    name: pos?.tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
    symbol: pos?.symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
    mint,
  });
  const pnlLine = (pnlPct == null)
    ? '• PnL: n/a'
    : `• PnL: ${(pnlPct * 100).toFixed(2)}%`
      + (pnlUsdApprox == null
        ? ''
        : ` (gross≈ ${fmtUsd(pnlUsdApprox)}${pnlUsdNetApprox == null ? '' : `, net≈ ${fmtUsd(pnlUsdNetApprox)}`})`);

  // Build trade row for durable ledger and write it BEFORE announcing.
  const tradeRow = {
    time: nowIso(),
    kind: 'exit',
    mint,
    symbol: symbol || null,
    entryAt: pos.entryAt || null,
    exitAt: pos.exitAt || null,
    entryTx: pos.entryTx || null,
    exitTx: res.signature || null,
    spentSolApprox: pos.spentSolApprox || null,
    solUsdAtEntry: pos.solUsdAtEntry || null,
    entryPriceUsd: entryPriceUsd || null,
    exitPriceUsd: exitPriceUsd || null,
    entryPriceSource: pos.entryPriceSource || null,
    exitPriceSource: pos.exitPriceSource || null,
    liquidityUsdAtEntry: Number(pos.liquidityUsdAtEntry || 0) || null,
    mcapUsdAtEntry: Number(pos.mcapUsdAtEntry || 0) || null,
    holdersAtEntry: Number(pos.holdersAtEntry || 0) || null,
    uniqueBuyersAtEntry: Number(pos.uniqueBuyersAtEntry || 0) || null,
    topHolderPctAtEntry: Number(pos.topHolderPctAtEntry || 0) || null,
    top10PctAtEntry: Number(pos.top10PctAtEntry || 0) || null,
    bundleClusterPctAtEntry: Number(pos.bundleClusterPctAtEntry || 0) || null,
    creatorClusterPctAtEntry: Number(pos.creatorClusterPctAtEntry || 0) || null,
    lpLockPctAtEntry: Number(pos.lpLockPctAtEntry || 0) || null,
    lpUnlockedAtEntry: pos.lpUnlockedAtEntry ?? null,
    signalBuyDominance: Number(pos.signalBuyDominance || 0) || null,
    signalTx1h: Number(pos.signalTx1h || 0) || null,
    spreadPctAtEntry: Number(pos.spreadPctAtEntry || 0) || null,
    marketDataSourceAtEntry: pos.marketDataSourceAtEntry || null,
    marketDataConfidenceAtEntry: pos.marketDataConfidenceAtEntry || null,
    marketDataFreshnessMsAtEntry: Number(pos.marketDataFreshnessMsAtEntry || 0) || null,
    quotePriceImpactPctAtEntry: Number(pos.quotePriceImpactPctAtEntry || 0) || null,
    requestedSlippageBpsAtEntry: Number(pos.requestedSlippageBpsAtEntry || 0) || null,
    maxPriceImpactPctAtEntry: Number(pos.maxPriceImpactPctAtEntry || 0) || null,
    entryFeeLamports: Number(pos.entryFeeLamports || 0) || null,
    entryFeeUsd: Number(pos.entryFeeUsd || 0) || null,
    exitSoldTokens: soldTokens || null,
    exitOutSol: outSol || null,
    exitFeeLamports: exitFeeLamports || null,
    exitFeeUsd: exitFeeUsd || null,
    pnlPct: pnlPct == null ? null : Number(pnlPct),
    pnlUsdApprox: pnlUsdApprox == null ? null : Number(pnlUsdApprox),
    pnlUsdNetApprox: pnlUsdNetApprox == null ? null : Number(pnlUsdNetApprox),
    exitReason: reason || null,
  };

  // Append with retry (simple, synchronous backoff); if append fails, warn and don't announce.
  try {
    const { appendJsonl } = await import('./candidates_ledger.mjs');
    let wrote = false;
    let attempts = 0;
    const maxAttempts = 3;
    while (!wrote && attempts < maxAttempts) {
      attempts += 1;
      try {
        appendJsonl(cfg.TRADES_LEDGER_PATH, tradeRow);
        wrote = true;
      } catch (e) {
        // small backoff
        await new Promise(r => setTimeout(r, 200 * attempts));
      }
    }
    if (!wrote) {
      // ledger append failed — surface alert and skip announcement to avoid misleading claims
      await tgSend(cfg, `⚠️ EXIT recorded in state but failed to write to trades ledger for ${symbol} (${mint}). Will retry in background.`);
      // still save state and return
      state.positions[mint] = pos;
      saveState(cfg.STATE_PATH, state);
      return;
    }
  } catch (e) {
    // If import or append fails, warn and skip announcing.
    try { await tgSend(cfg, `⚠️ EXIT recorded in state but failed to write to trades ledger for ${symbol} (${mint}): ${e.message || e}`); } catch {}
    state.positions[mint] = pos;
    saveState(cfg.STATE_PATH, state);
    return;
  }

  const msg = [
    `🔴 *EXIT* — ${exitHeader}`,
    '',
    `🧾 Mint: \`${mint}\``,
    `📌 Reason: ${reason}`,
    `🏷️ Exit price source: ${pos.exitPriceSource || 'snapshot'}`,
    Number.isFinite(Number(exitPriceUsd)) ? `💵 Exit price (per token): $${Number(exitPriceUsd).toFixed(10)}` : '💵 Exit price (per token): n/a',
    pnlLine,
    '',
    `🔗 Dex: ${pos.pairUrl}`,
    `🧾 Tx: https://solscan.io/tx/${res.signature}`,
  ].join('\n');

  await tgSend(cfg, msg);

  // Fun runner alert
  if (pnlPct != null && pnlPct >= 0.05) {
    const runner = `🏁🏁🏁 *WE GOT A RUNNER!* 🏁🏁🏁\n${symbol} closed at ${(pnlPct * 100).toFixed(2)}%` + (pnlUsdApprox == null ? '' : ` (≈ ${fmtUsd(pnlUsdApprox)})`);
    await tgSend(cfg, runner);
  }

  appendTradingLog(cfg.TRADING_LOG_PATH,
    `\n## EXIT ${symbol} (${mint})\n- time: ${nowIso()}\n- reason: ${reason}\n- exitPriceUsd: ${exitPriceUsd}\n- exitPriceSource: ${pos.exitPriceSource || 'snapshot'}\n- exitFeeLamports: ${exitFeeLamports}\n- pnlPct: ${pnlPct}\n- pnlUsdApprox: ${pnlUsdApprox}\n- pnlUsdNetApprox: ${pnlUsdNetApprox}\n- tx: ${res.signature}\n`);

  // Exposure control bookkeeping: decrement active runners and trigger post-win pause if large win
  state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
  state.exposure.activeRunnerCount = Math.max(0, Number(state.exposure.activeRunnerCount || 0) - 1);
  if (pnlPct != null && pnlPct >= 0.8) {
    const pauseMs = Number(cfg.POST_WIN_PAUSE_MS || 180000);
    state.exposure.pausedUntilMs = Date.now() + pauseMs;
    pushDebug(state, { t: nowIso(), mint, symbol, reason: `POST_WIN_PAUSE set until ${new Date(state.exposure.pausedUntilMs).toISOString()}` });
  }
  // Try to process queued entries if any
  try { await processExposureQueue(cfg, conn, wallet, state); } catch (e) { console.warn('[exposure] processQueue failed', e?.message || e); }
  saveState(cfg.STATE_PATH, state);
}

import { computeTrailPct, computeStopFromAnchor, updateTrailingAnchor } from './lib/trailing.mjs';
import { computePreTrailStopPrice } from './lib/stop_policy.mjs';

async function updateStops(cfg, state, mint, priceUsd) {
  const pos = state.positions[mint];
  if (!pos || pos.status !== 'open') return { changed: false };

  pos.lastSeenPriceUsd = priceUsd;

  // Ensure backward-compatible shape
  pos.trailingAnchor = pos.trailingAnchor ?? pos.peakPriceUsd ?? pos.entryPriceUsd;
  pos.activeTrailPct = pos.activeTrailPct ?? null;
  pos.lastStopPrice = pos.lastStopPrice ?? pos.stopPriceUsd ?? null;
  pos.lastPeakPrice = pos.lastPeakPrice ?? pos.peakPriceUsd ?? pos.entryPriceUsd;

  // Update local peak (for anchoring)
  if (priceUsd > (pos.lastPeakPrice || 0)) {
    pos.lastPeakPrice = priceUsd;
    pos.lastPeakAtMs = Date.now();
  }

  const entry = Number(pos.entryPriceUsd);
  const profitPct = (priceUsd - entry) / entry;
  const trailActivatePct = Number.isFinite(Number(pos.trailActivatePct))
    ? Number(pos.trailActivatePct)
    : Number(cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT || 0.10);

  let changed = false;

  // Determine desired trail pct based on PnL tiers
  const desiredTrailPct = computeTrailPct(profitPct);

  // Before trail activation tier, enforce pre-arm catastrophic / post-arm baseline stop.
  if (desiredTrailPct == null || profitPct < trailActivatePct) {
    // If trailing had already activated, do not lower/reset stop.
    if (pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct))) {
      return { changed, stopPriceUsd: pos.stopPriceUsd };
    }

    const nowMs = Date.now();
    const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMs;
    const stopPrice = computePreTrailStopPrice({
      entryPriceUsd: entry,
      entryAtMs,
      nowMs,
      armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
      prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
      stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    });

    if (!Number.isFinite(Number(pos.stopPriceUsd)) || pos.stopPriceUsd < stopPrice) {
      pos.stopPriceUsd = stopPrice;
      pos.lastStopUpdateAt = nowIso();
      pos.trailingActive = false;
      pos.activeTrailPct = null;
      pos.trailingAnchor = pos.trailingAnchor ?? pos.lastPeakPrice;
      pos.lastStopPrice = pos.stopPriceUsd;
      changed = true;
    }
    return { changed, stopPriceUsd: pos.stopPriceUsd };
  }

  // For trailing: only update anchor on new local highs (do not widen once tightened)
  const newAnchor = updateTrailingAnchor(pos.lastPeakPrice, pos.trailingAnchor);
  if (newAnchor !== pos.trailingAnchor) {
    pos.trailingAnchor = newAnchor;
  }

  // Compute stop using execution-safe price: account for slippage estimate (use pos.slippageBps or cfg default)
  const slippageBps = Number(pos.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS ?? 0);
  const slippagePct = slippageBps / 10_000; // bps -> fraction

  // Compute candidate stop from anchor and desired trail pct
  const candidateStop = computeStopFromAnchor(pos.trailingAnchor, desiredTrailPct, slippagePct);

  // Never widen trail once tightened: only move stop up (for long positions)
  if (!Number.isFinite(Number(pos.stopPriceUsd)) || candidateStop > pos.stopPriceUsd) {
    pos.stopPriceUsd = candidateStop;
    pos.lastStopUpdateAt = nowIso();
    pos.trailingActive = true;
    pos.activeTrailPct = desiredTrailPct;
    pos.lastStopPrice = pos.stopPriceUsd;
    changed = true;
  }

  return { changed, stopPriceUsd: pos.stopPriceUsd };
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
  if (!globalTimers.watchlistCleanup) {
    globalTimers.watchlistCleanup = setInterval(async ()=>{
      try{
        const now = Date.now();
        let anyStale=false;
        for(const [mint,pos] of wsmgr.live.entries()){
          const d = wsmgr.diag[mint] || {};
          const last = Number(d.last_ws_ts || 0);
          if(last && (now - last) > (wsmgr.staleMs||1200)){
            anyStale = true; break;
          }
        }
        if(anyStale){ await wsmgr.restResync(); }
      }catch(e){}
    }, Math.max(300, Number(process.env.BIRDEYE_WS_STALE_POLL_MS||500)));
  }

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
      await reconcilePositions({ cfg, conn, ownerPubkey: pub, state });
      saveState(cfg.STATE_PATH, state);
      console.log(`[startup] reconciled open positions: now open=${positionCount(state)}`);
    }
  } catch (e) {
    console.warn('[startup] reconcilePositions failed (continuing):', safeErr(e).message);
  }

  let lastScan = 0;
  let nextScanDelayMs = cfg.SCAN_EVERY_MS;
  let lastPos = 0;
  let lastHb = 0;
  let lastRej = 0;
  let lastTgPoll = 0;
  let lastAutoTune = 0;
  let lastHourlyDiag = 0;
  let lastWatchlistEval = 0;

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
  // We run it via an explicit function that can be invoked from both the main loop and a timer.
  let _positionsLoopInFlight = false;
  async function runPositionsLoop(t) {
    if (_positionsLoopInFlight) return;
    _positionsLoopInFlight = true;
    lastPos = t;
    try {
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

        // Reconcile baseline stop policy for non-trailing positions.
        const e0 = Number(pos.entryPriceUsd || 0);
        const trailing0 = !!pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct));
        if (e0 > 0 && !trailing0) {
          const nowMs0 = Date.now();
          const entryAtMs0 = Date.parse(String(pos.entryAt || '')) || nowMs0;
          const targetStop0 = computePreTrailStopPrice({
            entryPriceUsd: e0,
            entryAtMs: entryAtMs0,
            nowMs: nowMs0,
            armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
            prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
            stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
          });
          if (!Number.isFinite(Number(pos.stopPriceUsd)) || Number(pos.stopPriceUsd) < targetStop0) {
            pos.stopPriceUsd = targetStop0;
            pos.lastStopUpdateAt = nowIso();
            pos.lastStopPrice = targetStop0;
            saveState(cfg.STATE_PATH, state);
          }
        }

        // Direct BirdEye reconcile pass for live positions (bypass router/LKG bias).
        try {
          const direct = await birdseye?.getTokenSnapshot?.(mint);
          const directPx = Number(direct?.priceUsd || 0);
          if (directPx > 0 && Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(directPx, pos, null, cfg) <= Number(pos.stopPriceUsd)) {
            const pairDirect = { baseToken: { symbol: pos?.symbol || null }, priceUsd: directPx, url: pos?.pairUrl || null };
            const rr = pos.trailingActive
              ? `trailing stop hit @ ${directPx.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (direct_birdeye)`
              : `stop hit @ ${directPx.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (direct_birdeye)`;
            await closePosition(cfg, conn, wallet, state, mint, pairDirect, rr);
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch (e) {
          console.warn('[direct_birdeye_reconcile] failed', mint, safeErr(e).message);
        }

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

        // IMPORTANT: even if the snapshot is stale/low-confidence, we still want to enforce stops.
        // Otherwise, a rapid dump during data issues can bypass exits entirely.
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

        // Enforce trailing stop updates.
        const upd = await updateStops(cfg, state, mint, priceUsd);

        // Stop-loss exit.
        if (pos.stopPriceUsd && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= pos.stopPriceUsd) {
          await closePosition(cfg, conn, wallet, state, mint, pair, `stop hit @ ${priceUsd.toFixed(6)} <= ${pos.stopPriceUsd.toFixed(6)}`);
          saveState(cfg.STATE_PATH, state);
          continue;
        }

        // Optional: if we changed stop and want alerts, existing code handles elsewhere.
        if (upd?.changed) {
          // noop; position state already updated
        }
      }
    } catch (e) {
      console.warn('[positionsLoop] error', safeErr(e).message);
    } finally {
      _positionsLoopInFlight = false;
    }
  }

  // Timer-based safety net: ensures stops/trailing enforcement continues even when scan loop is slow.
  const _posTimerEveryMs = Math.max(500, Math.min(2_000, Math.floor(cfg.POSITIONS_EVERY_MS / 4) || 1_000));
  if (!globalTimers.positionsLoop) {
    globalTimers.positionsLoop = setInterval(() => {
      const nowMs = Date.now();
      if (nowMs - lastPos >= cfg.POSITIONS_EVERY_MS) {
        runPositionsLoop(nowMs).catch(() => {});
      }
    }, _posTimerEveryMs);
    if (globalTimers.positionsLoop.unref) globalTimers.positionsLoop.unref();
  }

  // Lightweight in-memory /diag snapshot cache (keeps command path fast during heavy scans).
  const DIAG_SNAPSHOT_EVERY_MS = Math.max(1_000, Number(process.env.DIAG_SNAPSHOT_EVERY_MS || 5_000));
  let lastDiagSnapshotAt = 0;
  let diagSnapshot = {
    updatedAtMs: 0,
    builtInMs: 0,
    message: '⏳ Diag snapshot warming…',
  };
  try {
    const snapCarry = state?.runtime?.diagSnapshot || null;
    if (snapCarry && typeof snapCarry.message === 'string') {
      diagSnapshot = {
        updatedAtMs: Number(snapCarry.updatedAtMs || 0),
        builtInMs: Number(snapCarry.builtInMs || 0),
        message: snapCarry.message,
      };
    }
  } catch {}

  function formatMomentumFailDiag({ state, nowMs }) {
    const mf = state.debug?.momentumFail || null;
    const windowMs = Number(mf?.windowMs || 0);
    const events = Array.isArray(mf?.events) ? mf.events : [];
    if (!windowMs || !events.length) return 'momentumFailed(checks): n/a';
    const cutoff = nowMs - windowMs;
    const counts = {};
    let nEvents = 0;
    for (const ev of events) {
      if (!ev || typeof ev.tMs !== 'number' || ev.tMs < cutoff) continue;
      nEvents += 1;
      for (const c of (ev.checks || [])) {
        const k = String(c || 'unknown');
        counts[k] = Number(counts[k] || 0) + 1;
      }
    }
    const top = Object.entries(counts)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, 10)
      .map(([k, v]) => `${k}:${v}`)
      .join(', ') || 'none';
    const windowMin = Math.round(windowMs / 60_000);
    return `momentumFailed(checks) last${windowMin}m events=${nEvents} top=${top}`;
  }
  function formatBirdseyeLiteDiag(nowMs = Date.now()) {
    if (!birdseye || typeof birdseye.getStats !== 'function') return null;
    const s = birdseye.getStats(nowMs) || {};
    const hitRate = (typeof s.cacheHitRate === 'number') ? `${(s.cacheHitRate * 100).toFixed(0)}%` : 'n/a';
    return [
      '• birdeyeLiteCache:',
      `  - ttlMs=${s.ttlMs} perMintMinIntervalMs=${s.perMintMinIntervalMs} size=${s.cacheSize}`,
      `  - cache hit=${s.cacheHits}/${Number(s.cacheHits || 0) + Number(s.cacheMisses || 0)}(${hitRate}) fetches=${s.fetches} fetchPerMin≈${s.fetchPerMin}`,
    ].join('\n');
  }

  function refreshDiagSnapshot(nowMs = Date.now()) {
    const startedAt = Date.now();
    const elapsedHours = Math.max(1 / 60, (nowMs - Number(counters?.lastFlushAt || nowMs)) / 3_600_000);
    const preHotPassedPerDay = (Number(counters?.watchlist?.preHotPassed || 0) / elapsedHours) * 24;
    const preHotMinLiqActive = Number(state?.filterOverrides?.MIN_LIQUIDITY_FLOOR_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 0);
    const wlFunnel = counters?.watchlist?.funnelCumulative || {};
    const body = [
      `profile: aggressive=${cfg.AGGRESSIVE_MODE ? 'on' : 'off'} shortlistPrefilter=${cfg.EARLY_SHORTLIST_PREFILTER_MODE} forceAttemptOnConfirmPass=${cfg.FORCE_ATTEMPT_POLICY_ACTIVE ? 'on' : 'off'} canaryMode=${cfg.CONVERSION_CANARY_MODE ? 'on' : 'off'} debugCanary=${cfg.DEBUG_CANARY_ENABLED ? 'on' : 'off'}`,
      `canaryLatest=${JSON.stringify(state.debug?.canary?.latest || null)}`,
      formatMomentumFailDiag({ state, nowMs }),
      formatThroughputSummary({ counters, title: '📈 *Throughput* (cached in-memory snapshot)' }),
      `• preHot.liquidityThresholdActive=${Number.isFinite(preHotMinLiqActive) ? Math.round(preHotMinLiqActive) : 'n/a'}`,
      `• preHot: considered=${Number(counters?.watchlist?.preHotConsidered || 0)} passed=${Number(counters?.watchlist?.preHotPassed || 0)} failed=${Number(counters?.watchlist?.preHotFailed || 0)} liquidityFails=${Number(counters?.watchlist?.preHotFailedByReason?.liquidity || 0)} reasons=${Object.entries(counters?.watchlist?.preHotFailedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,10).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• preHot.missingFields: fetchAttempted=${Number(counters?.watchlist?.preHotMissingFetchAttempted || 0)} fetchSucceeded=${Number(counters?.watchlist?.preHotMissingFetchSucceeded || 0)} stillMissing=${Number(counters?.watchlist?.preHotMissingStillMissing || 0)}`,
      `• preRunner: tagged=${Number(counters?.watchlist?.preRunnerTagged || 0)} reachedMomentum=${Number(counters?.watchlist?.preRunnerReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.preRunnerReachedConfirm || 0)} reachedAttempt=${Number(counters?.watchlist?.preRunnerReachedAttempt || 0)} filled=${Number(counters?.watchlist?.preRunnerFilled || 0)} expired=${Number(counters?.watchlist?.preRunnerExpired || 0)} rejectedByReason=${Object.entries(counters?.watchlist?.preRunnerRejectedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• preRunner.last10=${(counters?.watchlist?.preRunnerLast10 || []).slice(-10).map((x)=>`${String(x?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(x?.liquidity||0))} txA=${Number(x?.txAccelRatio||0).toFixed(2)} wExp=${Number(x?.walletExpansionRatio||0).toFixed(2)} piExp=${Number(x?.priceImpactExpansionRatio||0).toFixed(2)} bsr=${Number(x?.buySellRatio||0).toFixed(2)} stage=${String(x?.finalStageReached||'tagged')}`).join(' | ') || 'none'}`,
      `• burst: tagged=${Number(counters?.watchlist?.burstTagged || 0)} reachedMomentum=${Number(counters?.watchlist?.burstReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.burstReachedConfirm || 0)} reachedAttempt=${Number(counters?.watchlist?.burstReachedAttempt || 0)} filled=${Number(counters?.watchlist?.burstFilled || 0)} expired=${Number(counters?.watchlist?.burstExpired || 0)} burstAvgTxAccel=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstTxAccelSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} burstAvgWalletExpansion=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstWalletExpansionSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} burstAvgBuySellRatio=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstBuySellRatioSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} rejectedByReason=${Object.entries(counters?.watchlist?.burstRejectedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• burst.last10=${(counters?.watchlist?.burstLast10 || []).slice(-10).map((x)=>`${String(x?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(x?.liquidity||0))} txA=${Number(x?.txAccelRatio||0).toFixed(2)} wExp=${Number(x?.walletExpansionRatio||0).toFixed(2)} bsr=${Number(x?.buySellRatio||0).toFixed(2)} volExp=${Number(x?.volumeExpansionRatio||0).toFixed(2)} stage=${String(x?.finalStageReached||'tagged')}`).join(' | ') || 'none'}`,
      `• hot.mcapDeferred: missing=${Number(counters?.watchlist?.hotDeferredMissingMcap || 0)} recovered=${Number(counters?.watchlist?.hotDeferredRecovered || 0)} failed=${Number(counters?.watchlist?.hotDeferredFailed || 0)}`,
      `• hot.mcapNormalized: present=${Number(counters?.watchlist?.hotMcapNormalizedPresent || 0)} missing=${Number(counters?.watchlist?.hotMcapNormalizedMissing || 0)} sourceUsed=${Object.entries(counters?.watchlist?.hotMcapSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.mcapStaleRule: reject when freshnessMs > ${Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)}ms (non-fatal for liquidity-bypass stalking path)`,
      `• confirm.mcapStaleRule: reject when freshnessMs > ${Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)}ms`,
      `• hot.enrichedRefresh: attempted=${Number(counters?.watchlist?.hotEnrichedRefreshAttempted || 0)} recovered=${Number(counters?.watchlist?.hotEnrichedRefreshRecovered || 0)} failed=${Number(counters?.watchlist?.hotEnrichedRefreshFailed || 0)} reasons=${Object.entries(counters?.watchlist?.hotEnrichedRefreshReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.enrichedRouteOnlyReachedMomentum=${Number(counters?.watchlist?.hotEnrichedRouteOnlyReachedMomentum || 0)}`,
      `• hot.liqMomentumBypass: allowed=${Number(counters?.watchlist?.hotLiqMomentumBypassAllowed || 0)} rejected=${Number(counters?.watchlist?.hotLiqMomentumBypassRejected || 0)} reachedMomentum=${Number(counters?.watchlist?.hotLiqBypassReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.hotLiqBypassReachedConfirm || 0)}`,
      `• hot.liqBypassPrimaryRejectReason=${Object.entries(counters?.watchlist?.hotLiqBypassPrimaryRejectReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,12).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.liqBypassSecondaryTags=${Object.entries(counters?.watchlist?.hotLiqBypassSecondaryTags || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,12).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.postBypassRejected: mcapMissing=${Number(counters?.watchlist?.hotPostBypassRejected?.mcapMissing || 0)} age=${Number(counters?.watchlist?.hotPostBypassRejected?.age || 0)} holders=${Number(counters?.watchlist?.hotPostBypassRejected?.holders || 0)} other=${Number(counters?.watchlist?.hotPostBypassRejected?.other || 0)} reachedMomentum=${Number(counters?.watchlist?.hotPostBypassReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.hotPostBypassReachedConfirm || 0)} allowedStaleMcap=${Number(counters?.watchlist?.hotPostBypassAllowedStaleMcap || 0)}`,
      `• hot.liqBypassUnsafeCombos=${Object.entries(counters?.watchlist?.hotLiqBypassUnsafeCombo || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.bypassTrace.finalReasonCounts=${Object.entries(counters?.watchlist?.hotBypassTraceFinalReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,10).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.bypassTrace.last10=${(counters?.watchlist?.hotBypassTraceLast10 || []).map(x=>`${x?.mint?.slice?.(0,6)||'n/a'}:${x?.decision||'n/a'}:${x?.next||'n/a'}:${x?.final||'ok'}`).join(' | ') || 'none'}`,
      `• momentum.breakoutRule=mature:3_of_4 early(<30m):2_of_3(priceBreak+buyPressure+paper)`,
      `• momentum.branchDecisionRule="early only if agePresent && ageMin<30; missing age uses strict/mature 3-of-4"`,
      `• momentum.earlyTokenMode=${Number(counters?.watchlist?.momentumEarlyTokenModeCount || 0)} momentum.matureTokenMode=${Number(counters?.watchlist?.momentumMatureTokenModeCount || 0)}`,
      `• momentum.agePresent=${Number(counters?.watchlist?.momentumAgePresent || 0)} momentum.ageMissing=${Number(counters?.watchlist?.momentumAgeMissing || 0)}`,
      `• momentum.ageSourceUsed=${Object.entries(counters?.watchlist?.momentumAgeSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.liqGuardrail=${Number(counters?.watchlist?.momentumLiqGuardrail || 60000)}`,
      `• momentum.liqCandidatesBelowGuardrail=${Number(counters?.watchlist?.momentumLiqCandidatesBelowGuardrail || 0)}`,
      `• momentum.liqCandidatesAboveGuardrail=${Number(counters?.watchlist?.momentumLiqCandidatesAboveGuardrail || 0)}`,
      `• momentum.breakoutSignalsPassed=${Number(counters?.watchlist?.momentumBreakoutSignalsPassed || 0)}`,
      `• momentum.breakoutSignalsFailed=${Number(counters?.watchlist?.momentumBreakoutSignalsFailed || 0)}`,
      `• momentum.inputCompleteness.present=${Number(counters?.watchlist?.momentumInputCompletenessPresent || 0)}`,
      `• momentum.inputCompleteness.missing=${Number(counters?.watchlist?.momentumInputCompletenessMissing || 0)}`,
      `• momentum.inputSourceUsed=${Object.entries(counters?.watchlist?.momentumInputSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.microFieldsPresent=${Number(counters?.watchlist?.momentumMicroFieldsPresent || 0)}`,
      `• momentum.microFieldsMissing=${Number(counters?.watchlist?.momentumMicroFieldsMissing || 0)}`,
      `• momentum.microSourceUsed=${Object.entries(counters?.watchlist?.momentumMicroSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.zeroSignalFallbackCount=${Number(counters?.watchlist?.momentumZeroSignalFallbackCount || 0)}`,
      `• momentum.failedChecksTop=${Object.entries(counters?.watchlist?.momentumFailedChecksTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.failedMintsTop=${Object.entries(counters?.watchlist?.momentumFailedMintsTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none'}`,
      `• momentum.failedCheckExamples=${(counters?.watchlist?.momentumFailedCheckExamples || []).slice(-3).map(x=>`${String(x?.mint||'n/a').slice(0,6)}[${Array.isArray(x?.checks)?x.checks.slice(0,3).join('|'):'none'}]`).join(' | ') || 'none'}`,
      `• momentum.inputDebugLast3=${(counters?.watchlist?.momentumInputDebugLast || []).slice(-3).map(x=>`${String(x?.mint||'n/a').slice(0,6)} raw(liq=${Number(x?.raw?.snapshot?.liquidityUsd ?? x?.raw?.latest?.liqUsd ?? 0)||0},mcap=${Number(x?.raw?.snapshot?.marketCapUsd ?? x?.raw?.latest?.mcapUsd ?? 0)||0}) norm(v5=${Number(x?.normalizedUsed?.volume5m||0)},bsr=${Number(x?.normalizedUsed?.buySellRatio||0)},tx1m=${Number(x?.normalizedUsed?.tx1m||0)},px=${Number(x?.normalizedUsed?.priceUsd||0)}) fail=[${Array.isArray(x?.failedChecks)?x.failedChecks.slice(0,3).join('|'):'none'}]`).join(' | ') || 'none'}`,
      `• momentum.repeatFailSuppressed=${Number(counters?.watchlist?.momentumRepeatFailSuppressed || 0)}`,
      `• momentum.repeatFailMintsTop=${Object.entries(counters?.watchlist?.momentumRepeatFailMintsTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none'}`,
      `• momentum.repeatFailReasonTop=${Object.entries(counters?.watchlist?.momentumRepeatFailReasonTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.repeatFailWindowSec=180 (cooldownSec=120, escalation>=3 hits/900s => cooldownSec=900, improvementDelta>=0.05 on failed core checks)`,
      `• liqSafety.final: confirm.fullLiqRejected=${Number(counters?.watchlist?.confirmFullLiqRejected || 0)} confirm.mcapMissingRejected=${Number(counters?.watchlist?.confirmMcapMissingRejected || 0)} confirm.mcapStaleRejected=${Number(counters?.watchlist?.confirmMcapStaleRejected || 0)} confirm.ageMissingRejected=${Number(counters?.watchlist?.confirmAgeMissingRejected || 0)} attempt.fullLiqRejected=${Number(counters?.watchlist?.attemptFullLiqRejected || 0)}`,
      `• hot.progression: enq=${Number(counters?.watchlist?.hotEnqueued || 0)} cons=${Number(counters?.watchlist?.hotConsumed || 0)} momentum=${Number(wlFunnel.momentumPassed || 0)} confirm=${Number(wlFunnel.confirmPassed || 0)} attempt=${Number(wlFunnel.attempted || 0)} fill=${Number(wlFunnel.filled || 0)}`,
      `• watchlist.blockedTop(after-change)=${Object.entries(counters?.watchlist?.blockedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• opportunities/day_preHotPassed est: ${preHotPassedPerDay.toFixed(1)}`,
      `• hotCap: evictions=${Number(counters?.watchlist?.capEvictions || 0)} rejectedDueToCap=${Number(counters?.watchlist?.rejectedDueToCap || 0)}`,
      '',
      formatMarketDataProviderSummary(state),
      formatBirdseyeLiteDiag(nowMs) || '',
      '',
      formatWatchlistSummary({ state, counters, nowMs }),
      '',
      formatTrackerIngestionSummary({ cfg, state }),
      formatTrackerSamplingBreakdown({ state, nowMs }),
    ].join('\n');
    diagSnapshot = {
      updatedAtMs: nowMs,
      builtInMs: Math.max(0, Date.now() - startedAt),
      message: body,
    };
    try {
      state.runtime ||= {};
      state.runtime.diagCounters = JSON.parse(JSON.stringify(counters));
      state.runtime.diagSnapshot = {
        updatedAtMs: diagSnapshot.updatedAtMs,
        builtInMs: diagSnapshot.builtInMs,
        message: diagSnapshot.message,
      };
    } catch {}
    return diagSnapshot;
  }
  function getDiagSnapshotMessage(nowMs = Date.now(), mode = 'full', windowHours = null) {
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
      const compactWindow = counters?.watchlist?.compactWindow || {};
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
      const scanCyclesRaw = compactWindow.scanCycles || [];
      const scanCyclesWin = inWindowObj(scanCyclesRaw);
      const candidateSeenWin = inWindowObj(compactWindow.candidateSeen || []);
      const candidateRouteableWin = inWindowObj(compactWindow.candidateRouteable || []);
      const candidateLiquiditySeenWin = inWindowObj(compactWindow.candidateLiquiditySeen || []);
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

        const lines = [
          `🧪 *Diag (execution)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`,
          'HEADER',
          `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} status=${warmingUp ? 'warming_up' : 'ready'} lastAttemptAgeSec=${lastAttemptAgeSec}`,
        ];
        if (circuitOpen) {
          lines.push(`circuit: open=true reason=${circuitOpenReason} since=${circuitOpenSinceMs ? fmtCt(circuitOpenSinceMs) : 'n/a'} cooldownRemainingSec=${circuitOpenRemainingSec}`);
        }
        lines.push('',
          'FLOW',
          `- lastHour: attemptReached=${hourAttemptReached} attemptPassed=${hourAttemptPassed} fill=${hourFill} swapFailed=${hourSwapFailed}`,
          `- cumulative: attemptReached=${cumAttemptReached} attemptPassed=${cumAttemptPassed} fill=${cumFill} swapFailed=${cumSwapFailed}`,
          `- attemptPassRate=${cumAttemptPassed}/${cumAttemptReached || 0} (${(attemptPassRate*100).toFixed(1)}%)`,
          `- fillFromAttemptRate=${cumFill}/${cumAttemptReached || 0} (${(fillFromAttemptRate*100).toFixed(1)}%)`,
          `- fillFromConfirmRate=${cumFill}/${cumConfirmPassed || 0} (${(fillFromConfirmRate*100).toFixed(1)}%)`,
          '',
          'EXECUTION BLOCKERS',
          ...(topExecutionBlockers.length ? topExecutionBlockers : ['- none']),
          '',
          'FILL QUALITY',
          `- median quoteToSendMs=${fmtMed(medianLocal(quoteToSendMs),0)}`,
          `- median sendToFillMs=${fmtMed(medianLocal(sendToFillMs),0)}`,
          `- median totalAttemptToFillMs=${fmtMed(medianLocal(totalAttemptToFillMs),0)}`,
          `- median realizedSlippageBps=${fmtMed(medianLocal(realizedSlippageBps),1)}`,
          `- median quotedPriceImpactPct=${fmtMed(medianLocal(quotedPriceImpactPct),4)}`,
          '',
          'ATTEMPT SHAPE',
          `- median entry liq=${fmtMed(medianLocal(entryLiq),0)}`,
          `- median entry mcap=${fmtMed(medianLocal(entryMcap),0)}`,
          `- median entry priceImpactPct=${fmtMed(medianLocal(entryPi),4)}`,
          `- median entry slippageBps=${fmtMed(medianLocal(entrySlip),0)}`,
          `- routeSourceMix=${routeMixStr}`,
          '',
          'HANDOFF SUMMARY',
          `- confirmPassed=${cumConfirmPassed} attemptReached=${cumAttemptReached} fill=${cumFill} topHandoffBlocker=${topHandoffBlocker}`,
          '',
          'TOP EXAMPLES',
          '- strongest failed attempts:',
          ...(failedAttemptsCompact.length ? failedAttemptsCompact : ['- none']),
          '- strongest filled attempts:',
          ...(filledAttemptsCompact.length ? filledAttemptsCompact : ['- none'])
        );

        if (swapErrSummary.length) {
          lines.push('', 'SWAP/PREFLIGHT ERRORS', ...swapErrSummary);
        }
        if (missingDecimalsN > 0) lines.push(`- missingDecimals=${missingDecimalsN}`);
        if (reserveBlockedN > 0) lines.push(`- reserveBlocked=${reserveBlockedN}`);
        if (targetUsdTooSmallN > 0) lines.push(`- targetUsdTooSmall=${targetUsdTooSmallN}`);

        return lines.join('\n');
      }

      if (mode === 'scanner') {
        return [
          `🧪 *Diag (scanner)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`, 
          'HEADER',
          `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} scannerHealth=${scannerHealth} scannerCycleCount=${scannerCycleCount} scansPerHour=${warmingUp ? 'warming_up' : scansPerHourWindow.toFixed(1)}`,
          '',
          'SCAN RATE',
          `scannerIntervalMs=${avgScanIntervalMs != null ? Math.round(avgScanIntervalMs) : 'n/a'} avgScanDurationMs=${avgScanDurationMs != null ? Math.round(avgScanDurationMs) : 'n/a'} scanWallClockMs=${scanPhaseAverages.scanWallClockMs != null ? Math.round(scanPhaseAverages.scanWallClockMs) : 'n/a'} scanAggregateTaskMs=${scanPhaseAverages.scanAggregateTaskMs != null ? Math.round(scanPhaseAverages.scanAggregateTaskMs) : 'n/a'}`,
          '',
          'PHASE BREAKDOWN',
          `candidateDiscoveryMs=${scanPhaseAverages.candidateDiscoveryMs != null ? Math.round(scanPhaseAverages.candidateDiscoveryMs) : 'n/a'} snapshotBuildMs=${scanPhaseAverages.snapshotBuildMs != null ? Math.round(scanPhaseAverages.snapshotBuildMs) : 'n/a'} adaptiveDelayMs=${scanPhaseAverages.adaptiveDelayMs != null ? Math.round(scanPhaseAverages.adaptiveDelayMs) : 'n/a'} top3LongestScanPhases=${top3ScanPhases}`,
          '',
          'CANDIDATE DISCOVERY SUBPHASES',
          `sourcePolling=${scanPhaseAverages.candidateSourcePollingMs != null ? Math.round(scanPhaseAverages.candidateSourcePollingMs) : 'n/a'} sourceMerging=${scanPhaseAverages.candidateSourceMergingMs != null ? Math.round(scanPhaseAverages.candidateSourceMergingMs) : 'n/a'} sourceTransforms=${scanPhaseAverages.candidateSourceTransformsMs != null ? Math.round(scanPhaseAverages.candidateSourceTransformsMs) : 'n/a'} streamDrain=${scanPhaseAverages.candidateStreamDrainMs != null ? Math.round(scanPhaseAverages.candidateStreamDrainMs) : 'n/a'} tokenlistFetch=${scanPhaseAverages.candidateTokenlistFetchMs != null ? Math.round(scanPhaseAverages.candidateTokenlistFetchMs) : 'n/a'} tokenlistPoolBuild=${scanPhaseAverages.candidateTokenlistPoolBuildMs != null ? Math.round(scanPhaseAverages.candidateTokenlistPoolBuildMs) : 'n/a'} tokenlistSampling=${scanPhaseAverages.candidateTokenlistSamplingMs != null ? Math.round(scanPhaseAverages.candidateTokenlistSamplingMs) : 'n/a'} tokenlistQuoteabilityChecks=${scanPhaseAverages.candidateTokenlistQuoteabilityChecksMs != null ? Math.round(scanPhaseAverages.candidateTokenlistQuoteabilityChecksMs) : 'n/a'} iteration=${scanPhaseAverages.candidateIterationMs != null ? Math.round(scanPhaseAverages.candidateIterationMs) : 'n/a'} stateLookup=${scanPhaseAverages.candidateStateLookupMs != null ? Math.round(scanPhaseAverages.candidateStateLookupMs) : 'n/a'} cacheReads=${scanPhaseAverages.candidateCacheReadsMs != null ? Math.round(scanPhaseAverages.candidateCacheReadsMs) : 'n/a'} cacheWrites=${scanPhaseAverages.candidateCacheWritesMs != null ? Math.round(scanPhaseAverages.candidateCacheWritesMs) : 'n/a'} filterLoops=${scanPhaseAverages.candidateFilterLoopsMs != null ? Math.round(scanPhaseAverages.candidateFilterLoopsMs) : 'n/a'} asyncWaitUnclassified=${scanPhaseAverages.candidateAsyncWaitUnclassifiedMs != null ? Math.round(scanPhaseAverages.candidateAsyncWaitUnclassifiedMs) : 'n/a'} cooldownFiltering=${scanPhaseAverages.candidateCooldownFilteringMs != null ? Math.round(scanPhaseAverages.candidateCooldownFilteringMs) : 'n/a'} shortlistPrefilter=${scanPhaseAverages.candidateShortlistPrefilterMs != null ? Math.round(scanPhaseAverages.candidateShortlistPrefilterMs) : 'n/a'} routeabilityChecks=${scanPhaseAverages.candidateRouteabilityChecksMs != null ? Math.round(scanPhaseAverages.candidateRouteabilityChecksMs) : 'n/a'} other=${scanPhaseAverages.candidateOtherMs != null ? Math.round(scanPhaseAverages.candidateOtherMs) : 'n/a'}`,
          '',
          'SNAPSHOT BUILD SUBPHASES',
          `birdEyeFetch=${scanPhaseAverages.snapshotBirdseyeFetchMs != null ? Math.round(scanPhaseAverages.snapshotBirdseyeFetchMs) : 'n/a'} pairEnrichment=${scanPhaseAverages.snapshotPairEnrichmentMs != null ? Math.round(scanPhaseAverages.snapshotPairEnrichmentMs) : 'n/a'} liqMcapNormalization=${scanPhaseAverages.snapshotLiqMcapNormalizationMs != null ? Math.round(scanPhaseAverages.snapshotLiqMcapNormalizationMs) : 'n/a'} snapshotValidation=${scanPhaseAverages.snapshotValidationMs != null ? Math.round(scanPhaseAverages.snapshotValidationMs) : 'n/a'} watchlistRowConstruction=${scanPhaseAverages.snapshotWatchlistRowConstructionMs != null ? Math.round(scanPhaseAverages.snapshotWatchlistRowConstructionMs) : 'n/a'} other=${scanPhaseAverages.snapshotOtherMs != null ? Math.round(scanPhaseAverages.snapshotOtherMs) : 'n/a'}`,
          '',
          'CALL COUNTS',
          `pairFetchCallsPerScan=${pairFetchCallsPerScan != null ? pairFetchCallsPerScan.toFixed(2) : 'n/a'} pairFetchConcurrencyPerScan=${pairFetchConcurrencyPerScan != null ? pairFetchConcurrencyPerScan.toFixed(2) : 'n/a'} birdeyeCallsPerScan=${birdeyeCallsPerScan != null ? birdeyeCallsPerScan.toFixed(2) : 'n/a'} rpcCallsPerScan=${rpcCallsPerScan != null ? rpcCallsPerScan.toFixed(2) : 'n/a'} maxSingleCallDurationMs=${maxSingleCallDurationMs != null ? Math.round(maxSingleCallDurationMs) : 'n/a'}`,
          `routePrefilterDegradedScans=${degradedRoutePrefilterScans}/${scannerCycleCount} jupCooldownActiveScans=${jupCooldownActiveScans}/${scannerCycleCount} usableSnapshotWithoutPairPerScan=${usableSnapshotWithoutPairPerScan != null ? usableSnapshotWithoutPairPerScan.toFixed(2) : 'n/a'} noPairTempActivePerScan=${noPairTempActivePerScan != null ? noPairTempActivePerScan.toFixed(2) : 'n/a'}`,
          `tokenlistCandidatesFilteredByLiquidity=${scanPhaseAverages.tokenlistCandidatesFilteredByLiquidity != null ? scanPhaseAverages.tokenlistCandidatesFilteredByLiquidity.toFixed(2) : 'n/a'} tokenlistQuoteChecksPerformed=${scanPhaseAverages.tokenlistQuoteChecksPerformed != null ? scanPhaseAverages.tokenlistQuoteChecksPerformed.toFixed(2) : 'n/a'} tokenlistQuoteChecksSkipped=${scanPhaseAverages.tokenlistQuoteChecksSkipped != null ? scanPhaseAverages.tokenlistQuoteChecksSkipped.toFixed(2) : 'n/a'}`,
          '',
          'SOURCE UNIVERSE',
          `tokenlistTestMode=${cfg.JUP_TOKENLIST_ENABLED ? 'enabled' : 'disabled'}`,
          `sourceEnabled.boosted=${sourceEnabled.boosted ? 'true' : 'false'} sourceEnabled.tokenlist=${sourceEnabled.tokenlist ? 'true' : 'false'} sourceEnabled.stream=${sourceEnabled.stream ? 'true' : 'false'} sourceEnabled.trending=${sourceEnabled.trending ? 'true' : 'false'}`,
          `sourceMix=${`boosted=${sourceMix.boosted} tokenlist=${sourceMix.tokenlist} stream=${sourceMix.stream} trending=${sourceMix.trending} other=${sourceMix.other}`}`,
          `candidatesSeenBySource=boosted:${candidatesSeenBySource.boosted} tokenlist:${candidatesSeenBySource.tokenlist} stream:${candidatesSeenBySource.stream} trending:${candidatesSeenBySource.trending} other:${candidatesSeenBySource.other}`,
          `routeableBySource=boosted:${routeableBySource.boosted} tokenlist:${routeableBySource.tokenlist} stream:${routeableBySource.stream} trending:${routeableBySource.trending} other:${routeableBySource.other}`,
          `aboveHotFloorBySource=boosted:${aboveHotFloorBySource.boosted} tokenlist:${aboveHotFloorBySource.tokenlist} stream:${aboveHotFloorBySource.stream} trending:${aboveHotFloorBySource.trending} other:${aboveHotFloorBySource.other}`,
          `tokenlistDropoffStage=${tokenlistDropoffStage} tokenlistPath=${tokenlistSeen}->${tokenlistRouteable}->${tokenlistAboveHot}`,
          `trendingPath(seen->routeable->aboveHotFloor)=${Number(candidatesSeenBySource.trending||0)}->${Number(routeableBySource.trending||0)}->${Number(aboveHotFloorBySource.trending||0)}`,
          '',
          'MARKET SHAPE',
          `uniqueCandidatesSeen=${uniqueCandidatesSeen} uniqueCandidatesRouteable=${uniqueCandidatesRouteable} uniqueCandidatesAboveHotFloor=${uniqueAboveHotFloor} uniqueCandidatesAboveConfirmFloor=${uniqueAboveConfirmFloor} uniqueCandidatesAboveAttemptFloor=${uniqueAboveAttemptFloor}`,
          '',
          'WINDOW DEBUG',
          `retroWindowMode=true requestedWindowStart=${fmtCt(requestedWindowStartMs)} effectiveWindowStart=${fmtCt(effectiveWindowStartMs)} botUptimeHours=${botUptimeHours.toFixed(2)} computedWindowHours=${elapsedHours.toFixed(2)}`, 
        ].join('\n');
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

        return [
          `🧪 *Diag (confirm)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`,
          'HEADER',
          `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} status=${warmingUp ? 'warming_up' : 'ready'} lastConfirmAgeSec=${lastConfirmEvalAgeSec}`,
          `confirmWindowMs=${confirmWindowMs} confirmWindowSec=${confirmWindowSec}`, 
          ...(showCircuitAbnormal ? [
            `circuitAbnormal=true open=${circuitOpen ? 'true' : 'false'} reason=${circuitOpenReason} cooldownRemainingSec=${circuitOpenRemainingSec}`,
          ] : []),
          '',
          'FLOW',
          `- lastHour: confirmReached=${hourConfirmReached2} confirmPassed=${hourConfirmPassed2} attemptReached=${hourAttemptReached2} fill=${hourFill2}`,
          `- cumulative: confirmReached=${cumulativeConfirmReached} confirmPassed=${cumulativeConfirmPassed} attemptReached=${cumAttemptReached} fill=${cumFill}`,
          `- confirmPassRate=${fmtRate(cumulativeConfirmPassed, cumulativeConfirmReached)}`,
          `- attemptFromConfirmRate=${fmtRate(cumAttemptReached, cumulativeConfirmPassed)}`,
          `- fillFromConfirmRate=${fmtRate(cumFill, cumulativeConfirmPassed)}`,
          '',
          'CONTINUATION OUTCOMES',
          `- modeActive=${continuationModeActive ? 'true' : 'false'}`,
          `- pass: runup=${Number(continuationPassReasonCounts.runup || 0)}`,
          `- fail: hardDip=${continuationFailMix.hardDip} windowExpiredStall=${continuationFailMix.windowExpiredStall} windowExpiredWeak=${continuationFailMix.windowExpiredWeak} dataUnavailable=${continuationFailMix.dataUnavailable} liqDegraded=${continuationFailMix.liqDegraded} route=${continuationFailMix.route} impact=${continuationFailMix.impact} retryCooldown=${continuationFailMix.retryCooldown} retryNoImprovement=${continuationFailMix.retryNoImprovement} other=${continuationFailMix.other}`,
          `- reached+1.5%InWindow=${confirmReachedRunup15}`,
          `- reached+1.5%And2PositiveTrades=${confirmReachedRunupAndTradeSeq}`,
          `- failedAfterRunupNoTradeSequence=${failedAfterRunupNoTradeSequence}`,
          `- runupSourceUsed=${runupSourceUsedSummary}`,
          `- tradeSequenceSourceUsed=${tradeSequenceSourceUsedSummary}`,
          `- confirmWindowActiveMs=${confirmWindowMs} (${confirmWindowSec}s)`,
          `- medianTimeToRunupMs=${Number.isFinite(medianTimeToRunupPassMs) ? Math.round(Number(medianTimeToRunupPassMs)) : 'n/a'}${Number.isFinite(medianTimeToRunupWindowPct) ? ` (~${Number(medianTimeToRunupWindowPct).toFixed(1)}% of window)` : ''}`,
          `- runupTimingBucketsPassed=<10s:${runupTimingBuckets.lt10s} 10-20s:${runupTimingBuckets.s10_20} 20-40s:${runupTimingBuckets.s20_40} 40-60s:${runupTimingBuckets.s40_60}${runupTimingBuckets.gt60s > 0 ? ` >60s:${runupTimingBuckets.gt60s}` : ''}`,
          '',
          'BLOCKER SUMMARY',
          `- topConfirmBlockers=${top3ConfirmBlockers}`,
          `- topAttemptBlockers=${top3AttemptBlockers}`,
          '',
          'RETRY BEHAVIOR',
          `- attempted=${continuationFailMix.retryCooldown + continuationFailMix.retryNoImprovement} blockedCooldown=${continuationFailMix.retryCooldown} blockedNoImprovement=${continuationFailMix.retryNoImprovement} requalifiedAndPassed=${recycledRequalifiedPassedCount}`,
          '',
          'ATTEMPT/FILL HANDOFF',
          `- confirmPassed=${cumulativeConfirmPassed} attemptReached=${cumAttemptReached} fill=${cumFill} topHandoffBlocker=${topHandoffBlocker}`,
          '',
          'CONFIRM SHAPE',
          `- medianRunupPct=${Number.isFinite(medianRunupPct) ? Number(medianRunupPct).toFixed(4) : 'n/a'} medianDipPct=${Number.isFinite(medianDipPct) ? Number(medianDipPct).toFixed(4) : 'n/a'} medianFinalPct=${Number.isFinite(medianFinalPct) ? Number(medianFinalPct).toFixed(4) : 'n/a'}`,
          '',
          'TOP EXAMPLES',
          '- failed:',
          ...(strongestFailedConfirmCompact.length ? strongestFailedConfirmCompact.slice(0,3) : ['- none']),
          '- passed:',
          ...(strongestPassedConfirmCompact.length ? strongestPassedConfirmCompact.slice(0,3) : ['- none']),
          '',
          'WS AUDITION TRACE (temporary sample)',
          ...(wsTraceSampleRows.length ? wsTraceSampleRows : ['- none']),
        ].join('\n');
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

        return [
          `🧪 *Diag (momentum)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`,
          'HEADER',
          `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} status=${warmingUp ? 'warming_up' : 'ready'} lastMomentumEvalAgeSec=${lastMomentumEvalAgeSec}`,
          '',
          'FLOW',
          `- evaluated=${cumEvaluated} passed=${cumPassed} failed=${cumFailed}`,
          `- passRate=${cumPassed}/${cumEvaluated} (${cumEvaluated > 0 ? ((cumPassed/cumEvaluated)*100).toFixed(1) : '0.0'}%)`,
          `- branchMix=early:${earlyCountWin} mature:${Math.max(0, momentumAgeWin.length - earlyCountWin)}`,
          `- choke=${chokeName} (${chokeCount} fails, ${chokePct.toFixed(1)}% of evaluated)`,
          '',
          'POST-MOMENTUM OUTCOMES',
          `- momentumPassed=${momentumPassedMints.size} confirmPassed=${confirmPassedSet.size} fill=${fillSet.size}`,
          `- reached+1.5%InConfirmWindow=${reachedRunup15Set.size}`,
          `- confirmFailMix hardDip=${confirmFailMix.hardDip} windowExpired=${confirmFailMix.windowExpired} liq=${confirmFailMix.liq} route=${confirmFailMix.route} impact=${confirmFailMix.impact} other=${confirmFailMix.other}`,
          '',
          'BLOCKER SUMMARY',
          `- topScoringFailReasons: ${(top3ScoringFailReasons.length ? top3ScoringFailReasons.map((x)=>x.replace(/^- /,'')).join(', ') : 'none')}`,
          `- topHardGuardBlockers: ${(top3HardGuardBlockers.length ? top3HardGuardBlockers.map((x)=>x.replace(/^- /,'')).join(', ') : 'none')}`,
          '',
          'NEAR-PASS / GUARD-BLOCKED',
          `- score>=threshold but hard-guard-blocked=${nearPassGuardBlocked.length} topGuardReason=${nearPassTopGuard}`,
          '',
          'TOP EXAMPLES',
          '- strongest failed momentum candidates:',
          ...(strongestFailedMomentumRows.length ? strongestFailedMomentumRows : ['- none']),
          '- strongest passed momentum candidates:',
          ...(strongestPassedMomentumRows.length ? strongestPassedMomentumRows : ['- none']),
          '',
          'LIQUIDITY DISTRIBUTION',
          `- <30k=${liqBandM.lt30} 30–40k=${liqBandM.b30_40} 40–50k=${liqBandM.b40_50} 50–75k=${liqBandM.b50_75} 75k+=${liqBandM.gte75}`,
          ...(repeatSuppressed > 0 ? [
            '',
            `REPEAT FAIL SUPPRESSION - count=${repeatSuppressed} mintsTop=${repeatMintsTop} reasonTop=${repeatReasonTop}`,
          ] : []),
        ].join('\n');
      }

      const routeable = Number(candidateRouteableWin.length || 0);
      const pairFetchReq = Number(providers?.birdeye?.requests || 0);
      const pairFetchHit = Number(providers?.birdeye?.hits || 0);
      const pairFetchRate = pairFetchReq > 0 ? `${Math.round((pairFetchHit / pairFetchReq) * 100)}%` : 'n/a';
      const preHotConsidered = Number(counters?.watchlist?.preHotConsidered || 0);
      const preHotPassed = Number(counters?.watchlist?.preHotPassed || 0);
      const preHotFailed = Number(counters?.watchlist?.preHotFailed || 0);
      const hotEnq = Number(counters?.watchlist?.hotEnqueued || 0);
      const hotCons = Number(counters?.watchlist?.hotConsumed || 0);

      const blockerTop5 = Object.entries(blockerCounts1h)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)
        ).slice(0,5);
      const primaryChokeRaw = blockerTop5[0]?.[0] || 'none';
      const primaryChoke = blockerRename(primaryChokeRaw);
      const chokeStage = String(primaryChokeRaw || 'none').split('.')[0] || 'none';
      const top5Blockers = blockerTop5.map(([k,v])=>`- ${blockerRename(k)} = ${v}`);

      const preHotMinLiqActive = Number(state?.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 0);
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

      return [
        `🧪 *Diag (compact)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`, 
        'SYSTEM',
        `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} scansPerHour=${warmingUp ? 'warming_up' : scansPerHourWindow.toFixed(1)} watchlistSize=${watchlistSize} hotDepth=${hotDepth} evalsPerMinute=${warmingUp ? 'warming_up' : evalsPerMinute.toFixed(2)} status=${warmingUp ? 'warming_up' : 'ready'}`,
        `providers: birdeye=${providerRate(providers?.birdeye)} jupiter=${providerRate(providers?.jupiter)} dex=${providerRate(providers?.dexscreener)}`,
        `scannerSummary: scansPerHour=${warmingUp ? 'warming_up' : scansPerHourWindow.toFixed(1)} scannerHealth=${scannerHealth} uniqueCandidatesSeen=${uniqueCandidatesSeen} uniqueCandidatesAboveHotFloor=${uniqueAboveHotFloor}`,
        '',
        'PIPELINE HEALTH',
        `routeable=${routeable} pairFetchOkRate=${pairFetchRate} preHot considered/passed/failed=${preHotConsidered}/${preHotPassed}/${preHotFailed} hot enqueued/consumed=${hotEnq}/${hotCons} momentumEvaluated=${cumulativeMomentumEvaluated} confirmReached=${cumulativeConfirmReached} attemptReached=${cumulativeAttempt} fill=${cumulativeFill}`,
        '',
        'PRIMARY CHOKE',
        `primaryChoke=${primaryChoke} chokeStage=${chokeStage}`,
        ...(top5Blockers.length ? top5Blockers : ['- none']),
        '',
        'CANDIDATE SHAPE',
        `preHotLiquidityThresholdActive=${Math.round(preHotMinLiqActive)} source=${state?.filterOverrides?.MIN_LIQUIDITY_USD != null ? 'filterOverride.MIN_LIQUIDITY_USD' : 'cfg.MIN_LIQUIDITY_FLOOR_USD'} hotStalkingFloor=${Math.round(hotStalkingFloor)} bypassAllowed=${bypassAllowed} bypassRejected=${bypassRejected} bypassPrimaryReject=${bypassPrimaryReject}`,
        `stalkableCandidates=${stalkableCandidates} stalkableBandBreakdown(>=hotFloor): 30–50k=${stalkableBand.b30_50} 50–75k=${stalkableBand.b50_75} 75k+=${stalkableBand.gte75}`,
        `liqBand(${liqBandFromMomentum ? 'momentum' : 'watchlist'}): <30k=${liqBand.lt30} 30–50k=${liqBand.b30_50} 50–75k=${liqBand.b50_75} 75k+=${liqBand.gte75}`,
        '',
        'DOWNSTREAM',
        `momentumRule=mature:3_of_4 early(<30m):2_of_3`,
        downstreamShort,
        '',
        'RECENT EXAMPLES',
        ...(examples.length ? examples : ['- none']),
      ].join('\n');
    }
    state.runtime ||= {};
    if (!Number.isFinite(Number(state.runtime.botStartTimeMs || 0))) state.runtime.botStartTimeMs = nowMs;
    const botStartTimeMs = Number(state.runtime.botStartTimeMs || nowMs);
    const useWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : null;
    const windowStartMs = useWindowHours ? (nowMs - (useWindowHours * 3_600_000)) : botStartTimeMs;
    const windowLabel = useWindowHours ? `${useWindowHours}h` : 'sinceStart';
    return [
      `🧪 *Diag Snapshot* window=${windowLabel} start=${fmtCt(windowStartMs)}`, 
      `snapshotAt=${updatedIso} staleness=${ageSec == null ? 'n/a' : `${ageSec}s`} buildMs=${diagSnapshot.builtInMs}`,
      diagSnapshot.message,
    ].join('\n');
  }

  function splitForTelegram(text, maxLen = 3500) {
    const s = String(text || '');
    if (s.length <= maxLen) return [s];
    const out = [];
    let rest = s;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf('\n', maxLen);
      if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest.length) out.push(rest);
    return out;
  }

  async function tgSendChunked(cfg, text) {
    const parts = splitForTelegram(text, 3500);
    for (let i = 0; i < parts.length; i++) {
      const head = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
      await tgSend(cfg, `${head}${parts[i]}`);
    }
  }

  async function sendPositionsReport() {
    const openEntries = Object.entries(state.positions || {}).filter(([, p]) => p?.status === 'open');
    if (!openEntries.length) {
      await tgSend(cfg, '📌 *Positions*\n\nNone open.');
      return;
    }

    const lines = [];
    for (const [mint, p] of openEntries) {
      let tokenName = String(p?.tokenName || '').trim();
      let tokenSymbol = String(p?.symbol || '').trim();
      const stop = Number(p?.stopPriceUsd || 0);
      const peak = Math.max(
        Number(p?.peakPriceUsd || 0),
        Number(p?.lastPeakPrice || 0),
        Number(p?.trailingAnchor || 0),
        0,
      );

      let dec = Number(p?.decimals);
      let livePrice = Number(p?.lastSeenPriceUsd || 0);
      try {
        const snap = await birdseye?.getTokenSnapshot?.(mint);
        const d = Number(snap?.raw?.decimals);
        if (Number.isFinite(d) && d >= 0) dec = d;
        const px = Number(snap?.priceUsd || 0);
        if (px > 0) livePrice = px;
        if (!tokenName) tokenName = String(snap?.raw?.name || '').trim();
        if (!tokenSymbol) tokenSymbol = String(snap?.raw?.symbol || '').trim();
      } catch {}

      let liveRaw = Number(p?.onchain?.amount || 0);
      try {
        const bal = await getSplBalance(conn, pub, mint);
        if (bal?.fetchOk !== false && Number(bal?.amount || 0) >= 0) liveRaw = Number(bal.amount || 0);
      } catch {}

      const recvRaw = Number(p?.receivedTokensRaw || 0);
      const basisRaw = recvRaw > 0 ? recvRaw : liveRaw;
      const basisTokens = (basisRaw > 0 && Number.isFinite(dec) && dec >= 0) ? (basisRaw / (10 ** dec)) : null;
      const liveTokens = (liveRaw > 0 && Number.isFinite(dec) && dec >= 0) ? (liveRaw / (10 ** dec)) : null;

      const spentUsd = (Number(p?.spentSolApprox || 0) > 0 && Number(p?.solUsdAtEntry || 0) > 0)
        ? (Number(p.spentSolApprox) * Number(p.solUsdAtEntry))
        : null;
      const basisPx = (basisTokens && spentUsd) ? (spentUsd / basisTokens) : Number(p?.entryPriceUsd || 0) || null;
      const pnlPct = (basisPx && livePrice > 0) ? (((livePrice - basisPx) / basisPx) * 100) : null;
      const estValue = (liveTokens && livePrice > 0) ? (liveTokens * livePrice) : null;

      const label = tokenDisplayName({ name: tokenName, symbol: tokenSymbol, mint });
      lines.push(`• ${label} (${mint.slice(0,6)}…)`);
      if (tokenName || tokenSymbol) lines.push(`  name=${tokenName || 'n/a'} symbol=${tokenSymbol || 'n/a'}`);
      lines.push(`  stop=$${stop.toFixed(6)} last=$${livePrice.toFixed(6)} peak=$${peak.toFixed(6)}`);
      lines.push(`  trailing=${p?.trailingActive ? 'on' : 'off'} trailPct=${Number.isFinite(Number(p?.activeTrailPct)) ? `${(Number(p.activeTrailPct)*100).toFixed(1)}%` : 'n/a'}`);
      lines.push(`  basis=${basisPx ? `$${basisPx.toFixed(10)}` : 'n/a'} source=${p?.entryPriceSource || 'unknown'} tokens=${liveTokens ? liveTokens.toFixed(5) : 'n/a'} spent≈${spentUsd != null ? fmtUsd(spentUsd) : 'n/a'}`);
      lines.push(`  estValue=${estValue != null ? fmtUsd(estValue) : 'n/a'} pnl=${pnlPct != null ? `${pnlPct.toFixed(2)}%` : 'n/a'}`);
    }

    const msg = `📌 *Positions* (${openEntries.length})\n\n` + lines.join('\n');
    if (msg.length <= 3500) {
      await tgSend(cfg, msg);
    } else {
      const chunks = [];
      let cur = `📌 *Positions* (${openEntries.length})\n\n`;
      for (const line of lines) {
        if ((cur + line + '\n').length > 3200) {
          chunks.push(cur);
          cur = '';
        }
        cur += line + '\n';
      }
      if (cur.trim()) chunks.push(cur);
      for (const ch of chunks) await tgSend(cfg, ch);
    }
  }

  refreshDiagSnapshot(Date.now());

  // Periodic observability summary (every 5 minutes)
  if (!globalTimers.heartbeatLoop) {
    globalTimers.heartbeatLoop = setInterval(() => {
      try {
        const entriesMinute = (counters.watchlist && counters.watchlist.funnelMinute) ? counters.watchlist.funnelMinute.watchlistSeen : (counters.scanned || 0);
        const entriesHourEstimate = entriesMinute * 60;
        const queueSize = Number(state.exposure?.queue?.length || 0);
        const snapshotFailures = Number(state.marketData?.providers?.birdeye?.rejects || 0) + Number(state.marketData?.providers?.dexscreener?.rejects || 0) + Number(state.marketData?.providers?.jupiter?.rejects || 0);
        const cuStats = (birdseye && typeof birdseye.getStats === 'function') ? birdseye.getStats(Date.now()) : null;
        const cuEstimate = cuStats ? Number(cuStats.projectedDailyCu || 0) : null;
        const regimeExposure = state.exposure?.activeRunnerCount || 0;
        const msg = `OBSERVABILITY ─ entries/hour≈${entriesHourEstimate} queueSize=${queueSize} snapshotFailures=${snapshotFailures} projectedDailyCu=${cuEstimate || 'n/a'} activeRunners=${regimeExposure}`;
        console.log(msg);
        pushDebug(state, { t: nowIso(), reason: 'observability', msg, counters: { entriesMinute, queueSize, snapshotFailures, cuEstimate, regimeExposure } });
        saveState(cfg.STATE_PATH, state);
      } catch (e) {
        console.warn('[observability] failed', e?.message || e);
      }
    }, 5 * 60_000);
    if (globalTimers.heartbeatLoop.unref) globalTimers.heartbeatLoop.unref();
  }

  // Cached spend summaries to keep /spend off the hot loop path.
  const SPEND_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SPEND_CACHE_TTL_MS || 5 * 60_000));
  const spendSummaryCache = {
    loadedAtMs: 0,
    summaries: new Map(),
    inFlight: false,
    lastError: null,
  };
  function refreshSpendSummaryCacheAsync() {
    if (spendSummaryCache.inFlight) return;
    spendSummaryCache.inFlight = true;
    Promise.resolve().then(() => {
      const events = readLedger(cfg.LEDGER_PATH);
      const next = new Map();
      for (const key of ['last', '24h', '7d', '30d']) {
        next.set(key, summarize(events, parseRange(key)));
      }
      spendSummaryCache.summaries = next;
      spendSummaryCache.loadedAtMs = Date.now();
      spendSummaryCache.lastError = null;
    }).catch((e) => {
      spendSummaryCache.lastError = safeErr(e).message;
    }).finally(() => {
      spendSummaryCache.inFlight = false;
    });
  }

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
      lastPositionsLoopAtMs: lastPos || null,
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

  // Jupiter token list cache (candidate universe expansion)
  let jupTokens = null;
  let jupTokensAt = 0;
  let trendingTokens = [];
  let trendingFetchedAt = 0;
  let marketTrendingTokens = [];
  let marketTrendingFetchedAt = 0;
  let birdEyeBoostedTokens = [];
  let birdEyeBoostedFetchedAt = 0;

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

  while (true) {
    const t = Date.now();
    rollWatchlistMinuteWindow(counters, t);

    _loopDtMs = t - _loopPrevAtMs;
    _loopPrevAtMs = t;

    if (t - lastDiagSnapshotAt >= DIAG_SNAPSHOT_EVERY_MS) {
      lastDiagSnapshotAt = t;
      refreshDiagSnapshot(t);
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
    if (t - lastPos >= cfg.POSITIONS_EVERY_MS) {
      lastPos = t;

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
          Promise.resolve(tgSendChunked(cfg, msg)).catch((e) => {
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
          // Pull DexScreener boosted candidates
          const _tCandidateDiscovery = Date.now();
          const _tSourcePolling = Date.now();
          let boostedRaw = [];
          globalThis.__lastBoostedRaw = globalThis.__lastBoostedRaw || [];
          globalThis.__lastBoostedAt = globalThis.__lastBoostedAt || 0;

          // Primary discovery feeds (BirdEye): token_trending, token_market_trending, token_boosted
          if (cfg.BIRDEYE_API_KEY) {
            try {
              const beRefreshMs = Number(cfg.TRENDING_REFRESH_MS || 90_000);
              const parseBeRows = (j) => {
                const rows = Array.isArray(j?.data?.tokens) ? j.data.tokens
                  : (Array.isArray(j?.data?.items) ? j.data.items
                    : (Array.isArray(j?.data) ? j.data
                      : (Array.isArray(j?.tokens) ? j.tokens : [])));
                return rows.map((x) => ({
                  mint: String(x?.address || x?.mint || x?.tokenAddress || '').trim(),
                  liquidity: Number(x?.liquidity ?? x?.liquidityUsd ?? x?.liquidity_usd ?? 0),
                  volume24hUsd: Number(x?.volume24hUSD ?? x?.v24hUSD ?? x?.volume24h ?? x?.volume_24h_usd ?? 0),
                  rank: Number(x?.rank ?? x?.trendingRank ?? 0),
                  symbol: String(x?.symbol || ''),
                })).filter((x) => !!x.mint);
              };
              const beHeaders = {
                accept: 'application/json',
                'x-chain': 'solana',
                'X-API-KEY': String(cfg.BIRDEYE_API_KEY || ''),
              };

              if (!Array.isArray(trendingTokens) || !trendingFetchedAt || (t - trendingFetchedAt) > beRefreshMs) {
                const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
                const r = await fetch(`https://public-api.birdeye.so/defi/token_trending?${q.toString()}`, { headers: beHeaders });
                const j = await r.json().catch(() => ({}));
                trendingTokens = parseBeRows(j);
                trendingFetchedAt = t;
              }

              if (!Array.isArray(marketTrendingTokens) || !marketTrendingFetchedAt || (t - marketTrendingFetchedAt) > beRefreshMs) {
                const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
                const r = await fetch(`https://public-api.birdeye.so/defi/token_market_trending?${q.toString()}`, { headers: beHeaders });
                const j = await r.json().catch(() => ({}));
                marketTrendingTokens = parseBeRows(j);
                marketTrendingFetchedAt = t;
              }

              if (!Array.isArray(birdEyeBoostedTokens) || !birdEyeBoostedFetchedAt || (t - birdEyeBoostedFetchedAt) > beRefreshMs) {
                const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
                const r = await fetch(`https://public-api.birdeye.so/defi/token_boosted?${q.toString()}`, { headers: beHeaders });
                const j = await r.json().catch(() => ({}));
                birdEyeBoostedTokens = parseBeRows(j);
                birdEyeBoostedFetchedAt = t;
              }

              const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};
              const appendRows = (rows, source, sampleN) => {
                const n = Math.max(0, Math.min(Number(sampleN || 0), Number(rows?.length || 0)));
                for (const row of (rows || []).slice(0, n)) {
                  if (wlMints[row.mint]) continue;
                  boostedRaw.push({
                    tokenAddress: row.mint,
                    tokenSymbol: row.symbol || null,
                    liquidityUsd: Number(row.liquidity || 0),
                    volume24hUsd: Number(row.volume24hUsd || 0),
                    rank: Number(row.rank || 0),
                    _source: source,
                  });
                }
              };
              appendRows(trendingTokens, 'trending', Number(cfg.SOURCE_QUALITY_TRENDING_SAMPLE_N || 10));
              appendRows(marketTrendingTokens, 'market_trending', Number(process.env.SOURCE_QUALITY_MARKET_TRENDING_SAMPLE_N || 10));
              appendRows(birdEyeBoostedTokens, 'birdseye_boosted', Number(process.env.SOURCE_QUALITY_BOOSTED_SAMPLE_N || 10));
            } catch (e) {
              pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'BE_DISCOVERY', reason: `birdseyeDiscoveryFeeds(${safeMsg(e)})` });
            }
          }

          // Secondary discovery feed: DexScreener boosted candidates
          try {
            const _tBoost = Date.now();
            const dexBoosted = [
              ...(await getBoostedTokens('latest')),
              ...(await getBoostedTokens('top')),
            ];
            markCallDuration(_tBoost);
            boostedRaw.push(...dexBoosted);
            globalThis.__lastBoostedRaw = dexBoosted;
            globalThis.__lastBoostedAt = t;
            circuitClear({ state, nowMs: t, dep: 'dex', persist: () => saveState(cfg.STATE_PATH, state) });
          } catch (e) {
            // DexScreener rate limit or temporary failure.
            bumpNoPairReason(counters, isDexScreener429(e) ? 'rateLimited' : 'providerEmpty', 'dex');
            pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'DEX', reason: `dexscreenerBoosted(${safeMsg(e)})` });
            circuitHit({ state, nowMs: t, dep: 'dex', note: `boosted(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
            // Fall back to last known DexScreener boosted list (up to 10m old)
            if (globalThis.__lastBoostedRaw?.length && (t - globalThis.__lastBoostedAt) < 10 * 60_000) {
              boostedRaw.push(...globalThis.__lastBoostedRaw);
            } else {
              const { waitMs, cooldownUntilMs } = hitDex429({
                state,
                nowMs: t,
                baseMs: 2 * 60_000,
                reason: 'dexscreenerBoosted(429?)',
                persist: () => saveState(cfg.STATE_PATH, state),
              });
              dexCooldownUntil = cooldownUntilMs;
              await tgSend(cfg, `⚠️ DexScreener rate-limited. Cooling down ${(waitMs/60_000).toFixed(1)}m before next scan; continuing with BirdEye/JUP sources.`);
            }
          }

          scanPhase.candidateSourcePollingMs += Math.max(0, Date.now() - _tSourcePolling);
          const _tSourceMerging = Date.now();
          const _tSourceTransforms = Date.now();
          boostedRaw = (boostedRaw || []).map((x) => ({ ...x, _source: x?._source || 'dex' }));
          scanPhase.candidateSourceTransformsMs += Math.max(0, Date.now() - _tSourceTransforms);

          // Optional staging stream feed (laserstream-devnet).
          const _tStreamDrain = Date.now();
          const streamed = streamingProvider?.drainCandidates?.(120) || [];
          scanPhase.candidateStreamDrainMs += Math.max(0, Date.now() - _tStreamDrain);
          if (streamed.length) boostedRaw.push(...streamed);
          scanPhase.candidateSourceMergingMs += Math.max(0, Date.now() - _tSourceMerging);

          // BirdEye discovery feeds are pulled earlier as primary source inputs:
          // token_trending, token_market_trending, token_boosted.

          // Expand universe using Jupiter token list (non-boosted pool)
          if (cfg.JUP_TOKENLIST_ENABLED) {
            try {
              if (!jupTokens || (t - jupTokensAt) > cfg.JUP_TOKENLIST_CACHE_MS) {
                const _tTokenFetch = Date.now();
                jupTokens = await fetchJupTokenList(cfg.JUP_TOKENLIST_URL);
                scanPhase.candidateTokenlistFetchMs += Math.max(0, Date.now() - _tTokenFetch);
                jupTokensAt = t;
                circuitClear({ state, nowMs: t, dep: 'jup', persist: () => saveState(cfg.STATE_PATH, state) });
              }

              const _tTokenPool = Date.now();
              const pool = (jupTokens || []).filter(x => x.address && x.address !== cfg.SOL_MINT);
              scanPhase.candidateTokenlistPoolBuildMs += Math.max(0, Date.now() - _tTokenPool);
              const qualityFirst = cfg.SOURCE_MODE === 'quality_first';
              const sampleN = Math.max(0, Math.min(qualityFirst ? cfg.SOURCE_QUALITY_JUP_SAMPLE_N : cfg.JUP_TOKENLIST_SAMPLE_N, pool.length));

              if (!qualityFirst || !cfg.SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE) {
                const _tTokenSampling = Date.now();
                for (let i = 0; i < sampleN; i++) {
                  const pick = pool[Math.floor(Math.random() * pool.length)];
                  if (!pick?.address) continue;
                  boostedRaw.push({
                    tokenAddress: pick.address,
                    tokenSymbol: pick.symbol,
                    _source: 'jup',
                  });
                }
                scanPhase.candidateTokenlistSamplingMs += Math.max(0, Date.now() - _tTokenSampling);
              } else {
                const maxAttempts = Math.max(sampleN, sampleN * 4);
                const picked = new Set();
                const picks = [];
                const _tTokenSampling = Date.now();
                for (let i = 0; i < maxAttempts && picks.length < maxAttempts; i++) {
                  const pick = pool[Math.floor(Math.random() * pool.length)];
                  if (!pick?.address || picked.has(pick.address)) continue;
                  picked.add(pick.address);
                  picks.push(pick);
                }
                scanPhase.candidateTokenlistSamplingMs += Math.max(0, Date.now() - _tTokenSampling);

                state.runtime ||= {};
                state.runtime.tokenlistQuoteCache ||= {};
                state.runtime.tokenlistLiqCache ||= {};
                const quoteCache = state.runtime.tokenlistQuoteCache;
                const liqCache = state.runtime.tokenlistLiqCache;
                const quoteCacheTtlMs = Math.max(15_000, Number(process.env.TOKENLIST_QUOTE_CACHE_TTL_MS || 180_000));
                const liqCacheTtlMs = Math.max(15_000, Number(process.env.TOKENLIST_LIQ_CACHE_TTL_MS || 90_000));
                const quoteCheckConcurrency = Math.max(1, Math.min(8, Number(process.env.TOKENLIST_QUOTE_CHECK_CONCURRENCY || 4)));
                const hotFloorForTokenlist = Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40_000);
                const nowCache = Date.now();
                for (const [m, e] of Object.entries(quoteCache)) {
                  if ((nowCache - Number(e?.atMs || 0)) > quoteCacheTtlMs) delete quoteCache[m];
                }
                for (const [m, e] of Object.entries(liqCache)) {
                  if ((nowCache - Number(e?.atMs || 0)) > liqCacheTtlMs) delete liqCache[m];
                }

                const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                let hitRateLimit = false;
                const resolved = [];
                await mapWithConcurrency(picks, quoteCheckConcurrency, async (pick) => {
                  const mint = String(pick?.address || '');
                  if (!mint) return;

                  let liqUsd = Number(pick?.liquidityUsd || pick?.liquidity || 0);
                  if (!(liqUsd > 0)) {
                    const liqCached = liqCache[mint];
                    if (liqCached && (Date.now() - Number(liqCached?.atMs || 0)) <= liqCacheTtlMs) {
                      liqUsd = Number(liqCached?.liqUsd || 0);
                    }
                  }
                  if (!(liqUsd > 0) && birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
                    try {
                      const snap = await birdseye.getTokenSnapshot(mint);
                      liqUsd = Number(snap?.liquidityUsd || snap?.pair?.liquidity?.usd || 0);
                      const _tLiqWrite = Date.now();
                      liqCache[mint] = { atMs: Date.now(), liqUsd };
                      scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tLiqWrite);
                    } catch {}
                  }

                  if (!(liqUsd >= hotFloorForTokenlist)) {
                    scanPhase.tokenlistCandidatesFilteredByLiquidity += 1;
                    scanPhase.tokenlistQuoteChecksSkipped += 1;
                    resolved.push({ pick, routeable: false, liquidityFiltered: true });
                    return;
                  }

                  const _tCacheRead = Date.now();
                  const cached = quoteCache[mint];
                  scanPhase.candidateCacheReadsMs += Math.max(0, Date.now() - _tCacheRead);
                  if (cached && (Date.now() - Number(cached?.atMs || 0)) <= quoteCacheTtlMs) {
                    resolved.push({ pick, routeable: !!cached.routeable });
                    return;
                  }
                  const _tQuoteable = Date.now();
                  scanPhase.tokenlistQuoteChecksPerformed += 1;
                  try {
                    const q = await getRouteQuoteWithFallback({
                      cfg,
                      mint,
                      amountLamports: lam,
                      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                      solUsdNow,
                      source: 'tokenlist-quality-gate',
                    });
                    scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
                    const routeable = !!q?.routeAvailable;
                    const _tCacheWrite = Date.now();
                    quoteCache[mint] = { atMs: Date.now(), routeable };
                    scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tCacheWrite);
                    resolved.push({ pick, routeable });
                  } catch (e) {
                    scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
                    if (isJup429(e) || isDexScreener429(e)) hitRateLimit = true;
                    const _tCacheWrite = Date.now();
                    quoteCache[mint] = { atMs: Date.now(), routeable: false };
                    scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tCacheWrite);
                    resolved.push({ pick, routeable: false });
                  }
                });

                if (hitRateLimit) {
                  hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'qualitySourceJupGate(429)', persist: () => saveState(cfg.STATE_PATH, state) });
                }

                let accepted = 0;
                for (const r of resolved) {
                  if (!r?.routeable) continue;
                  boostedRaw.push({ tokenAddress: r.pick.address, tokenSymbol: r.pick.symbol, _source: 'jup' });
                  accepted += 1;
                  if (accepted >= sampleN) break;
                }
              }
            } catch (e) {
              pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'JUP', reason: `jupTokenList(${safeMsg(e)})` });
              circuitHit({ state, nowMs: t, dep: 'jup', note: `tokenlist(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
              if (!globalThis.__lastJupFailPingAt || (t - globalThis.__lastJupFailPingAt) > 30 * 60_000) {
                globalThis.__lastJupFailPingAt = t;
                await tgSend(cfg, '⚠️ Jupiter token list fetch is failing right now, so we are not getting JUP-sourced candidates yet.');
              }
            }
          }

          // Dedupe by mint and build a candidate list first, then rank.
          const _tDedupe = Date.now();
          const _tIteration = Date.now();
          const seen = new Set();
          const boosted = [];
          for (const tok of boostedRaw) {
            const m = tok?.tokenAddress;
            if (!m || seen.has(m)) continue;
            seen.add(m);
            boosted.push(tok);
            if (boosted.length >= 80) break;
          }
          scanPhase.candidateDedupeMs += Math.max(0, Date.now() - _tDedupe);
          scanPhase.candidateIterationMs += Math.max(0, Date.now() - _tIteration);
          scanPhase.candidateDiscoveryMs += Math.max(0, Date.now() - _tCandidateDiscovery);

          const preCandidates = [];
          // Visibility ping (noisy)
          const visibilityPings = (state?.flags?.tgVisibilityPings ?? cfg.TG_VISIBILITY_PINGS);
          if (visibilityPings) {
            try {
              if (!globalThis.__lastEvalPingAt || (t - globalThis.__lastEvalPingAt) > 30 * 60_000) {
                globalThis.__lastEvalPingAt = t;
                await tgSend(cfg, `🔎 Scan cycle: boostedRaw=${boostedRaw.length} deduped=${boosted.length}`);
              }
            } catch {}
          }
          let dexHit429 = false;
          let jupHit429 = false;
          let jupRoutePrefilterDegraded = false;
          let jupRoutePrefilterDegradedReason = null;
          const noPairTemporary = ensureNoPairTemporaryState(state);
          const noPairDeadMints = ensureNoPairDeadMintState(state);
          scanJupCooldownRemainingMs = Number(jupCooldownRemainingMs(state, t) || 0);
          scanJupCooldownActive = scanJupCooldownRemainingMs > 0;
          const routeFirstEnabled = cfg.JUP_PREFILTER_ENABLED || JUP_ROUTE_FIRST_ENABLED;
          const pairFetchQueue = [];
          counters.pairFetch.queueDepthPeak = Math.max(Number(counters.pairFetch.queueDepthPeak || 0), boosted.length);
          const _tRoutePrep = Date.now();
          for (const tok of boosted) {
            const mint = tok.tokenAddress;
            const candidateSource = normalizeCandidateSource(tok?._source || 'dex');
            bumpSourceCounter(counters, candidateSource, 'seen');
            pushScanCompactEvent('candidateSeen', { mint, source: candidateSource });
            const _tCooldown = Date.now();
            const deadMint = noPairDeadMints[mint];
            if (deadMint && Number(deadMint.untilMs || 0) > t) {
              bumpRouteCounter(counters, 'deadMintSkips');
              bumpNoPairReason(counters, 'deadMint', candidateSource);
              if (String(deadMint?.reason || '') === 'nonTradableMint') recordNonTradableMint(counters, mint, 'cooldownActive');
              pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair_deadMint(active:${Math.round((Number(deadMint.untilMs || 0) - t) / 1000)}s)` });
              continue;
            }
            if (deadMint && Number(deadMint.untilMs || 0) <= t) delete noPairDeadMints[mint];

            const tempNoPair = noPairTemporary[mint];
            if (tempNoPair && shouldSkipNoPairTemporary(tempNoPair, t)) {
              scanNoPairTempActiveCount += 1;
              bumpRouteCounter(counters, 'noPairTempSkips');
              pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair_temporary(active:${Math.round((tempNoPair.untilMs - t) / 1000)}s)` });
              continue;
            }
            if (tempNoPair && Number(tempNoPair.untilMs || 0) > t) {
              scanNoPairTempRevisitCount += 1;
              bumpRouteCounter(counters, 'noPairTempRevisits');
              pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair_temporary(revisit_due)` });
            }

            scanPhase.candidateCooldownFilteringMs += Math.max(0, Date.now() - _tCooldown);
            const prevAttempts = Math.max(0, Number(tempNoPair?.attempts || 0));
            const _tRouteLoopStart = Date.now();

            // Early shortlist prefilter: drop obvious low-value candidates before expensive pair fetch.
            // (1) If we already have a cached pair snapshot for this mint, and it shows too-low activity,
            //     skip refetching this cycle.
            const _tShortlistPrefilter = Date.now();
            if (cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE) {
              try {
                const cached = getCachedPairSnapshot({ state, mint, nowMs: t, maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS });
                const p = cached?.pair;
                if (p) {
                  const liq = Number(p?.liquidity?.usd || 0);
                  const tx1h = Number(p?.txns?.h1?.buys || 0) + Number(p?.txns?.h1?.sells || 0);
                  if ((liq > 0 && liq < cfg.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD) || (tx1h >= 0 && tx1h < cfg.EARLY_SHORTLIST_PREFILTER_MIN_TX1H)) {
                    bumpRouteCounter(counters, 'shortlistPrefilterDropped');
                    setNoPairTemporary(noPairTemporary, mint, { reason: 'shortlistCachedLowActivity', nowMs: t, attempts: prevAttempts + 1 });
                    pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `earlyPrefilter(cache liq=${liq.toFixed(0)} tx1h=${tx1h})` });
                    logCandidateDaily({
                      dir: cfg.CANDIDATE_LEDGER_DIR,
                      retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS,
                      event: { t: nowIso(), bot: 'candle-carl', mint, symbol: tok?.tokenSymbol || null, source: tok?._source || 'dex', outcome: 'reject', reason: `earlyPrefilter(cache liq=${liq.toFixed(0)} tx1h=${tx1h})` },
                    });
                    continue;
                  }
                }
              } catch {}

              // (2) Dex boost sanity: ignore tiny boosts (often low-liq / low-activity spam).
              if (shouldApplyEarlyShortlistPrefilter({ cfg, tok })) {
                const boostUsd = getBoostUsd(tok);
                if (boostUsd > 0 && boostUsd < cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD) {
                  bumpRouteCounter(counters, 'shortlistPrefilterDropped');
                  setNoPairTemporary(noPairTemporary, mint, { reason: 'shortlistBoostTooSmall', nowMs: t, attempts: prevAttempts + 1 });
                  pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `earlyPrefilter(boostUsd=${boostUsd.toFixed(2)} < ${cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD})` });
                  logCandidateDaily({
                    dir: cfg.CANDIDATE_LEDGER_DIR,
                    retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS,
                    event: { t: nowIso(), bot: 'candle-carl', mint, symbol: tok?.tokenSymbol || null, source: tok?._source || 'dex', outcome: 'reject', reason: `earlyPrefilter(boostUsd=${boostUsd.toFixed(2)})` },
                  });
                  continue;
                }
              }
            }
            scanPhase.candidateShortlistPrefilterMs += Math.max(0, Date.now() - _tShortlistPrefilter);

            if (cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE) bumpRouteCounter(counters, 'shortlistPrefilterPassed');

            // Early source-capture record (survives even if pair fetch/filters fail later).
            logCandidateDaily({
              dir: cfg.CANDIDATE_LEDGER_DIR,
              retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS,
              event: {
                t: nowIso(),
                bot: 'candle-carl',
                mint,
                symbol: tok?.tokenSymbol || null,
                source: tok?._source || 'dex',
                priceUsd: null,
                liqUsd: null,
                ageHours: null,
                mcapUsd: null,
                rugScore: null,
                v1h: null,
                v4h: null,
                buys1h: null,
                sells1h: null,
                tx1h: null,
                pc1h: null,
                pc4h: null,
                outcome: 'seen_source',
                reason: 'queued_for_pair_fetch',
              },
            });

            let hitRateLimit = false;
            let routeAvailable = null;
            let routeErrorKind = null;

            // Jupiter quoteability prefilter (cheap early reject)
            // If Jupiter is throttling, abort this scan cycle to avoid hammering both Jup and Dex.
            const _tRouteability = Date.now();
            if (routeFirstEnabled) {
              bumpRouteCounter(counters, 'prefilterChecks');
              const cachedRoute = getFreshRouteCacheEntry({ state, cfg, mint, nowMs: t });
              if (cachedRoute) {
                routeAvailable = true;
                bumpRouteCounter(counters, 'prefilterRouteable');
                bumpRouteCounter(counters, 'prefilterCacheHit');
              } else if (jupRoutePrefilterDegraded) {
                bumpRouteCounter(counters, 'prefilterSkippedDueJupCooldown');
              } else {
              const jupRemain = jupCooldownRemainingMs(state, t);
              if (jupRemain > 0) {
                jupHit429 = true;
                bumpRouteCounter(counters, 'prefilterRateLimited');
                if (!jupRoutePrefilterDegraded) {
                  jupRoutePrefilterDegraded = true;
                  jupRoutePrefilterDegradedReason = `cooldown:${Math.round(jupRemain / 1000)}s`;
                  pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `jupPrefilter(DEGRADED_COOLDOWN:${Math.round(jupRemain / 1000)}s)` });
                }
              }

              if (!jupRoutePrefilterDegraded) {
              try {
                const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                const route = await getRouteQuoteWithFallback({
                  cfg,
                  mint,
                  amountLamports: lam,
                  slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                  solUsdNow,
                  source: 'route-first-prefilter',
                });
                routeAvailable = !!route.routeAvailable;
                routeErrorKind = route.routeErrorKind || null;
                hitRateLimit = !!route.rateLimited;
                if (routeAvailable && route.quote) {
                  cacheRouteReadyMint({ state, cfg, mint, quote: route.quote, nowMs: t, source: `route-first-prefilter:${route.provider}` });
                }
                if (!routeAvailable) {
                  if (route.rateLimited) {
                    jupHit429 = true;
                    hitRateLimit = true;
                    bumpRouteCounter(counters, 'prefilterRateLimited');
                    if (!jupRoutePrefilterDegraded) {
                      jupRoutePrefilterDegraded = true;
                      jupRoutePrefilterDegradedReason = 'JUPITER_429';
                    }
                    pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: 'jupPrefilter(DEGRADED_JUPITER_429)' });
                    circuitHit({ state, nowMs: t, dep: 'jup', note: 'prefilter(JUPITER_429)', persist: () => saveState(cfg.STATE_PATH, state) });
                    hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'jupPrefilter(429)', persist: () => saveState(cfg.STATE_PATH, state) });
                    continue;
                  }
                  let recovered = false;
                  if (cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_REJECT_RECHECK_BURST_ENABLED && (cfg.AGGRESSIVE_MODE || prevAttempts >= 1)) {
                    const recheck = await quickRouteRecheck({
                      cfg,
                      mint,
                      solUsdNow,
                      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                      attempts: cfg.LIVE_REJECT_RECHECK_BURST_ATTEMPTS,
                      delayMs: cfg.LIVE_REJECT_RECHECK_BURST_DELAY_MS,
                      passes: cfg.LIVE_REJECT_RECHECK_PASSES,
                      passDelayMs: cfg.LIVE_REJECT_RECHECK_PASS_DELAY_MS,
                    });
                    recovered = !!recheck.recovered;
                    if (recovered) {
                      bumpRouteCounter(counters, 'rejectRecheckRecovered');
                    } else {
                      bumpRouteCounter(counters, 'rejectRecheckMisses');
                    }
                  }
                  if (!recovered) {
                    bumpRouteCounter(counters, 'prefilterRejected');
                    bumpNoPairReason(counters, 'routeNotFound', candidateSource);
                    setNoPairTemporary(noPairTemporary, mint, { reason: 'routeNotFound', nowMs: t, attempts: prevAttempts + 1 });
                    continue;
                  }
                }
                bumpRouteCounter(counters, 'prefilterRouteable');
              } catch (e) {
                // Emergency safety net — getRouteQuoteWithFallback should absorb all errors internally.
                // If we somehow land here, treat as an unexpected provider error and skip this candidate.
                pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `jupPrefilter(UNEXPECTED_ERR:${e?.message || e})` });
                bumpNoPairReason(counters, 'providerEmpty', candidateSource);
                setNoPairTemporary(noPairTemporary, mint, { reason: 'providerEmpty', nowMs: t, attempts: prevAttempts + 1 });
                continue;
              }
              }
              }
            }

            if (!routeFirstEnabled && JUP_SOURCE_PREFLIGHT_ENABLED && tok?._source === 'jup') {
              const cachedRoute = getFreshRouteCacheEntry({ state, cfg, mint, nowMs: t });
              if (cachedRoute) {
                routeAvailable = true;
              } else if (jupRoutePrefilterDegraded) {
                bumpRouteCounter(counters, 'prefilterSkippedDueJupCooldown');
              } else {
                try {
                const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                const route = await getRouteQuoteWithFallback({
                  cfg,
                  mint,
                  amountLamports: lam,
                  slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                  solUsdNow,
                  source: 'jup-source-preflight',
                });
                routeAvailable = !!route.routeAvailable;
                routeErrorKind = route.routeErrorKind || null;
                hitRateLimit = !!route.rateLimited;
                if (routeAvailable && route.quote) {
                  cacheRouteReadyMint({ state, cfg, mint, quote: route.quote, nowMs: t, source: `jup-source-preflight:${route.provider}` });
                }
                if (!routeAvailable) {
                  if (route.rateLimited) {
                    hitRateLimit = true;
                    jupHit429 = true;
                    if (!jupRoutePrefilterDegraded) {
                      jupRoutePrefilterDegraded = true;
                      jupRoutePrefilterDegradedReason = 'JUPITER_429';
                    }
                    pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: 'jupPreflight(DEGRADED_JUPITER_429)' });
                    circuitHit({ state, nowMs: t, dep: 'jup', note: 'preflight(JUPITER_429)', persist: () => saveState(cfg.STATE_PATH, state) });
                    hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'jupPreflight(429)', persist: () => saveState(cfg.STATE_PATH, state) });
                    continue;
                  }
                  bumpNoPairReason(counters, 'routeNotFound', candidateSource);
                  setNoPairTemporary(noPairTemporary, mint, { reason: 'routeNotFound', nowMs: t, attempts: prevAttempts + 1 });
                  continue;
                }
              } catch (e) {
                // Emergency safety net — getRouteQuoteWithFallback should absorb all errors internally.
                // If we somehow land here, treat as an unexpected provider error and skip this candidate.
                pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `jupPreflight(UNEXPECTED_ERR:${e?.message || e})` });
                bumpNoPairReason(counters, 'providerEmpty', candidateSource);
                setNoPairTemporary(noPairTemporary, mint, { reason: 'providerEmpty', nowMs: t, attempts: prevAttempts + 1 });
                continue;
              }
              }
            }

            scanRoutePrefilterDegraded = scanRoutePrefilterDegraded || jupRoutePrefilterDegraded;
            if (jupRoutePrefilterDegraded) {
              scanJupCooldownActive = true;
              scanJupCooldownRemainingMs = Math.max(scanJupCooldownRemainingMs, Number(jupCooldownRemainingMs(state, t) || 0));
            }

            scanPhase.candidateRouteabilityChecksMs += Math.max(0, Date.now() - _tRouteability);
            scanPhase.candidateOtherMs += Math.max(0, Date.now() - _tRouteLoopStart);
            if (routeAvailable === true) pushScanCompactEvent('candidateRouteable', { mint, source: candidateSource });
            pairFetchQueue.push({ tok, mint, candidateSource, routeAvailable, routeErrorKind, hitRateLimit, prevAttempts });
          }
          scanPhase.routePrepMs += Math.max(0, Date.now() - _tRoutePrep);

          if (jupHit429 && jupRoutePrefilterDegradedReason) {
            pushDebug(state, { t: nowIso(), reason: `scanDegraded(jupRoutePrefilter=${jupRoutePrefilterDegradedReason})` });
          }

          if (dexHit429) {
            // DexScreener is rate-limiting; skip ranking/execution this cycle.
            continue;
          }

          state.runtime ||= {};
          state.runtime.pairFetchGovernor ||= { degradedUntilMs: 0 };
          const basePairFetchConcurrency = Math.max(1, Math.min(8, Number(cfg.PAIR_FETCH_CONCURRENCY || 1)));
          const governorDegradedUntilMs = Number(state.runtime.pairFetchGovernor.degradedUntilMs || 0);
          const governorActive = governorDegradedUntilMs > t;
          const pairFetchConcurrency = governorActive
            ? Math.max(1, Math.floor(basePairFetchConcurrency * 0.6))
            : basePairFetchConcurrency;
          scanPairFetchConcurrency = pairFetchConcurrency;
          const routeAvailableImmediateRows = [];
          const routeAvailableImmediateRowMints = new Set();
          counters.pairFetch.queued += pairFetchQueue.length;
          counters.pairFetch.queueDepthPeak = Math.max(Number(counters.pairFetch.queueDepthPeak || 0), pairFetchQueue.length);
          const _tPairFetch = Date.now();
          await mapWithConcurrency(pairFetchQueue, pairFetchConcurrency, async (item) => {
            const { tok, mint, candidateSource, prevAttempts } = item;
            let { routeAvailable, routeErrorKind, hitRateLimit } = item;
            const startedAt = Date.now();
            let snapshot = null;
            let pair = null;
            let attemptsUsed = 0;
            const maxAttempts = effectiveNoPairRetryAttempts();
            const _tSnapshotBuild = Date.now();
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              attemptsUsed = attempt;
              const _tSnapFetch = Date.now();
              snapshot = await getMarketSnapshot({
                state,
                mint,
                nowMs: Date.now(),
                maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS,
                getTokenPairs,
                pickBestPair,
                birdeyeEnabled: birdseye.enabled,
                getBirdseyeSnapshot: birdseye.getTokenSnapshot,
              });
              const _snapFetchDur = Math.max(0, Date.now() - _tSnapFetch);
              if (String(snapshot?.source || '').toLowerCase().includes('bird')) scanPhase.snapshotBirdseyeFetchMs += _snapFetchDur;
              else scanPhase.snapshotPairEnrichmentMs += _snapFetchDur;
              pair = snapshot?.pair || null;
              if (snapshot?.priceUsd && pair) break;
              const elapsed = Date.now() - startedAt;
              if (elapsed >= NO_PAIR_RETRY_TOTAL_BUDGET_MS) break;
              if (attempt < maxAttempts) {
                const waitMs = jitter(Math.min(NO_PAIR_RETRY_MAX_BACKOFF_MS, NO_PAIR_RETRY_BASE_MS * (2 ** (attempt - 1))), 0.35);
                const remainingBudgetMs = Math.max(0, NO_PAIR_RETRY_TOTAL_BUDGET_MS - elapsed);
                if (remainingBudgetMs < 25) break;
                await new Promise(r => setTimeout(r, Math.max(10, Math.min(waitMs, remainingBudgetMs))));
              }
            }

            const _snapshotBuildDur = Math.max(0, Date.now() - _tSnapshotBuild);
            scanPhase.snapshotBuildMs += _snapshotBuildDur;
            if (String(snapshot?.source || '').toLowerCase().includes('bird')) scanPhase.birdeyeMs += _snapshotBuildDur;

            counters.pairFetch.started += 1;
            counters.pairFetch.attempts += attemptsUsed;
            counters.pairFetch.completed += 1;
            counters.pairFetch.latencySamples += 1;
            counters.pairFetch.latencyMsTotal += Math.max(0, Date.now() - startedAt);

            if (!snapshot?.priceUsd) {
              counters.pairFetch.failed += 1;
              if (routeAvailable == null) {
                try {
                  const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                  const route = await getRouteQuoteWithFallback({
                    cfg,
                    mint,
                    amountLamports: lam,
                    slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                    solUsdNow,
                    source: 'pairfetch-fallback',
                  });
                  routeAvailable = !!route.routeAvailable;
                  routeErrorKind = route.routeErrorKind || null;
                  hitRateLimit = !!route.rateLimited;
                  if (routeAvailable && route.quote) {
                    cacheRouteReadyMint({ state, cfg, mint, quote: route.quote, nowMs: t, source: `pairfetch-fallback:${route.provider}` });
                  }
                } catch (e) {
                  routeErrorKind = parseJupQuoteFailure(e);
                  hitRateLimit = isJup429(e) || isDexScreener429(e);
                }
              }

              if (routeAvailable) {
                pushScanCompactEvent('candidateRouteable', { mint, source: candidateSource });
                bumpRouteCounter(counters, 'routeableByJupiter');
                setNoPairTemporary(noPairTemporary, mint, { reason: 'routeAvailable', nowMs: t, attempts: prevAttempts + 1 });
                const promoted = await promoteRouteAvailableCandidate({
                  state,
                  cfg,
                  counters,
                  nowMs: t,
                  tok,
                  mint,
                  immediateRows: routeAvailableImmediateRows,
                  immediateRowMints: routeAvailableImmediateRowMints,
                  birdseye,
                });
                pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: promoted ? 'routeAvailable(viaJupiter,promotedWatchlist)' : 'routeAvailable(viaJupiter)' });
                logCandidateDaily({
                  dir: cfg.CANDIDATE_LEDGER_DIR,
                  retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS,
                  event: { t: nowIso(), bot: 'candle-carl', mint, symbol: tok?.tokenSymbol || null, source: tok?._source || 'dex', outcome: promoted ? 'watchlist_promoted' : 'noPair_temporary', reason: promoted ? 'routeAvailable(viaJupiter,promotedWatchlist)' : 'routeAvailable(viaJupiter)' },
                });
                return;
              }

              const noPairReason = classifyNoPairReason({
                state,
                mint,
                nowMs: t,
                maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS,
                routeAvailable,
                routeErrorKind,
                hitRateLimit,
              });
              if (noPairReason === 'rateLimited') counters.pairFetch.rateLimited += 1;
              bumpNoPairReason(counters, noPairReason, candidateSource);
              setNoPairTemporary(noPairTemporary, mint, { reason: noPairReason, nowMs: t, attempts: prevAttempts + 1 });
              if (noPairReason === 'nonTradableMint' || noPairReason === 'deadMint') {
                if (noPairReason === 'nonTradableMint') recordNonTradableMint(counters, mint, 'rejected');
                const strikes = Number(noPairDeadMints[mint]?.strikes || 0) + 1;
                const untilMs = strikes >= NO_PAIR_DEAD_MINT_STRIKES ? (t + NO_PAIR_DEAD_MINT_TTL_MS) : (t + NO_PAIR_NON_TRADABLE_TTL_MS);
                noPairDeadMints[mint] = { untilMs, atMs: t, strikes, reason: noPairReason };
              }
              pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair(${noPairReason})` });
              logCandidateDaily({
                dir: cfg.CANDIDATE_LEDGER_DIR,
                retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS,
                event: { t: nowIso(), bot: 'candle-carl', mint, symbol: tok?.tokenSymbol || null, source: tok?._source || 'dex', outcome: 'reject', reason: `noPair(${noPairReason})` },
              });
              return;
            }

            if (!pair) {
              scanUsableSnapshotWithoutPairCount += 1;
              pair = snapshot?.pair || {
                baseToken: { address: mint, symbol: tok?.tokenSymbol || null },
                pairCreatedAt: Number(snapshot?.pairCreatedAt || 0) || null,
                priceUsd: Number(snapshot?.priceUsd || 0) || null,
                liquidity: { usd: Number(snapshot?.liquidityUsd || 0) || 0 },
                txns: { h1: { buys: 0, sells: 0 } },
                volume: { h1: 0, h4: 0 },
                priceChange: { h1: 0, h4: 0 },
              };
            }

            counters.pairFetch.success += 1;
            delete noPairTemporary[mint];
            delete noPairDeadMints[mint];

            const _tNorm = Date.now();
            const liqUsd = Number(snapshot?.liquidityUsd || pair?.liquidity?.usd || 0);
            const mcapUsdNorm = Number(snapshot?.marketCapUsd || pair?.marketCap || pair?.fdv || 0);
            const v1h = Number(pair?.volume?.h1 || 0);
            const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
            const pc1h = Number(pair?.priceChange?.h1 || 0);
            scanPhase.snapshotLiqMcapNormalizationMs += Math.max(0, Date.now() - _tNorm);

            const _tValidate = Date.now();
            void mcapUsdNorm;
            void getSnapshotStatus(snapshot);
            scanPhase.snapshotValidationMs += Math.max(0, Date.now() - _tValidate);
            pushScanCompactEvent('candidateLiquiditySeen', { mint, source: candidateSource, liqUsd });

            // Score: favor tradability + activity (liq, volume, tx, mild price move)
            const score = (Math.log10(Math.max(liqUsd, 1)) * 3) + (Math.log10(Math.max(v1h, 1)) * 2) + (Math.log10(Math.max(tx1h, 1)) * 2) + (Math.max(0, pc1h) * 0.2);

            bumpSourceCounter(counters, candidateSource, 'passedPair');
            preCandidates.push({ tok, mint, pair, snapshot, score, routeHint: routeAvailable === true });
          });

          const rateLimitedNow = Number(counters?.pairFetch?.rateLimited || 0) + Number(counters?.reject?.noPairReasons?.rateLimited || 0);
          const rateLimitedDelta = Math.max(0, rateLimitedNow - Number(scanRateLimitedStart || 0));
          const governorShouldDegrade = rateLimitedDelta > 0 || jupRoutePrefilterDegraded;
          if (governorShouldDegrade) {
            state.runtime.pairFetchGovernor.degradedUntilMs = Math.max(
              Number(state.runtime.pairFetchGovernor.degradedUntilMs || 0),
              t + 120_000,
            );
          }
          scanPhase.pairFetchMs += Math.max(0, Date.now() - _tPairFetch);

          const _tShortlist = Date.now();
          preCandidates.sort((a, b) => b.score - a.score);
          scanCandidatesFound = Number(preCandidates.length || 0);
          if (cfg.AGGRESSIVE_MODE) {
            preCandidates.sort((a, b) => {
              const ar = a.routeHint ? 1 : 0;
              const br = b.routeHint ? 1 : 0;
              return (br - ar) || (b.score - a.score);
            });
          }

          // High-conversion profile: small bounded quote fanout for top-ranked candidates.
          if (cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_PARALLEL_QUOTE_FANOUT_N > 0 && preCandidates.length > 1) {
            const fanoutN = Math.min(cfg.LIVE_PARALLEL_QUOTE_FANOUT_N, preCandidates.length);
            const fanoutSet = preCandidates.slice(0, fanoutN);
            const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
            const fanoutChecks = await Promise.all(fanoutSet.map(async (c) => {
              try {
                const route = await getRouteQuoteWithFallback({
                  cfg,
                  mint: c.mint,
                  amountLamports: lam,
                  slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                  solUsdNow,
                  source: 'fanout',
                });
                return { mint: c.mint, routeable: !!route.routeAvailable };
              } catch {
                return { mint: c.mint, routeable: false };
              }
            }));
            counters.route.quoteFanoutChecked += fanoutChecks.length;
            const routeableMints = new Set(fanoutChecks.filter(x => x.routeable).map(x => x.mint));
            counters.route.quoteFanoutRouteable += routeableMints.size;
            preCandidates.sort((a, b) => {
              const ar = routeableMints.has(a.mint) ? 1 : 0;
              const br = routeableMints.has(b.mint) ? 1 : 0;
              return (br - ar) || (b.score - a.score);
            });
          }

          // Enqueue forward tracking for the best "safe" candidates (passed base filters already by definition here)
          try {
            const trackable = preCandidates
              .filter(x => Number(x?.pair?.liquidity?.usd || x?.pair?.liquidityUsd || x?.pair?.liquidityUsd) || true) // keep shape flexible
              .slice(0, 25)
              .map(x => ({ mint: x.mint, pair: x.pair, tok: x.tok }));
            if (cfg.SCANNER_TRACKING_ENABLED) {
              trackerMaybeEnqueue({ cfg, state, candidates: trackable, nowIso });
            }
          } catch {}

          // quick visibility: log source mix (noisy)
          const visibilityPings2 = (state?.flags?.tgVisibilityPings ?? cfg.TG_VISIBILITY_PINGS);
          if (visibilityPings2) {
            try {
              const total = preCandidates.length;
              const fromJup = preCandidates.filter(x => x?.tok?._source === 'jup').length;
              if (total > 0 && (!globalThis.__lastSourcePingAt || (t - globalThis.__lastSourcePingAt) > 30 * 60_000)) {
                globalThis.__lastSourcePingAt = t;
                await tgSend(cfg, `🧭 Candidate sources: total=${total} (jup=${fromJup}, dexBoosted=${total - fromJup})`);
              }
            } catch {}
          }

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
          const rawTopCandidates = preCandidates.slice(0, cfg.LIVE_CANDIDATE_SHORTLIST_N);
          const probeEnabled = !!(cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_PROBE_CONFIRM_ENABLED);
          scanPhase.shortlistMs += Math.max(0, Date.now() - _tShortlist);
          const probeShortlist = probeEnabled
            ? rawTopCandidates
              .filter(({ pair }) => {
                const liq = Number(pair?.liquidity?.usd || 0);
                const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
                return liq >= cfg.LIVE_PROBE_MIN_LIQ_USD && tx1h >= cfg.LIVE_PROBE_MIN_TX1H;
              })
              .slice(0, cfg.LIVE_PROBE_MAX_CANDIDATES)
            : rawTopCandidates;

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

    // Persist state immediately if requested by control commands
    if (state.flags?.saveStateNow) {
      state.flags.saveStateNow = false;
      saveState(cfg.STATE_PATH, state);
    }

    // force-close hook handled near top of loop to avoid starvation by scan-lane continues.

    // Respond to /positions and /status flags
    if (state.flags?.sendPositions) {
      state.flags.sendPositions = false;
      await sendPositionsReport();
    }

    if (state.flags?.sendOpencheck) {
      state.flags.sendOpencheck = false;
      try {
        const openRows = Object.entries(state.positions || {}).filter(([, p]) => p?.status === 'open');
        const stateOpen = openRows.length;
        const onchain = await getTokenHoldingsByMint(conn, pub);
        const onchainOpen = Array.from(onchain.values()).filter((amt) => Number(amt || 0) > 0).length;
        const exitPending = openRows.filter(([, p]) => !!p?.exitPending).length;
        const hotQueuePending = Array.isArray(state?.watchlist?.hotQueue) ? state.watchlist.hotQueue.length : 0;
        const mintBacklog = state?.watchlist?.mints && typeof state.watchlist.mints === 'object'
          ? Object.keys(state.watchlist.mints).length
          : 0;

        await tgSend(cfg, [
          '🔎 *Open Check*',
          `🕒 ${nowIso()}`,
          `• state open positions: ${stateOpen}`,
          `• on-chain token holdings (>0): ${onchainOpen}`,
          `• delta (state - onchain): ${stateOpen - onchainOpen}`,
          `• exitPending: ${exitPending}`,
          `• watchlist hot queue: ${hotQueuePending}`,
          `• watchlist tracked mints: ${mintBacklog}`,
        ].join('\n'));
      } catch (e) {
        await tgSend(cfg, `Opencheck error: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.sendStatus) {
      state.flags.sendStatus = false;
      try {
        const { solUsd } = await getSolUsdPrice();
        const { equityUsd, solLamports } = await estimateEquityUsd(cfg, conn, pub, state, solUsd);
        const openCount = positionCount(state);
        const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
        const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
        const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
        await tgSend(cfg, [
          '🧾 *Status*',
          `🕒 ${nowIso()}`,
          '',
          `👛 Wallet: ${pub}`,
          `• SOL: ${(solLamports/1e9).toFixed(4)}  |  SOLUSD: $${solUsd.toFixed(2)}`,
          `• Equity≈: ${fmtUsd(equityUsd)}`,
          `• Open positions: ${openCount}`,
          `• Execution config: ${cfg.EXECUTION_ENABLED ? '✅ enabled' : '🛑 disabled'}`,
          `• Runtime gate: ${state.tradingEnabled ? '✅ open' : '🛑 halted'}`,
          '',
          `⚙️ Filters: liq>=max(${effLiqFloor}, ${(state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO)}*mcap), mcap>=${effMinMcap}, age>=${effMinAge}h`,
        ].join('\n'));
      } catch (e) {
        await tgSend(cfg, `Status error: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.sendModels) {
      state.flags.sendModels = false;
      const models = getModels(cfg, state);
      await tgSend(cfg, [
        `🤖 Models @ ${nowIso()}`,
        `• preprocess: ${models.preprocess}`,
        `• analyze: ${models.analyze}`,
        `• gatekeeper: ${models.gatekeeper}`,
        `Update: /setmodel preprocess gpt-5-mini | /setmodel analyze gpt-5.2 | /setmodel gatekeeper gpt-5.2`,
      ].join('\n'));
    }

    if (state.flags?.sendHealth) {
      state.flags.sendHealth = false;
      const nowMs = Date.now();
      const loopFreshSec = lastScan ? Math.round((nowMs - lastScan) / 1000) : null;
      const solFreshSec = lastSolUsdAt ? Math.round((nowMs - lastSolUsdAt) / 1000) : null;
      const dexCdSec = Math.max(0, Math.round((dexCooldownUntil - nowMs) / 1000));
      const jupCdSec = Math.max(0, Math.round(jupCooldownRemainingMs(state, nowMs) / 1000));
      const circuitState = state?.circuit?.open ? 'open' : 'closed';
      const trackerSummary = formatTrackerIngestionSummary({ cfg, state });
      await tgSend(
        cfg,
        `❤️ Health: loop=${loopFreshSec == null ? 'n/a' : `${loopFreshSec}s`} circuit=${circuitState} dexCd=${dexCdSec}s jupCd=${jupCdSec}s solData=${solFreshSec == null ? 'n/a' : `${solFreshSec}s`}\n${trackerSummary}`
      );
    }

    if (state.flags?.sendDiag) {
      const rawMode = String(state.flags?.sendDiagMode || 'compact').toLowerCase();
      const mode = (rawMode === 'full' || rawMode === 'momentum' || rawMode === 'confirm' || rawMode === 'execution' || rawMode === 'scanner') ? rawMode : 'compact';
      const windowHours = Number(state.flags?.sendDiagWindowHours);
      const useHours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : null;
      state.flags.sendDiag = false;
      delete state.flags.sendDiagMode;
      delete state.flags.sendDiagWindowHours;
      await tgSendChunked(cfg, getDiagSnapshotMessage(Date.now(), mode, useHours));
    }

    if (state.flags?.sendMode) {
      state.flags.sendMode = false;
      const nowMs = Date.now();
      const paperOn = isPaperModeActive({ state, cfg, nowMs });
      const mode = !state.tradingEnabled ? 'halted' : paperOn ? 'paper' : cfg.EXECUTION_ENABLED ? 'live' : 'monitoring';
      const gates = [
        `executionCfg=${cfg.EXECUTION_ENABLED ? 'on' : 'off'}`,
        `runtimeGate=${state.tradingEnabled ? 'open' : 'halted'}`,
        `paper=${paperOn ? 'on' : 'off'}`,
        `force=${cfg.FORCE_TRADING_ENABLED ? 'on' : 'off'}`,
        `playbook=${state?.playbook?.mode || 'normal'}`,
        `circuit=${state?.circuit?.open ? 'open' : 'closed'}`,
      ];
      await tgSend(cfg, `🎚️ Mode: *${mode}* (${gates.join(', ')})`);
    }

    if (state.flags?.sendConfig) {
      state.flags.sendConfig = false;
      const models = getModels(cfg, state);
      const cfgSnap = {
        executionEnabled: cfg.EXECUTION_ENABLED,
        forceTradingEnabled: cfg.FORCE_TRADING_ENABLED,
        scannerEntriesEnabled: cfg.SCANNER_ENTRIES_ENABLED,
        usdPerTrade: cfg.USD_PER_TRADE,
        slippageBps: cfg.SLIPPAGE_BPS,
        maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
        scanEveryMs: cfg.SCAN_EVERY_MS,
        positionsEveryMs: cfg.POSITIONS_EVERY_MS,
        watchlistTriggerMode: cfg.WATCHLIST_TRIGGER_MODE,
        watchlistMaxSize: cfg.WATCHLIST_MAX_SIZE,
        watchlistEvalEveryMs: cfg.WATCHLIST_EVAL_EVERY_MS,
        watchlistMintTtlMs: cfg.WATCHLIST_MINT_TTL_MS,
        watchlistEvictMaxAgeHours: cfg.WATCHLIST_EVICT_MAX_AGE_HOURS,
        watchlistEvictStaleCycles: cfg.WATCHLIST_EVICT_STALE_CYCLES,
        minLiqUsd: state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD,
        minMcapUsd: state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD,
        minAgeHours: state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS,
        liqToMcapRatio: state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO,
        models,
      };
      await tgSend(cfg, `⚙️ Config (safe):\n\n${JSON.stringify(cfgSnap, null, 2)}`);
    }

    if (state.flags?.sendWhy) {
      const target = String(state.flags.sendWhy || '').toLowerCase();
      delete state.flags.sendWhy;
      const rows = Array.isArray(state?.debug?.last) ? state.debug.last : [];
      const hit = [...rows].reverse().find((it) => {
        const sym = String(it?.symbol || '').toLowerCase();
        const mint = String(it?.mint || '').toLowerCase();
        return sym === target || mint === target;
      });
      if (!hit) {
        await tgSend(cfg, `No recent debug entry for ${target}. Try /last 50 or enable /debug on 5.`);
      } else {
        await tgSend(cfg, `🤔 Why ${hit.symbol || target} (${String(hit.mint || '').slice(0, 6)}…): ${hit.reason || 'unknown'} @ ${hit.t || 'n/a'}`);
      }
    }

    if (state.flags?.sendSpend) {
      const arg = String(state.flags.sendSpend || '24h');
      delete state.flags.sendSpend;

      const nowMs = Date.now();
      const cached = spendSummaryCache.summaries.get(arg);
      const cacheAgeSec = spendSummaryCache.loadedAtMs ? Math.max(0, Math.round((nowMs - spendSummaryCache.loadedAtMs) / 1000)) : null;
      if (cached) {
        const lines = [
          `💸 Spend (${arg}): $${cached.cost.toFixed(4)} across ${cached.events} calls`,
          `snapshotAt=${new Date(spendSummaryCache.loadedAtMs).toISOString()} staleness=${cacheAgeSec}s`,
          '',
          'By model:',
          ...Object.entries(cached.byModel).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `- ${k}: $${v.toFixed(4)}`),
          '',
          'By operation:',
          ...Object.entries(cached.byOp).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `- ${k}: $${v.toFixed(4)}`),
        ];
        await tgSend(cfg, lines.join('\n'));
      } else {
        await tgSend(cfg, '⏳ Spend snapshot warming; using cached observability path (no hot-loop ledger scan). Retry in ~10s.');
      }

      if (!spendSummaryCache.inFlight && (cacheAgeSec == null || cacheAgeSec * 1000 >= SPEND_CACHE_TTL_MS)) {
        refreshSpendSummaryCacheAsync();
      }
    }

    if (state.flags?.runReplay) {
      const req = state.flags.runReplay;
      delete state.flags.runReplay;
      try { await saveState(cfg.STATE_PATH, state); } catch {}
      try {
        const args = ['scripts/replay_historical.mjs', '--json', '--days', String(req.days)];
        if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));
        if (req.trailActivatePct != null) args.push('--trail-activate-pct', String(req.trailActivatePct));
        if (req.trailDistancePct != null) args.push('--trail-distance-pct', String(req.trailDistancePct));
        if (req.stopEntryBufferPct != null) args.push('--stop-entry-buffer-pct', String(req.stopEntryBufferPct));

        const out = await runNodeScriptJson(args[0], args.slice(1), 90_000);
        await tgSend(
          cfg,
          [
            '🧪 *Historical Replay*',
            `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0}`,
            `rules: activate=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)}% distance=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)}% stopBuf=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}%`,
            `trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}%`,
            `exits=${JSON.stringify(out?.metrics?.exits || {})}`,
          ].join('\n')
        );
        appendLearningNote(`Replay run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}% rules[a=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}].`);
      } catch (e) {
        await tgSend(cfg, `❌ Replay failed: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.runOptimize) {
      const req = state.flags.runOptimize;
      delete state.flags.runOptimize;
      try { await saveState(cfg.STATE_PATH, state); } catch {}
      try {
        const args = [
          'scripts/optimize_replay.mjs',
          '--json',
          '--days',
          String(req.days),
          '--top',
          String(req.top),
          '--trail-activate-range',
          String(req.trailActivateRange),
          '--trail-distance-range',
          String(req.trailDistanceRange),
          '--stop-entry-buffer-range',
          String(req.stopEntryBufferRange),
        ];
        if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));

        const out = await runNodeScriptJson(args[0], args.slice(1), 120_000);
        const ranked = Array.isArray(out?.ranked) ? out.ranked : [];
        const lines = ranked.slice(0, Math.min(5, ranked.length)).map((row, i) => {
          const r = row.rules || {};
          const m = row.metrics || {};
          return `#${i + 1} a=${(Number(r.trailActivatePct || 0) * 100).toFixed(2)}% d=${(Number(r.trailDistancePct || 0) * 100).toFixed(2)}% sb=${(Number(r.stopEntryBufferPct || 0) * 100).toFixed(4)}% | pnl=${(Number(m.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(m.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(m.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(m.trades || 0)}`;
        });

        await tgSend(
          cfg,
          [
            '⚙️ *Replay Optimizer*',
            `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0} top=${out?.config?.top}`,
            `preset=${req.preset} grid: activate=${req.trailActivateRange} distance=${req.trailDistanceRange} stopbuf=${req.stopEntryBufferRange}`,
            '',
            ...(lines.length ? lines : ['No optimization rows returned.']),
          ].join('\n')
        );
        const best = ranked[0] || {};
        const br = best.rules || {};
        const bm = best.metrics || {};
        appendLearningNote(`Optimize run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} top=${out?.config?.top} grid[a=${req.trailActivateRange} d=${req.trailDistanceRange} sb=${req.stopEntryBufferRange}] best[a=${(Number(br.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(br.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(br.stopEntryBufferPct || 0) * 100).toFixed(4)}] pnl=${(Number(bm.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(bm.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(bm.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(bm.trades || 0)}.`);
      } catch (e) {
        await tgSend(cfg, `❌ Optimizer failed: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.sendFilters) {
      state.flags.sendFilters = false;
      const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
      const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
      const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
      const over = state.filterOverrides ? `overrides active` : `defaults`;
      await tgSend(cfg, [
        `⚙️ *Filters* (${over})`,
        `🕒 ${nowIso()}`,
        '',
        `• Liquidity: >= max(${effLiqFloor}, ${(state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO)} * mcap)`,
        `• Mcap: >= ${effMinMcap}`,
        `• Age: >= ${effMinAge}h`,
        '',
        '✏️ Examples:',
        '• /setfilter liq 60000',
        '• /setfilter liqratio 0.28',
        '• /setfilter mcap 300000',
        '• /setfilter age 24',
        '• /resetfilters',
      ].join('\n'));
    }

    if (state.flags?.sendHardrejects) {
      state.flags.sendHardrejects = false;
      const effMinMcap = Number(state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD);
      const effLiqFloor = Number(state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD);
      await tgSend(cfg, [
        '🧱 *Core Hard Rejects*',
        `🕒 ${nowIso()}`,
        '',
        `• mcap < ${effMinMcap}`,
        `• liquidity < 120000 (base floor now ${effLiqFloor})`,
        '• volume_5m < 20000',
        '• tx1h < 80',
        '• spread > 3% (when available)',
        '• pool age < 180s',
        '• mcap/liquidity > 4.5',
        '• liquidity drop > 10% in last 60s',
        '• ret1 > 12%',
        '• ret1 < 2%',
        '• ret5 < 5%',
        '• buy dominance < 68%',
        '• tx slope not positive',
        '• 1m volatility extreme',
        '• topHolder > 3.5%',
        '• top10 > 38%',
        '• bundleCluster > 15%',
        '• creatorCluster > 2% (if available)',
        '• LP unlocked or LP lock < 90% (if available)',
        `• holders gate: age<=${cfg.HOLDER_TIER_NEW_MAX_AGE_SEC}s => >=${cfg.HOLDER_TIER_MIN_NEW}, else >=${cfg.HOLDER_TIER_MIN_MATURE}`,
        '• low SOL fee reserve → pause new entries',
        '• unsafe/stale entry snapshot or confirm-stage route/liquidity failure',
        '',
        '⚠️ Sizing modifier: top10 in [30%,38%] => size reduced 50% (not full reject).',
      ].join('\n'));
    }

    if (state.flags?.sendLast) {
      const n = state.flags.sendLast;
      delete state.flags.sendLast;
      const items = getLastDebug(state, n);
      if (!items.length) {
        await tgSend(cfg, 'Last candidates: none recorded yet');
      } else {
        const lines = items.map((it) => {
          const sym = it.symbol ? String(it.symbol) : '???';
          const mint = it.mint ? String(it.mint) : '';
          const r = it.reason || '';
          const extra = [];
          if (it.liqUsd != null) extra.push(`💧${Math.round(it.liqUsd)}`);
          if (it.mcapUsd != null) extra.push(`🧢${Math.round(it.mcapUsd)}`);
          if (it.rugScore != null) extra.push(`🛡️${it.rugScore}`);
          if (it.tx1h != null) extra.push(`🔁${it.tx1h}`);
          if (it.pc1h != null) extra.push(`📈${it.pc1h}`);
          return `• ${sym} (${mint.slice(0, 6)}…) — ${r}${extra.length ? `  [${extra.join(' ')}]` : ''}`;
        });
        const chunkSize = 25;
        for (let i = 0; i < lines.length; i += chunkSize) {
          await tgSend(cfg, `🧪 *Last candidates* (newest last)\n\n` + lines.slice(i, i + chunkSize).join('\n'));
        }
      }
    }

    // Check positions for exits
    if (t - lastPos >= cfg.POSITIONS_EVERY_MS) {
      lastPos = t;

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
