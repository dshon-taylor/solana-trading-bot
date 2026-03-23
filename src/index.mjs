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
import { promoteRouteAvailableCandidateToImmediate } from './route_available_watchlist.mjs';
import { resolveEntryAndStopForOpenPosition } from './entry_guard.mjs';
import { confirmContinuationGate as runConfirmContinuationGate } from './lib/confirm_continuation.mjs';
import { isMicroFreshEnough, applyMomentumPassHysteresis, getCachedMintCreatedAt, scheduleMintCreatedAtLookup } from './lib/momentum_gate_controls.mjs';
import { resolveConfirmTxMetricsFromDiagEvent } from './diag_event_invariants.mjs';
import { CORE_MOMO_CHECKS, canaryMomoShouldSample, recordCanaryMomoFailChecks, coreMomentumProgress, decideMomentumBranch, normalizeEpochMs, pickEpochMsWithSource, applySnapshotToLatest, buildNormalizedMomentumInput, pruneMomentumRepeatFailMap } from './watchlist_eval_helpers.mjs';
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

const AGGRESSIVE_BOOT_MODE = (process.env.AGGRESSIVE_MODE ?? 'false') === 'true';
const NO_PAIR_RETRY_ATTEMPTS = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS || 5));
const NO_PAIR_RETRY_BASE_MS = Math.max(50, Number(process.env.NO_PAIR_RETRY_BASE_MS || (AGGRESSIVE_BOOT_MODE ? 90 : 300)));
const NO_PAIR_RETRY_MAX_BACKOFF_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_MAX_BACKOFF_MS || (AGGRESSIVE_BOOT_MODE ? 900 : 4_000)));
const NO_PAIR_RETRY_TOTAL_BUDGET_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_TOTAL_BUDGET_MS || (AGGRESSIVE_BOOT_MODE ? 1_500 : 6_000)));
const NO_PAIR_RETRY_ATTEMPTS_CAP = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS_CAP || 10));
const NO_PAIR_TEMP_TTL_MS = Math.max(5_000, Number(process.env.NO_PAIR_TEMP_TTL_MS || (AGGRESSIVE_BOOT_MODE ? 40_000 : 120_000)));
const NO_PAIR_TEMP_TTL_ROUTEABLE_MS = Math.max(10_000, Number(process.env.NO_PAIR_TEMP_TTL_ROUTEABLE_MS || (AGGRESSIVE_BOOT_MODE ? 18_000 : 45_000)));
const NO_PAIR_NON_TRADABLE_TTL_MS = Math.max(NO_PAIR_TEMP_TTL_MS, Number(process.env.NO_PAIR_NON_TRADABLE_TTL_MS || 20 * 60_000));
const NO_PAIR_DEAD_MINT_TTL_MS = Math.max(NO_PAIR_NON_TRADABLE_TTL_MS, Number(process.env.NO_PAIR_DEAD_MINT_TTL_MS || 90 * 60_000));
const NO_PAIR_REVISIT_MIN_MS = Math.max(150, Number(process.env.NO_PAIR_REVISIT_MIN_MS || (AGGRESSIVE_BOOT_MODE ? 450 : 1_500)));
const NO_PAIR_REVISIT_MAX_MS = Math.max(NO_PAIR_REVISIT_MIN_MS, Number(process.env.NO_PAIR_REVISIT_MAX_MS || (AGGRESSIVE_BOOT_MODE ? 120_000 : 6 * 60_000)));
const NO_PAIR_DEAD_MINT_STRIKES = Math.max(2, Number(process.env.NO_PAIR_DEAD_MINT_STRIKES || 3));
const JUP_ROUTE_FIRST_ENABLED = (process.env.JUP_ROUTE_FIRST_ENABLED ?? 'true') === 'true';
const JUP_SOURCE_PREFLIGHT_ENABLED = (process.env.JUP_SOURCE_PREFLIGHT_ENABLED ?? 'true') === 'true';

function effectiveNoPairRetryAttempts() {
  return Math.max(1, Math.min(NO_PAIR_RETRY_ATTEMPTS, NO_PAIR_RETRY_ATTEMPTS_CAP));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const arr = Array.isArray(items) ? items : [];
  const maxWorkers = Math.max(1, Math.min(arr.length || 1, Number(concurrency || 1)));
  let idx = 0;
  const workers = Array.from({ length: maxWorkers }, async () => {
    while (idx < arr.length) {
      const current = idx;
      idx += 1;
      await worker(arr[current], current);
    }
  });
  await Promise.all(workers);
}

function jitter(ms, pct = 0.25) {
  const delta = ms * pct;
  return Math.max(0, Math.round(ms + ((Math.random() * 2 - 1) * delta)));
}

async function quickRouteRecheck({ cfg, mint, solUsdNow, slippageBps, attempts, delayMs, passes = 1, passDelayMs = 80 }) {
  const maxAttempts = Math.max(1, Math.min(8, Number(attempts || 1)));
  const waitMs = Math.max(20, Number(delayMs || 120));
  const maxPasses = Math.max(1, Math.min(4, Number(passes || 1)));
  const interPassWaitMs = Math.max(10, Number(passDelayMs || 80));
  let totalAttempts = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, interPassWaitMs));
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, waitMs));
      totalAttempts += 1;
      try {
        const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
        const q = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps });
        const pi = Number(q?.priceImpactPct || 0);
        const routeable = !!q?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
        if (routeable) return { recovered: true, attempts: totalAttempts, pass: pass + 1 };
      } catch (e) {
        const kind = parseJupQuoteFailure(e);
        if (kind === 'rateLimited') return { recovered: false, attempts: totalAttempts, pass: pass + 1, rateLimited: true };
      }
    }
  }
  return { recovered: false, attempts: totalAttempts, pass: maxPasses };
}

function ensureNoPairTemporaryState(state) {
  state.marketData ||= {};
  state.marketData.noPairTemporary ||= {};
  return state.marketData.noPairTemporary;
}

function ensureNoPairDeadMintState(state) {
  state.marketData ||= {};
  state.marketData.noPairDeadMints ||= {};
  return state.marketData.noPairDeadMints;
}

function normalizeCandidateSource(source) {
  const s = String(source || '').trim().toLowerCase();
  return s || 'unknown';
}

function bumpNoPairReason(counters, reason = 'providerEmpty', source = 'unknown') {
  bump(counters, 'reject.noPair');
  counters.reject.noPairReasons ||= {};
  counters.reject.noPairReasons[reason] = Number(counters.reject.noPairReasons[reason] || 0) + 1;
  if (reason === 'rateLimited') {
    counters.guardrails ||= {};
    counters.guardrails.rateLimited = Number(counters.guardrails.rateLimited || 0) + 1;
  }
  const s = normalizeCandidateSource(source);
  bumpSourceCounter(counters, s, 'rejects');
  bumpSourceCounter(counters, s, 'noPairRejects');
}

function bumpRouteCounter(counters, key) {
  counters.route ||= {};
  counters.route[key] = Number(counters.route[key] || 0) + 1;
}

function recordNonTradableMint(counters, mint, kind = 'rejected') {
  counters.execution ||= {};
  if (kind === 'cooldownActive') {
    counters.execution.nonTradableMintCooldownActive = Number(counters.execution.nonTradableMintCooldownActive || 0) + 1;
  } else {
    counters.execution.nonTradableMintRejected = Number(counters.execution.nonTradableMintRejected || 0) + 1;
  }
  counters.execution.nonTradableMintsTop ||= {};
  const m = String(mint || 'unknown');
  counters.execution.nonTradableMintsTop[m] = Number(counters.execution.nonTradableMintsTop[m] || 0) + 1;
}

function getBoostUsd(tok) {
  if (!tok) return 0;
  const candidates = [
    tok.amountUsd,
    tok.totalAmountUsd,
    tok.usdAmount,
    tok.amount,
    tok.totalAmount,
    tok.total,
    tok.boostUsd,
    tok.boostAmountUsd,
  ];
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function shouldApplyEarlyShortlistPrefilter({ cfg, tok }) {
  if (!cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE) return false;
  // Only apply cheap/low-risk prefilters here.
  // For JUP tokenlist picks and other sources without boost metadata, we generally pass.
  const source = normalizeCandidateSource(tok?._source || 'unknown');
  if (source === 'dex') return true;
  return false;
}

function computeNoPairRevisitMs(reason, attempts = 1) {
  const factor = Math.max(0, Number(attempts || 1) - 1);
  const base = Math.min(NO_PAIR_RETRY_MAX_BACKOFF_MS, NO_PAIR_RETRY_BASE_MS * (2 ** factor));
  const weighted = (reason === 'routeAvailable') ? Math.round(base * 0.7) : base;
  return Math.max(NO_PAIR_REVISIT_MIN_MS, Math.min(NO_PAIR_REVISIT_MAX_MS, jitter(weighted, 0.35)));
}

function computeNoPairTtlMs(reason, attempts = 1) {
  if (reason === 'nonTradableMint') return NO_PAIR_NON_TRADABLE_TTL_MS;
  if (reason === 'deadMint') return NO_PAIR_DEAD_MINT_TTL_MS;
  if (reason === 'routeAvailable') return NO_PAIR_TEMP_TTL_ROUTEABLE_MS;
  const tier = Math.min(4, Math.max(0, Number(attempts || 1) - 1));
  return NO_PAIR_TEMP_TTL_MS + (tier * 20_000);
}

function setNoPairTemporary(noPairTemporary, mint, { reason, nowMs, attempts = 1 }) {
  const ttlMs = computeNoPairTtlMs(reason, attempts);
  const revisitMs = computeNoPairRevisitMs(reason, attempts);
  noPairTemporary[mint] = {
    untilMs: nowMs + ttlMs,
    nextRetryAtMs: nowMs + revisitMs,
    reason,
    atMs: nowMs,
    attempts,
  };
}

function shouldSkipNoPairTemporary(temp, nowMs) {
  if (!temp) return false;
  const untilMs = Number(temp.untilMs || 0);
  if (untilMs <= nowMs) return false;
  const nextRetryAtMs = Number(temp.nextRetryAtMs || temp.untilMs || 0);
  return nextRetryAtMs > nowMs;
}

function ensureForceAttemptPolicyState(state) {
  state.guardrails ||= {};
  state.guardrails.forceAttempt ||= {
    globalAttemptTimestampsMs: [],
    perMintAttemptTimestampsMs: {},
  };
  state.guardrails.forceAttempt.globalAttemptTimestampsMs ||= [];
  state.guardrails.forceAttempt.perMintAttemptTimestampsMs ||= {};
  return state.guardrails.forceAttempt;
}

function pruneForceAttemptPolicyWindows(policyState, nowMs) {
  const minCutoff = nowMs - 60_000;
  const hourCutoff = nowMs - 60 * 60_000;
  policyState.globalAttemptTimestampsMs = (policyState.globalAttemptTimestampsMs || [])
    .filter(ts => Number(ts || 0) > minCutoff)
    .slice(-500);
  for (const mint of Object.keys(policyState.perMintAttemptTimestampsMs || {})) {
    const next = (policyState.perMintAttemptTimestampsMs[mint] || []).filter(ts => Number(ts || 0) > hourCutoff);
    if (next.length) policyState.perMintAttemptTimestampsMs[mint] = next.slice(-500);
    else delete policyState.perMintAttemptTimestampsMs[mint];
  }
}

function evaluateForceAttemptPolicyGuards({ cfg, policyState, row, mint, nowMs }) {
  if (Number(row?.cooldownUntilMs || 0) > nowMs) return { ok: false, reason: 'forcePolicyMintCooldown' };
  const mintAttempts = policyState.perMintAttemptTimestampsMs?.[mint] || [];
  if (mintAttempts.length >= Number(cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR || 0)) {
    return { ok: false, reason: 'forcePolicyMintHourlyCap' };
  }
  const globalAttempts = policyState.globalAttemptTimestampsMs || [];
  if (globalAttempts.length >= Number(cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE || 0)) {
    return { ok: false, reason: 'forcePolicyGlobalRateCap' };
  }
  return { ok: true };
}

function recordForceAttemptPolicyAttempt({ policyState, mint, nowMs }) {
  policyState.globalAttemptTimestampsMs ||= [];
  policyState.perMintAttemptTimestampsMs ||= {};
  policyState.globalAttemptTimestampsMs.push(nowMs);
  policyState.perMintAttemptTimestampsMs[mint] ||= [];
  policyState.perMintAttemptTimestampsMs[mint].push(nowMs);
}

function parseJupQuoteFailure(err) {
  const msg = String(err?.message || '').toUpperCase();
  if (err?.status === 429 || msg.includes('JUPITER_429') || msg.includes(' 429')) return 'rateLimited';
  if (
    msg.includes('TOKEN_NOT_TRADABLE')
    || msg.includes('TOKEN NOT TRADABLE')
    || msg.includes('COULD_NOT_FIND_ANY_ROUTE')
    || msg.includes('NO_ROUTES_FOUND')
    || msg.includes('ROUTE NOT FOUND')
    || msg.includes('MINT_NOT_FOUND')
    || msg.includes('INVALID_MINT')
    || msg.includes('TOKEN HAS NO MARKET')
  ) return 'nonTradableMint';
  if (err?.status === 400 || err?.status === 404) return 'routeNotFound';
  return 'providerEmpty';
}

function classifyNoPairReason({ state, mint, nowMs, maxAgeMs, routeAvailable, routeErrorKind, hitRateLimit }) {
  if (hitRateLimit || routeErrorKind === 'rateLimited') return 'rateLimited';
  const dead = state?.marketData?.noPairDeadMints?.[mint] || null;
  if (dead && Number(dead.untilMs || 0) > nowMs) return 'deadMint';
  if (routeErrorKind === 'nonTradableMint') return 'nonTradableMint';
  if (routeAvailable === true) return 'routeableNoMarketData';
  if (routeAvailable === false || routeErrorKind === 'routeNotFound') return 'routeNotFound';
  const birdCd = Number(state?.marketData?.providers?.birdeye?.cooldownUntilMs || 0);
  const dexCd = Number(state?.marketData?.providers?.dexscreener?.cooldownUntilMs || 0);
  const jupCd = Number(state?.marketData?.providers?.jupiter?.cooldownUntilMs || 0);
  if (birdCd > nowMs && dexCd > nowMs && jupCd > nowMs) return 'providerCooldown';
  const lkg = state?.marketData?.lastKnownGood?.[mint] || null;
  const ageMs = lkg?.atMs ? Math.max(0, nowMs - Number(lkg.atMs)) : null;
  if (Number.isFinite(ageMs) && ageMs > Number(maxAgeMs || 0)) return 'staleData';
  if (routeErrorKind === 'providerEmpty') return 'providerEmpty';
  return 'retriesExhausted';
}

function minHoldersRequired({ cfg, poolAgeSec }) {
  const age = Number(poolAgeSec);
  if (Number.isFinite(age) && age <= Number(cfg.HOLDER_TIER_NEW_MAX_AGE_SEC || 1800)) {
    return Number(cfg.HOLDER_TIER_MIN_NEW || 400);
  }
  return Number(cfg.HOLDER_TIER_MIN_MATURE || 900);
}

function holdersGateCheck({ cfg, holders, poolAgeSec }) {
  const h = Number(holders);
  const req = minHoldersRequired({ cfg, poolAgeSec });
  if (!Number.isFinite(h) || h <= 0) {
    if (cfg.HOLDER_MISSING_SOFT_ALLOW) return { ok: true, soft: true, reason: 'holdersMissing_soft', required: req };
    return { ok: false, reason: 'holdersMissing', required: req };
  }
  if (h < req) return { ok: false, reason: `holdersTooLow(${Math.round(h)}<${Math.round(req)})`, required: req };
  return { ok: true, required: req };
}

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

function ensureWatchlistState(state) {
  state.watchlist ||= {
    mints: {},
    hotQueue: [],
    routeCache: {},
    stats: { ingested: 0, refreshed: 0, evicted: 0, ageEvicted: 0, staleEvicted: 0, ttlEvicted: 0, lastEvalAtMs: 0 },
  };
  state.watchlist.mints ||= {};
  state.watchlist.hotQueue ||= [];
  state.watchlist.routeCache ||= {};
  state.watchlist.stats ||= { ingested: 0, refreshed: 0, evicted: 0, ageEvicted: 0, staleEvicted: 0, ttlEvicted: 0, lastEvalAtMs: 0 };
  return state.watchlist;
}

function pruneRouteCache({ state, cfg, nowMs = Date.now() }) {
  const wl = ensureWatchlistState(state);
  const cache = wl.routeCache || {};
  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  for (const [mint, entry] of Object.entries(cache)) {
    const atMs = Number(entry?.atMs || 0);
    if (!atMs || (nowMs - atMs) > ttlMs) {
      delete cache[mint];
    }
  }
  const maxSize = Math.max(8, Number(cfg.ROUTE_CACHE_MAX_SIZE || 0));
  const entries = Object.entries(cache);
  if (entries.length > maxSize) {
    entries
      .sort((a, b) => Number(a?.[1]?.atMs || 0) - Number(b?.[1]?.atMs || 0))
      .slice(0, entries.length - maxSize)
      .forEach(([mint]) => {
        delete cache[mint];
      });
  }
}

function getFreshRouteCacheEntry({ state, cfg, mint, nowMs = Date.now() }) {
  if (!cfg.ROUTE_CACHE_ENABLED) return null;
  const wl = ensureWatchlistState(state);
  const entry = wl.routeCache?.[mint] || null;
  if (!entry) return null;
  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  const ageMs = Math.max(0, nowMs - Number(entry?.atMs || 0));
  if (ageMs > ttlMs) return null;
  const pi = Number(entry?.priceImpactPct || 0);
  if (pi > 0 && pi > Number(cfg.MAX_PRICE_IMPACT_PCT || 0)) return null;
  return entry;
}

function cacheRouteReadyMint({ state, cfg, mint, quote, nowMs = Date.now(), source = null }) {
  if (!cfg.ROUTE_CACHE_ENABLED) return;
  const wl = ensureWatchlistState(state);
  if (!mint || !quote?.routePlan?.length) return;
  wl.routeCache[mint] = {
    mint,
    atMs: nowMs,
    source,
    slippageBps: Number(cfg.DEFAULT_SLIPPAGE_BPS || 0),
    amountUsd: Number(cfg.JUP_PREFILTER_AMOUNT_USD || 0),
    priceImpactPct: Number(quote?.priceImpactPct || 0),
    outAmount: quote?.outAmount ?? null,
    routeLabel: quote?.routePlan?.[0]?.swapInfo?.label || null,
    hops: Number(quote?.routePlan?.length || 0),
  };
  pruneRouteCache({ state, cfg, nowMs });
}

async function resolveWatchlistRouteMeta({ cfg, state, mint, row, solUsdNow, nowMs, counters }) {
  const wl = ensureWatchlistState(state);
  const cached = wl.routeCache?.[mint] || null;
  if (!cfg.ROUTE_CACHE_ENABLED || !cached) {
    counters.watchlist.routeCacheMiss += 1;
    return { fromCache: false, cacheUsed: false, staleInvalidated: false, quote: null };
  }

  const ttlMs = Math.max(500, Number(cfg.ROUTE_CACHE_TTL_MS || 0));
  const ageMs = Math.max(0, nowMs - Number(cached?.atMs || 0));
  if (ageMs > ttlMs) {
    counters.watchlist.routeCacheMiss += 1;
    counters.watchlist.routeCacheStaleInvalidated += 1;
    delete wl.routeCache[mint];
    return { fromCache: false, cacheUsed: false, staleInvalidated: true, quote: null };
  }

  try {
    const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
    const q = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
    const pi = Number(q?.priceImpactPct || 0);
    const routeable = !!q?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
    if (!routeable) {
      counters.watchlist.routeCacheMiss += 1;
      counters.watchlist.routeCacheStaleInvalidated += 1;
      delete wl.routeCache[mint];
      return { fromCache: false, cacheUsed: false, staleInvalidated: true, quote: null };
    }
    counters.watchlist.routeCacheHit += 1;
    row.routeHint = true;
    cacheRouteReadyMint({ state, cfg, mint, quote: q, nowMs, source: 'watchlist-recheck' });
    return { fromCache: true, cacheUsed: true, staleInvalidated: false, quote: q };
  } catch {
    counters.watchlist.routeCacheMiss += 1;
    return { fromCache: false, cacheUsed: false, staleInvalidated: false, quote: null };
  }
}

function watchlistHotQueueMax(cfg) {
  return Math.max(8, Number(cfg.WATCHLIST_HOT_QUEUE_MAX || 16));
}

function readPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? (n * 100) : n;
}

function getRowHotScore(row) {
  const s = row?.snapshot || {};
  const latest = row?.latest || {};
  const tx30s = Number(s?.txns?.s30?.buys || 0) + Number(s?.txns?.s30?.sells || 0);
  const tx5m = Number(s?.txns?.m5?.buys || 0) + Number(s?.txns?.m5?.sells || 0);
  const tx5mAvg = tx5m > 0 ? (tx5m / 10) : 0;
  const txAccel = tx30s > 0 && tx5mAvg > 0 ? (tx30s / Math.max(1, tx5mAvg)) : 0;
  const ret1 = Number.isFinite(Number(s?.priceChange?.m1))
    ? Number(s?.priceChange?.m1)
    : (Number(latest?.pc1h || 0) / 60);
  const piNow = Number(latest?.priceImpactPct ?? s?.entryHints?.priceImpactPct ?? 0);
  const piBase = Number(row?.meta?.priceImpactBase || piNow || 0);
  const impactExpansion = piNow > 0 && piBase > 0 ? (piNow / Math.max(0.0001, piBase)) : 0;
  const liq = Number(latest?.liqUsd || 0);

  // simple weighted score for HOT retention
  return (txAccel * 4) + (ret1 * 1.5) + (impactExpansion * 2) + (Math.log10(Math.max(1, liq)) * 1.2);
}

function queueHotWatchlistMint({ state, cfg, mint, nowMs, priority = 1, reason = 'unspecified', counters = null }) {
  const wl = ensureWatchlistState(state);
  const queue = Array.isArray(wl.hotQueue) ? wl.hotQueue : [];
  const existingIdx = queue.findIndex(x => x?.mint === mint);
  const hotUntilMs = nowMs + Number(cfg.HOT_TTL_MS || 600_000);
  const next = { mint, atMs: nowMs, priority: Number(priority || 1), hotUntilMs, reason };
  if (existingIdx >= 0) {
    const prev = queue[existingIdx] || {};
    queue.splice(existingIdx, 1);
    next.priority = Math.max(Number(prev.priority || 0), next.priority);
    next.hotUntilMs = Math.max(Number(prev.hotUntilMs || 0), next.hotUntilMs);
  }
  queue.push(next);
  queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
  const max = watchlistHotQueueMax(cfg);
  if (queue.length > max) {
    const candidateRow = wl.mints?.[mint] || null;
    const candidateScore = getRowHotScore(candidateRow);
    let lowestIdx = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < queue.length; i += 1) {
      const qMint = String(queue[i]?.mint || '');
      const row = wl.mints?.[qMint] || null;
      const score = getRowHotScore(row);
      if (score < lowestScore) {
        lowestScore = score;
        lowestIdx = i;
      }
    }
    const margin = 0.5;
    if (candidateScore > (lowestScore + margin)) {
      if (lowestIdx >= 0) {
        queue.splice(lowestIdx, 1);
        counters && (counters.watchlist.capEvictions = Number(counters.watchlist.capEvictions || 0) + 1);
      }
    } else {
      const idxCandidate = queue.findIndex(x => x?.mint === mint);
      if (idxCandidate >= 0) queue.splice(idxCandidate, 1);
      counters && (counters.watchlist.rejectedDueToCap = Number(counters.watchlist.rejectedDueToCap || 0) + 1);
    }
    queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
    if (queue.length > max) queue.length = max;
  }
  wl.hotQueue = queue;
  if (counters?.watchlist) {
    counters.watchlist.hotQueueSizeSamples ||= [];
    counters.watchlist.hotQueueSizeSamples.push({ tMs: nowMs, size: Number(queue.length || 0), cap: Number(max || 0) });
    if (counters.watchlist.hotQueueSizeSamples.length > 200) counters.watchlist.hotQueueSizeSamples = counters.watchlist.hotQueueSizeSamples.slice(-200);
  }
}

function watchlistEntriesSorted(state) {
  const wl = ensureWatchlistState(state);
  return Object.entries(wl.mints).sort((a, b) => {
    const aT = Number(a?.[1]?.lastEvaluatedAtMs || 0);
    const bT = Number(b?.[1]?.lastEvaluatedAtMs || 0);
    return aT - bT;
  });
}

function watchlistEntriesPrioritized({ state, cfg, limit, nowMs }) {
  const wl = ensureWatchlistState(state);
  const mints = wl.mints || {};
  const activeMints = new Set(Object.keys(mints));
  
  // Single-pass filter and collect valid hot queue items with extracted numbers
  const validHotItems = [];
  const hotQueue = wl.hotQueue || [];
  
  for (let i = 0; i < hotQueue.length; i++) {
    const item = hotQueue[i];
    const mint = item?.mint;
    const hotUntil = Number(item?.hotUntilMs || 0);
    
    if (mint && activeMints.has(mint) && hotUntil > nowMs) {
      validHotItems.push({
        mint,
        priority: Number(item?.priority || 0),
        atMs: Number(item?.atMs || 0),
        hotUntilMs: hotUntil,
        item
      });
    }
  }
  
  // Sort once with pre-extracted numbers (avoids Number() calls in comparator)
  validHotItems.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    return priorityDiff !== 0 ? priorityDiff : b.atMs - a.atMs;
  });
  
  // Pick from hot queue first
  const picked = [];
  const seen = new Set();
  
  for (let i = 0; i < validHotItems.length && picked.length < limit; i++) {
    const { mint } = validHotItems[i];
    if (seen.has(mint)) continue;
    
    const row = mints[mint];
    if (!row) continue;
    
    picked.push([mint, row, true]);
    seen.add(mint);
  }
  
  // Fill remaining with non-hot mints if needed
  if (picked.length < limit) {
    const mintsWithTime = [];
    
    for (const mint in mints) {
      if (seen.has(mint)) continue;
      const row = mints[mint];
      mintsWithTime.push({
        mint,
        row,
        time: Number(row?.lastEvaluatedAtMs || 0)
      });
    }
    
    // Sort by evaluation time (oldest first)
    mintsWithTime.sort((a, b) => a.time - b.time);
    
    for (let i = 0; i < mintsWithTime.length && picked.length < limit; i++) {
      const { mint, row } = mintsWithTime[i];
      picked.push([mint, row, false]);
      seen.add(mint);
    }
  }
  
  // Rebuild hotQueue efficiently - filter items not yet seen
  const maxHotQueue = watchlistHotQueueMax(cfg);
  const newHotQueue = [];
  
  for (let i = 0; i < validHotItems.length && newHotQueue.length < maxHotQueue; i++) {
    const { mint, item } = validHotItems[i];
    if (!seen.has(mint)) {
      newHotQueue.push(item);
    }
  }
  
  wl.hotQueue = newHotQueue;
  
  return picked;
}

function normalizeEpochMsGlobal(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const parsed = Date.parse(String(v || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function resolvePairCreatedAtGlobal(...vals) {
  for (const v of vals) {
    const n = normalizeEpochMsGlobal(v);
    if (n) return n;
  }
  return null;
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

async function upsertWatchlistMint({ state, cfg, nowMs, tok, mint, pair, snapshot, counters, routeHint = false, birdseye = null }) {
  const wl = ensureWatchlistState(state);
  const prev = wl.mints[mint] || null;
  const liqUsd = Number(snapshot?.liquidityUsd || pair?.liquidity?.usd || 0);
  const mcapUsd = Number(snapshot?.marketCapUsd || pair?.marketCap || pair?.fdv || tok?.marketCap || 0);
  const spreadPct = Number(snapshot?.spreadPct ?? pair?.spreadPct ?? pair?.market?.spreadPct ?? pair?.raw?.spreadPct);
  const top10Pct = readPct(snapshot?.top10HoldersPct ?? snapshot?.top10Pct ?? pair?.top10HoldersPct ?? tok?.top10HoldersPct ?? tok?.top10Pct);
  const topHolderPct = readPct(snapshot?.topHolderPct ?? pair?.topHolderPct ?? tok?.topHolderPct);
  const bundleClusterPct = readPct(snapshot?.bundleClusterPct ?? pair?.bundleClusterPct ?? tok?.bundleClusterPct);
  const buys1h = Number(pair?.txns?.h1?.buys || 0);
  const sells1h = Number(pair?.txns?.h1?.sells || 0);
  const holders = Number(snapshot?.entryHints?.participation?.holders ?? snapshot?.pair?.participation?.holders ?? pair?.participation?.holders ?? tok?.holders ?? 0) || null;
  const resolvedPairCreatedAt = resolvePairCreatedAtGlobal(
    pair?.pairCreatedAt,
    snapshot?.pairCreatedAt,
    snapshot?.pair?.pairCreatedAt,
    tok?.pairCreatedAt,
    tok?.pair_created_at,
    tok?.createdAt,
    tok?.created_at,
    tok?.launchTime,
    prev?.latest?.pairCreatedAt,
    prev?.pair?.pairCreatedAt,
  );

  const next = {
    mint,
    symbol: pair?.baseToken?.symbol || tok?.tokenSymbol || prev?.symbol || null,
    source: tok?._source || prev?.source || 'dex',
    firstSeenAtMs: Number(prev?.firstSeenAtMs || nowMs),
    lastSeenAtMs: nowMs,
    lastEvaluatedAtMs: Number(prev?.lastEvaluatedAtMs || 0),
    lastAttemptAtMs: Number(prev?.lastAttemptAtMs || 0),
    lastFillAtMs: Number(prev?.lastFillAtMs || 0),
    lastTriggerHitAtMs: Number(prev?.lastTriggerHitAtMs || 0),
    cooldownUntilMs: Number(prev?.cooldownUntilMs || 0),
    hotPromotionCooldownUntilMs: Number(prev?.hotPromotionCooldownUntilMs || 0),
    attempts: Number(prev?.attempts || 0),
    staleCycles: Number(prev?.staleCycles || 0),
    totalAttempts: Number(prev?.totalAttempts || 0),
    totalFills: Number(prev?.totalFills || 0),
    routeHint: routeHint || prev?.routeHint === true,
    pair,
    snapshot,
    latest: {
      priceUsd: Number(snapshot?.priceUsd || pair?.priceUsd || 0) || null,
      liqUsd,
      v1h: Number(pair?.volume?.h1 || 0),
      v4h: Number(pair?.volume?.h4 || 0),
      buys1h,
      sells1h,
      tx1h: buys1h + sells1h,
      pc1h: Number(pair?.priceChange?.h1 || 0),
      pc4h: Number(pair?.priceChange?.h4 || 0),
      mcapUsd: Number.isFinite(mcapUsd) ? mcapUsd : null,
      spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
      top10Pct,
      topHolderPct,
      bundleClusterPct,
      holders,
      priceImpactPct: Number(snapshot?.entryHints?.priceImpactPct ?? pair?.priceImpactPct ?? prev?.latest?.priceImpactPct ?? 0) || null,
      marketDataSource: snapshot?.source || null,
      marketDataFreshnessMs: snapshot?.freshnessMs ?? null,
      marketDataConfidence: snapshot?.confidence || null,
      pairCreatedAt: resolvedPairCreatedAt,
    },
    evictAtMs: nowMs + cfg.WATCHLIST_MINT_TTL_MS,
  };
  wl.mints[mint] = next;
  recordConfirmCarryTrace(state, mint, 'postUpsert', {
    carryPresent: !!(next?.meta?.confirmTxCarry && Number(next.meta.confirmTxCarry?.atMs || 0) > 0),
    carryTx1m: Number(next?.meta?.confirmTxCarry?.tx1m || 0) || null,
    carryTx5mAvg: Number(next?.meta?.confirmTxCarry?.tx5mAvg || 0) || null,
    carryBuySellRatio: Number(next?.meta?.confirmTxCarry?.buySellRatio || 0) || null,
    rowPath: `watchlist.mints.${mint}.meta.confirmTxCarry`,
  });
  if (prev) {
    wl.stats.refreshed = Number(wl.stats.refreshed || 0) + 1;
    counters.watchlist.refreshed += 1;
  } else {
    wl.stats.ingested = Number(wl.stats.ingested || 0) + 1;
    counters.watchlist.ingested += 1;
  }
  // Pre-momentum HOT promotion triggers (ANY):
  // - tx_30s > 1.8 * tx_5m_avg
  // - unique buyers spike
  // - 3 buys within 5 seconds (proxied by tx_30s buys >= 3)
  // - Jupiter priceImpact spike (>2.5x baseline)
  const prevMeta = prev?.meta || {};
  const tx30s = Number(snapshot?.txns?.s30?.buys || 0) + Number(snapshot?.txns?.s30?.sells || 0);
  const tx5m = Number(snapshot?.txns?.m5?.buys || 0) + Number(snapshot?.txns?.m5?.sells || 0);
  const tx5mAvg = tx5m > 0 ? (tx5m / 10) : Number(prevMeta.tx5mAvg || 0);
  const tx30sBuys = Number(snapshot?.txns?.s30?.buys || 0);
  const uniqueBuyers = Number(snapshot?.entryHints?.participation?.uniqueBuyers || snapshot?.pair?.participation?.uniqueBuyers || 0);
  const uniqueBuyersBase = Number(prevMeta.uniqueBuyersBase || uniqueBuyers || 0);
  const uniqueBuyerSpike = uniqueBuyers > 0 && (uniqueBuyersBase <= 0 ? uniqueBuyers >= 3 : uniqueBuyers >= Math.max(3, uniqueBuyersBase * 1.5));
  const txAccelTrigger = tx30s > (1.8 * Math.max(1, tx5mAvg));
  const burstBuysTrigger = tx30sBuys >= 3;
  const priceImpactNow = Number(next?.latest?.priceImpactPct || prev?.latest?.priceImpactPct || 0);
  const priceImpactBase = Number(prevMeta.priceImpactBase || priceImpactNow || 0);
  const priceImpactSpike = priceImpactNow > 0 && priceImpactBase > 0 && priceImpactNow > (2.5 * priceImpactBase);

  // Pre-runner derived microstructure metrics (attention signal only)
  const tx1mNow = Number(next?.latest?.tx1m ?? snapshot?.tx_1m ?? 0);
  const tx5mAvgNow = Number(next?.latest?.tx5mAvg ?? snapshot?.tx_5m_avg ?? 0);
  const uniqueBuyers1mNow = Number(next?.latest?.uniqueBuyers1m ?? snapshot?.uniqueBuyers1m ?? 0);
  const uniqueBuyers5mRaw = Number(next?.latest?.uniqueBuyers5m ?? snapshot?.uniqueBuyers5m ?? 0);
  const uniqueBuyers5mAvgNow = uniqueBuyers5mRaw > 0 ? (uniqueBuyers5mRaw / 5) : 0;
  const buySellRatioNow = Number(next?.latest?.buySellRatio ?? snapshot?.buySellRatio ?? 0);
  const txAccelRatio = tx1mNow / Math.max(0.0001, tx5mAvgNow);
  const walletExpansionRatio = uniqueBuyers1mNow / Math.max(0.0001, uniqueBuyers5mAvgNow);
  const priceImpactExpansionRatio = priceImpactNow / Math.max(0.0001, priceImpactBase || priceImpactNow || 0.0001);
  const buySellRatioBase = Number(prevMeta.buySellRatioBase || buySellRatioNow || 0);
  const buyDominanceTrend = (buySellRatioNow - buySellRatioBase);

  next.meta = {
    ...(next.meta || {}),
    tx5mAvg: tx5mAvg || null,
    uniqueBuyersBase: uniqueBuyersBase > 0 ? uniqueBuyersBase : (uniqueBuyers || null),
    priceImpactBase: priceImpactBase > 0 ? priceImpactBase : (priceImpactNow || null),
    buySellRatioBase: buySellRatioBase > 0 ? buySellRatioBase : (buySellRatioNow || null),
    preHotMissingFieldsCooldownUntilMs: Number(prevMeta.preHotMissingFieldsCooldownUntilMs || 0),
    preHotMissingFieldsLast: Array.isArray(prevMeta.preHotMissingFieldsLast) ? prevMeta.preHotMissingFieldsLast : [],
    confirmTxCarry: (prevMeta?.confirmTxCarry && Number(prevMeta.confirmTxCarry?.atMs || 0) > 0)
      ? prevMeta.confirmTxCarry
      : null,
  };

  const requiredMissingNow = [];
  const pairCreatedAt0 = Number(next?.latest?.pairCreatedAt || 0) || null;
  const poolAgeSec0 = pairCreatedAt0 ? Math.max(0, (nowMs - pairCreatedAt0) / 1000) : null;
  if (!(mcapUsd > 0)) requiredMissingNow.push('mcap');
  if (!(liqUsd > 0)) requiredMissingNow.push('liquidity');
  if (!(poolAgeSec0 != null)) requiredMissingNow.push('age');
  if (!(top10Pct != null)) requiredMissingNow.push('top10');

  // PreHOT fetch-on-demand (single BirdEye-lite fetch per cooldown window) for missing required fields.
  if (requiredMissingNow.length > 0
    && birdseye?.enabled
    && typeof birdseye?.getTokenSnapshot === 'function'
    && Number(next.meta.preHotMissingFieldsCooldownUntilMs || 0) <= nowMs) {
    counters.watchlist.preHotMissingFetchAttempted = Number(counters.watchlist.preHotMissingFetchAttempted || 0) + 1;
    try {
      const preHotLite = await birdseye.getTokenSnapshot(mint);
      if (preHotLite) {
        counters.watchlist.preHotMissingFetchSucceeded = Number(counters.watchlist.preHotMissingFetchSucceeded || 0) + 1;
        if (Number(preHotLite?.liquidityUsd || 0) > 0) {
          next.latest.liqUsd = Number(preHotLite.liquidityUsd);
        }
        if (Number(preHotLite?.marketCapUsd || 0) > 0) {
          next.latest.mcapUsd = Number(preHotLite.marketCapUsd);
        }
        if (Number(preHotLite?.pairCreatedAt || 0) > 0) {
          next.latest.pairCreatedAt = Number(preHotLite.pairCreatedAt);
        }
        const t10 = readPct(preHotLite?.top10HoldersPct ?? preHotLite?.top10Pct);
        if (t10 != null) next.latest.top10Pct = t10;
        const th = readPct(preHotLite?.topHolderPct);
        if (th != null) next.latest.topHolderPct = th;
        const bc = readPct(preHotLite?.bundleClusterPct);
        if (bc != null) next.latest.bundleClusterPct = bc;
        const sp = Number(preHotLite?.spreadPct);
        if (Number.isFinite(sp)) next.latest.spreadPct = sp;
      }
    } catch {}
  }

  const PRE_RUNNER_ENABLED = !!cfg.PRE_RUNNER_ENABLED;
  const PRE_RUNNER_TX_ACCEL_MIN = Number(cfg.PRE_RUNNER_TX_ACCEL_MIN || 0);
  const PRE_RUNNER_WALLET_EXPANSION_MIN = Number(cfg.PRE_RUNNER_WALLET_EXPANSION_MIN || 0);
  const PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN = Number(cfg.PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN || 0);
  const PRE_RUNNER_FAST_WINDOW_MS = Number(cfg.PRE_RUNNER_FAST_WINDOW_MS || 60_000);
  const HOT_MIN_ABS_TX1H_HEALTHY = Number(cfg.HOT_MIN_ABS_TX1H_HEALTHY || 0);
  const HOT_MIN_ABS_VOLUME_5M_HEALTHY = Number(cfg.HOT_MIN_ABS_VOLUME_5M_HEALTHY || 0);
  const BURST_PROMOTION_ENABLED = !!cfg.BURST_PROMOTION_ENABLED;
  const BURST_TX_ACCEL_MIN = Number(cfg.BURST_TX_ACCEL_MIN || 0);
  const BURST_WALLET_EXPANSION_MIN = Number(cfg.BURST_WALLET_EXPANSION_MIN || 0);
  const BURST_VOLUME_EXPANSION_MIN = Number(cfg.BURST_VOLUME_EXPANSION_MIN || 0);
  const BURST_FAST_WINDOW_MS = Number(cfg.BURST_FAST_WINDOW_MS || 45_000);

  let hotReason = txAccelTrigger ? 'tx30sAccel' : uniqueBuyerSpike ? 'uniqueBuyersSpike' : burstBuysTrigger ? 'burstBuys' : priceImpactSpike ? 'jupPriceImpactSpike' : (next.routeHint ? 'routeHint' : null);
  if (PRE_RUNNER_ENABLED && !hotReason) {
    // if any pre-runner metric is interesting, bring into hot review queue
    if (txAccelRatio >= PRE_RUNNER_TX_ACCEL_MIN || walletExpansionRatio >= PRE_RUNNER_WALLET_EXPANSION_MIN || priceImpactExpansionRatio >= PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN) {
      hotReason = 'preRunnerSignal';
    }
  }

  if (hotReason) {
    if (Number(next.hotPromotionCooldownUntilMs || 0) > nowMs) {
      counters.watchlist.preHotFailedByReason ||= {};
      counters.watchlist.preHotFailedByReason.cooldown = Number(counters.watchlist.preHotFailedByReason.cooldown || 0) + 1;
      return;
    }
    counters.watchlist.preHotConsidered = Number(counters.watchlist.preHotConsidered || 0) + 1;
    counters.watchlist.preHotFailedByReason ||= {};

    const liqEff = Number(next?.latest?.liqUsd || 0);
    const mcapEff = Number(next?.latest?.mcapUsd || 0);
    const top10Eff = readPct(next?.latest?.top10Pct);
    const topHolderEff = readPct(next?.latest?.topHolderPct);
    const bundleEff = readPct(next?.latest?.bundleClusterPct);
    const spreadEff = Number(next?.latest?.spreadPct);
    const holdersEff = Number(next?.latest?.holders || 0) || null;
    const pairCreatedAt = Number(next?.latest?.pairCreatedAt || 0) || null;
    const poolAgeSec = pairCreatedAt ? Math.max(0, (nowMs - pairCreatedAt) / 1000) : null;
    const missing = [];
    // Pre-HOT should not hard-block on mcap/age; those are enforced at hot stage.
    if (!(liqEff > 0)) missing.push('liquidity');
    if (!(top10Eff != null)) missing.push('top10');
    if (!(holdersEff != null) && !cfg.HOLDER_MISSING_SOFT_ALLOW) missing.push('holders');

    const failReasons = [];
    if (missing.length) {
      failReasons.push(...missing);
      counters.watchlist.preHotMissingStillMissing = Number(counters.watchlist.preHotMissingStillMissing || 0) + 1;
      next.meta.preHotMissingFieldsCooldownUntilMs = nowMs + (10 * 60_000);
      next.meta.preHotMissingFieldsLast = missing;
      pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: `preHot(missing:${missing.join(',')})` });
    }
    const maxTop10Pct = Number(cfg.MAX_TOP10_PCT || 38);
    const maxTopHolderPct = Number(cfg.MAX_TOP_HOLDER_PCT || 3.5);
    const maxBundlePct = Number(cfg.MAX_BUNDLE_CLUSTER_PCT || 15);
    const preHotMinLiqUsd = Number(state?.filterOverrides?.MIN_LIQUIDITY_FLOOR_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 120_000);
    if (liqEff > 0 && liqEff < preHotMinLiqUsd) failReasons.push('liquidity');
    if (top10Eff != null && top10Eff > maxTop10Pct) failReasons.push('top10');
    if (topHolderEff != null && topHolderEff > maxTopHolderPct) failReasons.push('topHolder');
    if (bundleEff != null && bundleEff > maxBundlePct) failReasons.push('bundleCluster');
    if (Number.isFinite(spreadEff) && spreadEff > 3) failReasons.push('spread');

    const holderGate = holdersGateCheck({ cfg, holders: holdersEff, poolAgeSec });
    if (!holderGate.ok) failReasons.push(holderGate.reason);

    // Whale distribution shock reject: if concentration jumps quickly pre-entry, cool down mint.
    const prevTopHolder = Number(next?.meta?.prevTopHolderPct ?? NaN);
    const prevTop10 = Number(next?.meta?.prevTop10Pct ?? NaN);
    if (Number.isFinite(prevTopHolder) && topHolderEff != null && (topHolderEff - prevTopHolder) >= 1.5) failReasons.push('topHolderJump');
    if (Number.isFinite(prevTop10) && top10Eff != null && (top10Eff - prevTop10) >= 4) failReasons.push('top10Jump');
    if (topHolderEff != null) next.meta.prevTopHolderPct = topHolderEff;
    if (top10Eff != null) next.meta.prevTop10Pct = top10Eff;

    // Pre-runner tagging path (attention signal only, not a trade signal)
    counters.watchlist.preRunnerRejectedByReason ||= {};
    counters.watchlist.preRunnerLast10 ||= [];
    const snapshotFreshEnough = Number(next?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? Infinity) <= Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 45_000);
    const preRunnerLiquidityPass = liqEff >= preHotMinLiqUsd;
    const txAccelBaseline = Number(prevMeta.txAccelRatioBase || txAccelRatio || 0);
    const walletExpansionBaseline = Number(prevMeta.walletExpansionRatioBase || walletExpansionRatio || 0);
    const priceImpactExpansionBaseline = Number(prevMeta.priceImpactExpansionRatioBase || priceImpactExpansionRatio || 0);
    const txAccelRising = txAccelRatio >= PRE_RUNNER_TX_ACCEL_MIN && txAccelRatio >= txAccelBaseline;
    const walletRising = walletExpansionRatio >= PRE_RUNNER_WALLET_EXPANSION_MIN && walletExpansionRatio >= walletExpansionBaseline;
    const buyDominanceImprovingOrPositive = (buySellRatioNow > 1.0) || (buyDominanceTrend > 0);
    const impactExpanding = priceImpactExpansionRatio >= PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN && priceImpactExpansionRatio >= priceImpactExpansionBaseline;
    const noHardSafetyReject = failReasons.length === 0;

    // Burst-promotion path (upstream quality focus before momentum scoring)
    counters.watchlist.burstRejectedByReason ||= {};
    counters.watchlist.burstLast10 ||= [];
    const burstVolume5m = Number(next?.latest?.volume5m ?? snapshot?.volume_5m ?? snapshot?.pair?.birdeye?.volume_5m ?? 0);
    const burstVolume30mAvg = Number(next?.latest?.volume30mAvg ?? snapshot?.volume_30m_avg ?? snapshot?.pair?.birdeye?.volume_30m_avg ?? 0);
    const volumeExpansionRatio = Number(burstVolume5m || 0) / Math.max(0.0001, Number(burstVolume30mAvg || 0));
    const volumeNeutralOrPositive = volumeExpansionRatio >= BURST_VOLUME_EXPANSION_MIN;
    const burstTxImproving = txAccelRatio >= BURST_TX_ACCEL_MIN && txAccelRatio >= txAccelBaseline;
    const burstWalletImproving = walletExpansionRatio >= BURST_WALLET_EXPANSION_MIN && walletExpansionRatio >= walletExpansionBaseline;
    const burstBuySellImproving = (buyDominanceTrend > 0) || (buySellRatioNow > 1.0);
    const burstSignal = BURST_PROMOTION_ENABLED
      && snapshotFreshEnough
      && preRunnerLiquidityPass
      && burstTxImproving
      && burstWalletImproving
      && burstBuySellImproving
      && volumeNeutralOrPositive
      && noHardSafetyReject;

    const preRunner = PRE_RUNNER_ENABLED
      && snapshotFreshEnough
      && preRunnerLiquidityPass
      && txAccelRising
      && walletRising
      && buyDominanceImprovingOrPositive
      && impactExpanding
      && noHardSafetyReject;

    next.meta.txAccelRatioBase = txAccelRatio > 0 ? txAccelRatio : txAccelBaseline;
    next.meta.walletExpansionRatioBase = walletExpansionRatio > 0 ? walletExpansionRatio : walletExpansionBaseline;
    next.meta.priceImpactExpansionRatioBase = priceImpactExpansionRatio > 0 ? priceImpactExpansionRatio : priceImpactExpansionBaseline;

    if (burstSignal) {
      counters.watchlist.burstTagged = Number(counters.watchlist.burstTagged || 0) + 1;
      counters.watchlist.burstTxAccelSum = Number(counters.watchlist.burstTxAccelSum || 0) + Number(txAccelRatio || 0);
      counters.watchlist.burstWalletExpansionSum = Number(counters.watchlist.burstWalletExpansionSum || 0) + Number(walletExpansionRatio || 0);
      counters.watchlist.burstBuySellRatioSum = Number(counters.watchlist.burstBuySellRatioSum || 0) + Number(buySellRatioNow || 0);
      next.meta.burst = {
        active: true,
        taggedAtMs: Number(next?.meta?.burst?.taggedAtMs || nowMs),
        lastSeenAtMs: nowMs,
        fastUntilMs: nowMs + BURST_FAST_WINDOW_MS,
        txAccelRatio,
        walletExpansionRatio,
        buySellRatio: buySellRatioNow,
        volumeExpansionRatio,
      };
      counters.watchlist.burstLast10.push({
        tMs: nowMs,
        mint,
        liquidity: liqEff,
        txAccelRatio,
        walletExpansionRatio,
        buySellRatio: buySellRatioNow,
        volumeExpansionRatio,
        finalStageReached: 'tagged',
      });
      while (counters.watchlist.burstLast10.length > 10) counters.watchlist.burstLast10.shift();
    } else if (BURST_PROMOTION_ENABLED) {
      if (!snapshotFreshEnough) counters.watchlist.burstRejectedByReason.snapshotFreshness = Number(counters.watchlist.burstRejectedByReason.snapshotFreshness || 0) + 1;
      if (!preRunnerLiquidityPass) counters.watchlist.burstRejectedByReason.liquidity = Number(counters.watchlist.burstRejectedByReason.liquidity || 0) + 1;
      if (!burstTxImproving) counters.watchlist.burstRejectedByReason.txAccel = Number(counters.watchlist.burstRejectedByReason.txAccel || 0) + 1;
      if (!burstWalletImproving) counters.watchlist.burstRejectedByReason.walletExpansion = Number(counters.watchlist.burstRejectedByReason.walletExpansion || 0) + 1;
      if (!burstBuySellImproving) counters.watchlist.burstRejectedByReason.buySellTrend = Number(counters.watchlist.burstRejectedByReason.buySellTrend || 0) + 1;
      if (!volumeNeutralOrPositive) counters.watchlist.burstRejectedByReason.volumeExpansion = Number(counters.watchlist.burstRejectedByReason.volumeExpansion || 0) + 1;
      if (!noHardSafetyReject) counters.watchlist.burstRejectedByReason.hardSafetyReject = Number(counters.watchlist.burstRejectedByReason.hardSafetyReject || 0) + 1;
    }

    if (preRunner) {
      counters.watchlist.preRunnerTagged = Number(counters.watchlist.preRunnerTagged || 0) + 1;
      next.meta.preRunner = {
        active: true,
        taggedAtMs: Number(next?.meta?.preRunner?.taggedAtMs || nowMs),
        lastSeenAtMs: nowMs,
        fastUntilMs: nowMs + PRE_RUNNER_FAST_WINDOW_MS,
        txAccelRatio,
        walletExpansionRatio,
        priceImpactExpansionRatio,
        buySellRatio: buySellRatioNow,
      };
      counters.watchlist.preRunnerLast10.push({
        tMs: nowMs,
        mint,
        liquidity: liqEff,
        txAccelRatio,
        walletExpansionRatio,
        priceImpactExpansionRatio,
        buySellRatio: buySellRatioNow,
        finalStageReached: 'tagged',
      });
      while (counters.watchlist.preRunnerLast10.length > 10) counters.watchlist.preRunnerLast10.shift();
    } else if (PRE_RUNNER_ENABLED) {
      if (!snapshotFreshEnough) counters.watchlist.preRunnerRejectedByReason.snapshotFreshness = Number(counters.watchlist.preRunnerRejectedByReason.snapshotFreshness || 0) + 1;
      if (!preRunnerLiquidityPass) counters.watchlist.preRunnerRejectedByReason.liquidity = Number(counters.watchlist.preRunnerRejectedByReason.liquidity || 0) + 1;
      if (!txAccelRising) counters.watchlist.preRunnerRejectedByReason.txAccel = Number(counters.watchlist.preRunnerRejectedByReason.txAccel || 0) + 1;
      if (!walletRising) counters.watchlist.preRunnerRejectedByReason.walletExpansion = Number(counters.watchlist.preRunnerRejectedByReason.walletExpansion || 0) + 1;
      if (!buyDominanceImprovingOrPositive) counters.watchlist.preRunnerRejectedByReason.buyDominanceTrend = Number(counters.watchlist.preRunnerRejectedByReason.buyDominanceTrend || 0) + 1;
      if (!impactExpanding) counters.watchlist.preRunnerRejectedByReason.priceImpactExpansion = Number(counters.watchlist.preRunnerRejectedByReason.priceImpactExpansion || 0) + 1;
      if (!noHardSafetyReject) counters.watchlist.preRunnerRejectedByReason.hardSafetyReject = Number(counters.watchlist.preRunnerRejectedByReason.hardSafetyReject || 0) + 1;
    }

    if (failReasons.length > 0) {
      counters.watchlist.preHotFailed = Number(counters.watchlist.preHotFailed || 0) + 1;
      for (const r of failReasons) {
        counters.watchlist.preHotFailedByReason[r] = Number(counters.watchlist.preHotFailedByReason[r] || 0) + 1;
      }
      next.hotPromotionCooldownUntilMs = nowMs + (5 * 60_000);
    } else {
      counters.watchlist.preHotPassed = Number(counters.watchlist.preHotPassed || 0) + 1;
      if (bundleClusterPct == null) {
        pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: 'preHot(bundleClusterMissing_nonBlocking)' });
      }
      if (!Number.isFinite(spreadPct)) {
        pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: 'preHot(spreadMissing_nonBlocking)' });
      }

      const absTx1hNow = Number(next?.latest?.tx1h || 0);
      const absVolume5mNow = Number(next?.latest?.volume5m ?? snapshot?.volume_5m ?? snapshot?.pair?.birdeye?.volume_5m ?? 0);
      const absTxHealthy = absTx1hNow >= HOT_MIN_ABS_TX1H_HEALTHY;
      const absVolumeHealthy = absVolume5mNow >= HOT_MIN_ABS_VOLUME_5M_HEALTHY;

      const hotPriority = 10
        + Math.min(4, Math.floor(Math.log10(Math.max(1, liqEff))))
        + Math.min(4, Math.floor(Number(next?.latest?.tx1h || 0) / 40))
        + (txAccelTrigger ? 2 : 0)
        + (uniqueBuyerSpike ? 2 : 0)
        + (burstBuysTrigger ? 1 : 0)
        + (priceImpactSpike ? 1 : 0)
        // Minimum absolute activity boosts are priority-only (not pass/fail)
        + (absTxHealthy ? 2 : 0)
        + (absVolumeHealthy ? 2 : 0)
        + ((absTxHealthy && absVolumeHealthy) ? 2 : 0);
      if (Number(next.hotPromotionCooldownUntilMs || 0) <= nowMs) {
        queueHotWatchlistMint({ state, cfg, mint, nowMs, priority: hotPriority, reason: hotReason, counters });
        counters.watchlist.hotEnqueued += 1;
      }
    }
  }
}

function bumpRouteAvailableDropped(counters, reason) {
  counters.route.routeAvailableDropped ||= {};
  const key = String(reason || 'unknown');
  counters.route.routeAvailableDropped[key] = Number(counters.route.routeAvailableDropped[key] || 0) + 1;
}

async function promoteRouteAvailableCandidate({ state, cfg, counters, nowMs, tok, mint, immediateRows, immediateRowMints, birdseye = null }) {
  counters.route.routeAvailableSeen = Number(counters.route.routeAvailableSeen || 0) + 1;
  if (!cfg.WATCHLIST_TRIGGER_MODE) {
    bumpRouteAvailableDropped(counters, 'watchlistDisabled');
    return false;
  }

  const routePairCreatedAt = resolvePairCreatedAtGlobal(
    tok?.pairCreatedAt,
    tok?.pair_created_at,
    tok?.createdAt,
    tok?.created_at,
    tok?.launchTime,
  );

  const syntheticPair = {
    baseToken: { address: mint, symbol: tok?.tokenSymbol || null },
    liquidity: { usd: 0 },
    volume: { h1: 0, h4: 0 },
    txns: { h1: { buys: 0, sells: 0 } },
    priceChange: { h1: 0, h4: 0 },
    pairCreatedAt: routePairCreatedAt,
    pairAddress: null,
    dexId: tok?._source || 'route',
    priceUsd: null,
  };
  const syntheticSnapshot = {
    priceUsd: null,
    liquidityUsd: 0,
    source: 'routeAvailableOnly',
    freshnessMs: 0,
    confidenceScore: 0,
    confidence: 'low',
  };

  await upsertWatchlistMint({ state, cfg, nowMs, tok, mint, pair: syntheticPair, snapshot: syntheticSnapshot, counters, routeHint: true, birdseye });
  const row = state.watchlist?.mints?.[mint] || null;
  if (!row) {
    bumpRouteAvailableDropped(counters, 'watchlistUpsertFailed');
    return false;
  }

  const promotion = promoteRouteAvailableCandidateToImmediate({
    mint,
    row,
    nowMs,
    dedupMs: cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS,
    immediateRows,
    immediateRowMints,
  });
  if (!promotion.promoted) {
    bumpRouteAvailableDropped(counters, promotion.reason);
    return false;
  }

  counters.watchlist.immediateRoutePromoted += 1;
  counters.route.routeAvailablePromotedToWatchlist = Number(counters.route.routeAvailablePromotedToWatchlist || 0) + 1;
  return true;
}

function getWatchlistMintAgeHours(row, nowMs) {
  const createdAtMs = resolvePairCreatedAtGlobal(row?.latest?.pairCreatedAt, row?.pair?.pairCreatedAt);
  if (!createdAtMs || createdAtMs > nowMs) return null;
  return (nowMs - createdAtMs) / 3_600_000;
}

function evictWatchlist({ state, cfg, nowMs, counters }) {
  const wl = ensureWatchlistState(state);
  let evicted = 0;
  let ageEvicted = 0;
  let staleEvicted = 0;
  let ttlEvicted = 0;

  for (const [mint, row] of Object.entries(wl.mints)) {
    const mintAgeHours = getWatchlistMintAgeHours(row, nowMs);
    if (mintAgeHours != null && mintAgeHours >= cfg.WATCHLIST_EVICT_MAX_AGE_HOURS) {
      delete wl.mints[mint];
      evicted += 1;
      ageEvicted += 1;
      continue;
    }
    if (Number(row?.staleCycles || 0) >= cfg.WATCHLIST_EVICT_STALE_CYCLES) {
      delete wl.mints[mint];
      evicted += 1;
      staleEvicted += 1;
      continue;
    }
    if (Number(row?.evictAtMs || 0) <= nowMs) {
      delete wl.mints[mint];
      evicted += 1;
      ttlEvicted += 1;
    }
  }

  const size = Object.keys(wl.mints).length;
  if (size > cfg.WATCHLIST_MAX_SIZE) {
    const extra = size - cfg.WATCHLIST_MAX_SIZE;
    const victims = watchlistEntriesSorted(state).slice(0, extra);
    for (const [mint] of victims) {
      delete wl.mints[mint];
      evicted += 1;
      ttlEvicted += 1;
    }
  }

  const aliveMints = new Set(Object.keys(wl.mints || {}));
  wl.hotQueue = (wl.hotQueue || []).filter(item => aliveMints.has(item?.mint)).slice(0, watchlistHotQueueMax(cfg));

  if (evicted > 0) {
    wl.stats.evicted = Number(wl.stats.evicted || 0) + evicted;
    wl.stats.ageEvicted = Number(wl.stats.ageEvicted || 0) + ageEvicted;
    wl.stats.staleEvicted = Number(wl.stats.staleEvicted || 0) + staleEvicted;
    wl.stats.ttlEvicted = Number(wl.stats.ttlEvicted || 0) + ttlEvicted;
    counters.watchlist.evicted += evicted;
    counters.watchlist.ageEvicted += ageEvicted;
    counters.watchlist.staleEvicted += staleEvicted;
    counters.watchlist.ttlEvicted += ttlEvicted;
  }
  return evicted;
}

function formatWatchlistSummary({ state, counters, nowMs = Date.now() }) {
  const wl = ensureWatchlistState(state);
  const size = Object.keys(wl.mints || {}).length;
  const hotDepth = Number((wl.hotQueue || []).length);
  const oldestMs = Math.min(...Object.values(wl.mints || {}).map(x => Number(x?.firstSeenAtMs || nowMs)), nowMs);
  const spanMin = size > 0 ? ((nowMs - oldestMs) / 60000) : 0;
  const minute = counters?.watchlist?.funnelMinute || {};
  const cumulative = counters?.watchlist?.funnelCumulative || {};
  const immediateBlockedTop = Object.entries(counters?.watchlist?.immediateBlockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ') || 'none';
  const minuteTopBlocked = Object.entries(minute?.blockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}/m`)
    .join(', ') || 'none';
  const topBlocked = Object.entries(cumulative?.blockedByReason || {})
    .filter(([, v]) => Number(v || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ') || 'none';
  return `🧺 watchlist size=${size} hotDepth=${hotDepth} spanMin=${spanMin.toFixed(1)} churn(+${Number(wl.stats?.ingested || 0)}/~${Number(wl.stats?.refreshed || 0)}/-${Number(wl.stats?.evicted || 0)} age=${Number(wl.stats?.ageEvicted || 0)} stale=${Number(wl.stats?.staleEvicted || 0)} ttl=${Number(wl.stats?.ttlEvicted || 0)}) hot(enq/cons/att/fill)=${Number(counters?.watchlist?.hotEnqueued || 0)}/${Number(counters?.watchlist?.hotConsumed || 0)}/${Number(counters?.watchlist?.hotAttempts || 0)}/${Number(counters?.watchlist?.hotFills || 0)} routeCache(hit/miss/fromCache/staleInvalid)=${Number(counters?.watchlist?.routeCacheHit || 0)}/${Number(counters?.watchlist?.routeCacheMiss || 0)}/${Number(counters?.watchlist?.attemptFromRouteCache || 0)}/${Number(counters?.watchlist?.routeCacheStaleInvalidated || 0)} immediate(promoted/confirm/att/fill)=${Number(counters?.watchlist?.immediateRoutePromoted || 0)}/${Number(counters?.watchlist?.immediateConfirmPassed || 0)}/${Number(counters?.watchlist?.immediateAttempts || 0)}/${Number(counters?.watchlist?.immediateFills || 0)} immediateBlockedTop=${immediateBlockedTop} minute(seen/eval/momo/confirm/attempt/fill)=${Number(minute.watchlistSeen || 0)}/${Number(minute.watchlistEvaluated || 0)}/${Number(minute.momentumPassed || 0)}/${Number(minute.confirmPassed || 0)}/${Number(minute.attempted || 0)}/${Number(minute.filled || 0)} blockedTop/min=${minuteTopBlocked} cumulative=${Number(cumulative.watchlistSeen || 0)}/${Number(cumulative.watchlistEvaluated || 0)}/${Number(cumulative.momentumPassed || 0)}/${Number(cumulative.confirmPassed || 0)}/${Number(cumulative.attempted || 0)}/${Number(cumulative.filled || 0)} blockedTop=${topBlocked}`;
}

function bumpImmediateBlockedReason(counters, blockedReason) {
  counters.watchlist.immediateBlockedByReason ||= {};
  const key = String(blockedReason || 'unknown');
  counters.watchlist.immediateBlockedByReason[key] = Number(counters.watchlist.immediateBlockedByReason[key] || 0) + 1;
}

async function evaluateWatchlistRows({ rows, cfg, state, counters, nowMs, executionAllowed, executionAllowedReason = null, solUsdNow, conn, pub, wallet, birdseye = null, immediateMode = false, canary = null }) {
  const hotBypassTracePath = path.join(path.dirname(cfg.STATE_PATH || 'state/state.json'), 'hot_bypass_trace.jsonl');
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
        hardRejects: Array.isArray(extra?.hardRejects) ? extra.hardRejects.slice(0,6).map(String) : [],
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
        hardRejects: Array.isArray(extra?.hardRejects) ? extra.hardRejects.slice(0,6).map(String) : [],
        fail: String(extra?.fail || 'none')
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
        continuationConfirmStartedAtMs: Number.isFinite(Number(extra?.continuationConfirmStartedAtMs)) ? Number(extra.continuationConfirmStartedAtMs) : null,
        continuationWsUpdateCountWithinWindow: Number(extra?.continuationWsUpdateCountWithinWindow || 0) || 0,
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

    // Option 3: Birdseye is authoritative for watchlist *entry snapshot safety*.
    // This allows route-available promotions (no DEX pair) to still be evaluated.
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
        // Keep HOT bypass floor reference aligned with snapshot safety floor source.
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

    // If we don't have a DexScreener pair, synthesize the minimum shape for downstream filters.
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

    // HOT mcap defer-and-refresh path: missing/unresolved mcap should retry briefly before hard-fail.
    if (!(mcapHot > 0)) {
      const enriched = await tryHotEnrichedRefresh('mcapMissing');
      if (enriched) {
        ({ value: mcapHot, source: mcapSourceUsed } = resolveMcapHot());
        if (mcapHot > 0) counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
        else counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
      }

      if (!(mcapHot > 0)) {
        // Momentum-stalking bypass path: allow unresolved mcap to proceed to momentum only.
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

    // resolve pairCreatedAt centrally (priority: pair.pairCreatedAt, snapshot.pairCreatedAt, snapshot.pair.pairCreatedAt, row.latest.pairCreatedAt, snapshot raw/birdeye created, fallback missing)
    function resolvePairCreatedAt({pair, snapshot, row}){
      const candidates = [
        { value: pair?.pairCreatedAt, source: 'pair.pairCreatedAt' },
        { value: snapshot?.pairCreatedAt, source: 'snapshot.pairCreatedAt' },
        { value: snapshot?.pair?.pairCreatedAt, source: 'snapshot.pair.pairCreatedAt' },
        { value: row?.latest?.pairCreatedAt, source: 'row.latest.pairCreatedAt' },
        { value: snapshot?.raw?.created_at ?? snapshot?.raw?.pair_created_at ?? snapshot?.pair?.birdeye?.created_at ?? snapshot?.pair?.created_at, source: 'snapshot.birdeyeCreated' },
      ];
      for(const c of candidates){
        const n = normalizeEpochMs(c.value);
        if (n) return { pairCreatedAtMs: n, source: c.source };
      }
      // no resolved age
      return { pairCreatedAtMs: null, source: 'missing' };
    }
    const resolvedAgeKey = `resolvedPairCreatedAt:${mint}`;
    // cache in row.meta to avoid recompute
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

    // Hot-stage hard gates for mcap + age (moved from preHot).
    if (mcapHot != null && mcapHot < hotMinMcap) {
      bumpPostBypassReject('other');
      finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: `hot.mcapLow(<${Math.round(hotMinMcap)})`, momentumCounterIncremented: false, confirmCounterIncremented: false });
      if (fail(`mcapLow(<${Math.round(hotMinMcap)})`, { stage: 'hot', cooldownMs: 30_000 }) === 'break') break;
      continue;
    }
    if (!(poolAgeSecForHolders != null)) {
      // age missing: allow temporary HOT age-pending path when configured and safe
      const HOT_ALLOW_AGE_PENDING = !!cfg.HOT_ALLOW_AGE_PENDING;
      const HOT_AGE_PENDING_MAX_EVALS = Number(cfg.HOT_AGE_PENDING_MAX_EVALS || 3);
      const HOT_AGE_PENDING_MAX_MS = Number(cfg.HOT_AGE_PENDING_MAX_MS || 180000);
      const HOT_AGE_PENDING_COOLDOWN_MS = Number(cfg.HOT_AGE_PENDING_COOLDOWN_MS || 300000);

      // snapshot usable + liquidity passes + data fresh + no hard safety reject
      const snapshotUsable = getSnapshotStatus({ snapshot, latest: row?.latest })?.usable ?? true;
      const liquidityPasses = Number(pair?.liquidity?.usd || snapshot?.liquidityUsd || row?.latest?.liqUsd || 0) >= 0;
      const dataFresh = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? Infinity) <= Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000);
      const hardSafetyOk = !(row?.meta?.hardSafetyReject);

      if (row?.meta?.hotMomentumOnlyLiquidityBypass && Number(hotMinAgeHours || 0) <= 0) {
        counters.watchlist.hotPostBypassAllowedMissingAge = Number(counters.watchlist.hotPostBypassAllowedMissingAge || 0) + 1;
      } else if (HOT_ALLOW_AGE_PENDING && snapshotUsable && liquidityPasses && dataFresh && hardSafetyOk) {
        // increment allow counter and mark agePendingHot
        counters.watchlist.hotAgePendingAllowed = Number(counters.watchlist.hotAgePendingAllowed || 0) + 1;
        row.meta.agePendingHot ||= { tStartedMs: nowMs, evals: 0, lastEvalMs: nowMs };
        row.meta.agePendingHot.evals = Number(row.meta.agePendingHot.evals || 0) + 1;
        row.meta.agePendingHot.lastEvalMs = nowMs;
        // track see counts
        counters.watchlist.momentumAgePendingSeen = Number(counters.watchlist.momentumAgePendingSeen || 0) + 1;
        // allow progression to momentum despite missing age
        row.meta.agePendingHot.status = 'allowed';
        // expiry checks
        if (Number(row.meta.agePendingHot.evals || 0) > HOT_AGE_PENDING_MAX_EVALS || (nowMs - Number(row.meta.agePendingHot.tStartedMs || nowMs)) > HOT_AGE_PENDING_MAX_MS) {
          // mark expired and cool down
          row.meta.agePendingHot.status = 'expired';
          counters.watchlist.hotAgePendingExpired = Number(counters.watchlist.hotAgePendingExpired || 0) + 1;
          bumpPostBypassReject('agePendingExpired');
          if (fail('agePendingExpired', { stage: 'hot', cooldownMs: HOT_AGE_PENDING_COOLDOWN_MS }) === 'break') break;
          continue;
        }
        // continue flow (do not reject)
      } else {
        // reject as before
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

    // use resolved cached age if available; otherwise attempt RPC fallback
    let agePicked = { value: null, source: 'missing' };
    if (resolved?.pairCreatedAtMs) {
      agePicked = { value: Number(resolved.pairCreatedAtMs), source: String(resolved.source || 'resolved') };
    } else {
      const cachedAge = getCachedMintCreatedAt({ state, mint, nowMs, maxAgeMs: 60 * 60_000 });
      if (cachedAge?.createdAtMs) {
        row.latest ||= {};
        row.latest.pairCreatedAt = Number(cachedAge.createdAtMs);
        agePicked = { value: Number(cachedAge.createdAtMs), source: String(cachedAge.source || 'cache.mintCreatedAt') };
        // persist resolved caching
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
    // count age source
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
      // Molecular momentum diagnostics (canary-only): include exact sub-checks + thresholds.
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
      const microFreshGate = isMicroFreshEnough({
        microPresentCount: momentumMicroPresent,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
        maxAgeMs: Number(cfg.MOMENTUM_MICRO_MAX_AGE_MS || 10_000),
        requireFreshMicro: !!cfg.MOMENTUM_REQUIRE_FRESH_MICRO,
        minPresentForGate: Number(cfg.MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE || 3),
      });

      // Score-model truth: momentum pass is driven by sig.ok (score threshold + hard guards)
      // plus freshness/hysteresis overlays.
      // regardless of earlyTokenMode. Keep earlyPassCount for diagnostics only.
      let momentumGateOk = !!sig.ok && !!microFreshGate.ok;

      // Paper metrics are diagnostics-only for legacy history; do not add them to live fail reasons.
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

      // Always-on momentum failure telemetry (works even when canary is off)
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
        hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0,6) : [],
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
        hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0,6) : [],
        tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
        tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
        tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
        momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
        momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
        momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
        topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0,3) : [],
        topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0,3) : [],
        final: 'momentum.momentumFailed',
      });
      pushCompactWindowEvent('momentumScoreSample', null, {
        mint,
        momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
        momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
        momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
        topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0,5) : [],
        topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0,5) : [],
        final: 'momentum.momentumFailed',
      });

      // Surgical hysteresis: suppress repeated near-identical momentum failures for same mint.
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

    // Requalification guard: if a mint was blocked after stop-out, clear it only on a fresh momentum pass.
    try {
      state.runtime ||= {};
      state.runtime.requalifyAfterStopByMint ||= {};
      if (state.runtime.requalifyAfterStopByMint[mint]) {
        delete state.runtime.requalifyAfterStopByMint[mint];
        counters.watchlist.requalifyClearedOnMomentumPass = Number(counters.watchlist.requalifyClearedOnMomentumPass || 0) + 1;
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
      hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0,6) : [],
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
      hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0,6) : [],
      tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
      tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
      tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
      momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
      momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
      momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
      topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0,3) : [],
      topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0,3) : [],
      final: 'momentum.passed',
    });
    pushCompactWindowEvent('momentumScoreSample', null, {
      mint,
      momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
      momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
      momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
      topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0,5) : [],
      topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0,5) : [],
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

    // Parallelize independent API calls (rugcheck + mcap computation)
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
    
    // Run rugcheck and mcap computation in parallel
    const parallelResults = await Promise.allSettled([
      cfg.RUGCHECK_ENABLED ? getRugcheckReport(mint).catch(err => ({ _error: err })) : Promise.resolve(null),
      needsMcapComputation ? computeMcapUsd(cfg, pair, cfg.SOLANA_RPC_URL).catch(err => ({ ok: false, reason: 'error', _error: err })) : Promise.resolve({ ok: false, reason: 'not_needed' })
    ]);
    
    // Process rugcheck result
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
    
    // Process mcap result
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
      // Confirm-stage cadence target: 200-400ms
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

    // Confirm-stage liquidity stability guardrail: reject if liquidity drops >12% within 60s.
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
        continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
        continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
        continuationSelectedTradeReads: Number(confirmGate?.diag?.selectedTradeReads || 0) || 0,
        continuationSelectedOhlcvReads: Number(confirmGate?.diag?.selectedOhlcvReads || 0) || 0,
        continuationWsUpdateTimestamps: Array.isArray(confirmGate?.diag?.wsUpdateTimestamps) ? confirmGate.diag.wsUpdateTimestamps.slice(0, 24) : [],
        continuationWsUpdatePrices: Array.isArray(confirmGate?.diag?.wsUpdatePrices) ? confirmGate.diag.wsUpdatePrices.slice(0, 24) : [],
        continuationTradeUpdateTimestamps: Array.isArray(confirmGate?.diag?.tradeUpdateTimestamps) ? confirmGate.diag.tradeUpdateTimestamps.slice(0, 24) : [],
        continuationTradeUpdatePrices: Array.isArray(confirmGate?.diag?.tradeUpdatePrices) ? confirmGate.diag.tradeUpdatePrices.slice(0, 24) : [],
      });
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
      continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
      continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
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

    // After stop-outs, mint must re-qualify via fresh momentum pass before attempt path can run.
    state.runtime ||= {};
    state.runtime.requalifyAfterStopByMint ||= {};
    if (state.runtime.requalifyAfterStopByMint[mint]) {
      counters.watchlist.requalifyBlockedAttempts = Number(counters.watchlist.requalifyBlockedAttempts || 0) + 1;
      if (fail('attemptNeedsRequalify', { stage: 'attempt', meta: { blockedAtMs: Number(state.runtime.requalifyAfterStopByMint[mint]?.blockedAtMs || 0), trigger: String(state.runtime.requalifyAfterStopByMint[mint]?.trigger || 'stop') } }) === 'break') break;
      continue;
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
      const quoteAgeMs = 0;
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
      pushCompactWindowEvent('postMomentumFlow', null, {
        mint,
        liq: Number(liqForAttempt || 0),
        mcap: Number(mcapForEntry || 0),
        ageMin: Number.isFinite(tokenAgeMinutes) ? tokenAgeMinutes : null,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN),
        priceImpactPct: confirmPriceImpactPct,
        slippageBps: confirmSlippageBps,
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
      try{ wsmgr.onFill(mint, {
        entryPrice: state.positions?.[mint]?.entryPriceUsd,
        stopPrice: state.positions?.[mint]?.stopPriceUsd,
        stopPct: state.positions?.[mint]?.stopAtEntry ? 0 : 0.01,
        trailingPct: state.positions?.[mint]?.trailDistancePct,
      }); }catch(e){}
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
        t: nowIso(), mint, attemptEntered: true, quoteBuilt: Number.isFinite(Number(expectedOutAmount)) && Number(expectedOutAmount) > 0, quoteRefreshed: !usedRouteCacheForAttempt, routeSource: usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote', quoteAgeMs: 0, swapSubmissionEntered: true, outcome: 'threw', finalReason: `swapError(${safeMsg(e)})`
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
          quoteAgeMs: 0,
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

// Process-level safety nets. Keep logging, avoid silent death, and only exit on true
// programming errors.
process.on('unhandledRejection', (reason) => {
  // Most of our transient failures (Dex/RPC/Jup) are handled closer to the source.
  // This is the "belt and suspenders" log.
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Hard-exit so PM2 restarts us; this indicates a bug / broken invariant.
  process.exit(1);
});

// Local-only health endpoint (observability / watchdog).
// Binds to 127.0.0.1 by default so it is not exposed publicly.
function startHealthServer({ stateRef, getSnapshot }) {
  const enabled = String(process.env.HEALTH_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) return null;

  const host = process.env.HEALTH_HOST || '127.0.0.1';
  const port = Number(process.env.HEALTH_PORT || 8787);

  const server = http.createServer((req, res) => {
    try {
      if (req.url !== '/healthz') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      const snap = getSnapshot();
      const body = JSON.stringify({
        ok: true,
        t: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        pid: process.pid,
        tradingEnabled: !!stateRef?.tradingEnabled,
        openPositions: snap.openPositions,
        lastScanAtMs: snap.lastScanAtMs,
        lastPositionsLoopAtMs: snap.lastPositionsLoopAtMs,
        dexCooldownUntilMs: snap.dexCooldownUntilMs,
        loopDtMs: snap.loopDtMs,
      });

      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end('error');
    }
  });

  server.listen(port, host, () => {
    console.log('[health] listening on http://' + host + ':' + port + '/healthz');
  });

  return server;
}

function loadWallet() {
  if (process.env.SOPS_WALLET_FILE) return loadKeypairFromSopsFile(process.env.SOPS_WALLET_FILE);
  return loadKeypairFromEnv();
}

function fmtUsd(x) {
  return `$${Number(x).toFixed(2)}`;
}

import fs from 'node:fs';

function appendLearningNote(line) {
  try {
    const p = './TRADING_LEARNINGS.md';
    const ts = nowIso();
    fs.appendFileSync(p, `\n- ${ts} ${line}\n`);
  } catch (e) {
    console.warn('[learning-log] append failed:', safeErr(e).message);
  }
}

function appendCanaryTrace(tracePath, event) {
  try {
    if (!tracePath) return;
    const dir = tracePath.split('/').slice(0, -1).join('/');
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(tracePath, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    console.warn('[canary-trace] append failed:', safeErr(e).message);
  }
}

function emitCanaryCycleEvent({ cfg, state, mint = null, stage, reason, nowMs = Date.now(), meta = null }) {
  const event = {
    timestamp: new Date(nowMs).toISOString(),
    mint: mint || null,
    canary: { stage: String(stage || 'unknown') },
    reason: String(reason || 'unknown'),
    meta: meta || null,
  };
  state.debug ||= {};
  state.debug.canary ||= {};
  state.debug.canary.latest = event;
  appendCanaryTrace(cfg.CONVERSION_CANARY_TRACE_PATH, event);
  return event;
}

async function fetchAlchemySolPrice() {
  try {
    const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY || null;
    if (!key) return null;
    const url = `https://api.alchemy.com/v2/${key}`;
    // Alchemy has a 'getTokenPrice' JSON-RPC or rest endpoint; use a lightweight Coingecko fallback if not available.
    // Try Alchemy REST /getTokenPrice is provider-specific; skip to simple JSON-RPC getPrice via RPC not universally supported.
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchCoingeckoSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (!res.ok) return null;
    const j = await res.json();
    const p = Number(j?.solana?.usd || 0);
    if (!p) return null;
    return p;
  } catch (e) {
    return null;
  }
}

async function getSolUsdPrice() {
  // Try multi-source: Coingecko preferred (reliable, free), then DexScreener fallback.
  // Also keep a cached last price to boot quickly when providers fail.
  const cachePath = './state/last_sol_price.json';

  // 1) Try Coingecko
  const cg = await fetchCoingeckoSolPrice();
  if (cg) {
    try { fs.writeFileSync(cachePath, JSON.stringify({ solUsd: cg, src: 'coingecko', at: Date.now() })); } catch {}
    return { solUsd: cg, pair: { source: 'coingecko' } };
  }

  // 2) Try DexScreener as before
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const pairs = await getTokenPairs('solana', SOL_MINT);
    const best = pickBestPair(pairs);
    const p = Number(best?.priceUsd || 0);
    if (p) {
      try { fs.writeFileSync(cachePath, JSON.stringify({ solUsd: p, src: 'dexscreener', at: Date.now() })); } catch {}
      return { solUsd: p, pair: best };
    }
  } catch (e) {
    // ignore
  }

  // 3) Fall back to cached value if present
  try {
    if (fs.existsSync(cachePath)) {
      const j = JSON.parse(fs.readFileSync(cachePath,'utf8'));
      if (j && typeof j.solUsd === 'number') return { solUsd: j.solUsd, pair: { source: 'cache' } };
    }
  } catch (e) {}

  throw new Error('Unable to fetch SOL USD price from any provider');
}

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

function positionCount(state) {
  return Object.values(state.positions || {}).filter(p => p?.status === 'open').length;
}

function entryCapacityAvailable(state, cfg) {
  state.runtime ||= {};
  const open = positionCount(state);
  const maxPos = Math.max(0, Number(cfg.MAX_POSITIONS || 0));
  const resumeAt = Math.max(0, maxPos - 1);

  if (state.runtime.maxPosHaltActive) {
    if (open <= resumeAt) state.runtime.maxPosHaltActive = false;
  } else if (open >= maxPos) {
    state.runtime.maxPosHaltActive = true;
  }

  return !state.runtime.maxPosHaltActive && open < maxPos;
}

function enforceEntryCapacityGate({ state, cfg, mint, symbol = null, tag = 'generic' }) {
  const nowMs = Date.now();
  const pauseUntilMs = Number(state?.exposure?.pausedUntilMs || 0);
  if (pauseUntilMs > nowMs) {
    pushDebug(state, {
      t: nowIso(),
      mint,
      symbol,
      reason: `ENTRY(blocked exposurePause ${tag} until=${new Date(pauseUntilMs).toISOString()})`,
    });
    return false;
  }
  if (entryCapacityAvailable(state, cfg)) return true;
  pushDebug(state, {
    t: nowIso(),
    mint,
    symbol,
    reason: `ENTRY(blocked preSwap maxPositionsHysteresis ${tag})`,
  });
  return false;
}

function cleanTokenText(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined' || low === 'n/a') return '';
  return s;
}

function tokenDisplayName({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  if (n) return n;
  const s = cleanTokenText(symbol);
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

function tokenDisplayWithSymbol({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  const s = cleanTokenText(symbol);
  if (n && s) return `${n} (${s})`;
  if (n) return n;
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

function conservativeExitMark(priceUsd, pos = null, snapshot = null, cfg = null) {
  const px = Number(priceUsd || 0);
  if (!(px > 0)) return px;
  const spreadPct = Number(snapshot?.spreadPct ?? snapshot?.pair?.spreadPct ?? snapshot?.pair?.market?.spreadPct ?? snapshot?.pair?.raw?.spreadPct);
  const spread = Number.isFinite(spreadPct) && spreadPct > 0 ? (spreadPct / 100) : 0;
  const slip = Math.max(0, Number(cfg?.DEFAULT_SLIPPAGE_BPS || 0) / 10_000);
  const baseHaircut = Math.max(0.01, Math.min(0.04, slip * 0.6));
  const spreadHaircut = Math.max(0, Math.min(0.04, spread * 0.5));
  const totalHaircut = Math.max(0.01, Math.min(0.08, baseHaircut + spreadHaircut));
  return px * (1 - totalHaircut);
}

function applyMomentumDefaultsToPosition(cfg, pos) {
  if (!pos || pos.status !== 'open') return;
  const entry = Number(pos.entryPriceUsd || 0);
  if (!entry) return;

  // Ensure momentum rules are present.
  pos.stopAtEntry = true;
  pos.trailActivatePct = cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT;
  pos.trailDistancePct = cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT;

  // Adaptive baseline: before trailing, keep hard stop at entry (no negative buffer).
  pos.stopPriceUsd = Math.max(Number(pos.stopPriceUsd || 0), entry);
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

async function openPosition(cfg, conn, wallet, state, solUsd, pair, mcapUsd, decimals, rugReport, signal, tradeCfg) {
  const mint = tradeCfg?.mint || pair?.baseToken?.address || null;
  const tokenName = tradeCfg?.tokenName || pair?.baseToken?.name || null;
  const symbol = tradeCfg?.symbol || pair?.baseToken?.symbol || null;
  const display = tokenDisplayName({ name: tokenName, symbol, mint });

  const confidenceScore = Number(tradeCfg?.entrySnapshot?.confidenceScore ?? tradeCfg?.confidenceScore ?? NaN);
  const c = Number.isFinite(confidenceScore) ? Math.max(0, Math.min(1, confidenceScore)) : 0.5;
  const entrySnapshot = tradeCfg?.entrySnapshot || null;
  const liqUsdAtEntry = Number(entrySnapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? pair?.birdeye?.raw?.liquidity ?? 0) || 0;
  const mcapUsdAtEntry = Number.isFinite(Number(mcapUsd)) ? Number(mcapUsd) : Number(entrySnapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || 0;
  const snapHolders = Number(entrySnapshot?.entryHints?.participation?.holders ?? entrySnapshot?.pair?.participation?.holders ?? 0) || null;
  const snapUniqueBuyers = Number(entrySnapshot?.entryHints?.participation?.uniqueBuyers ?? entrySnapshot?.pair?.participation?.uniqueBuyers ?? 0) || null;
  const dynamicUsdTarget = Number(cfg.LIVE_MOMO_USD_MIN || 2) + ((Number(cfg.LIVE_MOMO_USD_MAX || 7) - Number(cfg.LIVE_MOMO_USD_MIN || 2)) * c);
  const usdTargetBase = tradeCfg?.usdTarget ?? dynamicUsdTarget;
  const conc = getConcentrationMetrics(rugReport);
  const sizeCutForTop10 = (conc.top10Pct != null && conc.top10Pct >= 30 && conc.top10Pct <= 38) ? 0.5 : 1;
  const signalBuyDominance = Number(signal?.buyDominance ?? ((Number(signal?.buys1h || 0) + Number(signal?.sells1h || 0)) > 0
    ? (Number(signal?.buys1h || 0) / (Number(signal?.buys1h || 0) + Number(signal?.sells1h || 0)))
    : NaN));
  const usdTarget = usdTargetBase * sizeCutForTop10;
  const slippageBps = tradeCfg?.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS;

  if (!(mcapUsdAtEntry >= Number(cfg.ENTRY_MIN_MCAP_USD || 120000))) {
    return {
      blocked: true,
      reason: 'entryMcapTooLow',
      mint,
      symbol,
      meta: { mcapUsdAtEntry, required: Number(cfg.ENTRY_MIN_MCAP_USD || 120000) },
    };
  }
  if (!(liqUsdAtEntry >= Number(cfg.ENTRY_MIN_LIQUIDITY_USD || 30000))) {
    return {
      blocked: true,
      reason: 'entryLiquidityMissingOrLow',
      mint,
      symbol,
      meta: { liqUsdAtEntry, required: Number(cfg.ENTRY_MIN_LIQUIDITY_USD || 30000) },
    };
  }

  const stopAtEntry = (tradeCfg?.stopAtEntry ?? cfg.LIVE_MOMO_STOP_AT_ENTRY) === true;
  const stopAtEntryBufferPct = Number.isFinite(Number(tradeCfg?.stopAtEntryBufferPct))
    ? Number(tradeCfg.stopAtEntryBufferPct)
    : cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT;
  const trailActivatePct = Number.isFinite(Number(tradeCfg?.trailActivatePct))
    ? Number(tradeCfg.trailActivatePct)
    : cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT;
  const trailDistancePct = Number.isFinite(Number(tradeCfg?.trailDistancePct))
    ? Number(tradeCfg.trailDistancePct)
    : cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT;

  // Hard guard: never execute a swap unless we can reliably persist entry + stop.
  const resolved = await resolveEntryAndStopForOpenPosition({
    mint,
    pair,
    snapshot: tradeCfg?.entrySnapshot || null,
    decimalsHint: decimals,
    stopAtEntry,
    stopAtEntryBufferPct,
    stopLossPct: cfg.STOP_LOSS_PCT,
    birdeyeEnabled: !!tradeCfg?.birdeyeEnabled,
    getBirdseyeSnapshot: tradeCfg?.getBirdseyeSnapshot || null,
    birdeyeFetchTimeoutMs: cfg.BIRDEYE_ENTRY_FETCH_TIMEOUT_MS,
    rpcUrl: cfg.SOLANA_RPC_URL,
    getTokenSupply,
  });

  if (!resolved.ok) {
    return {
      blocked: true,
      reason: resolved.reason,
      mint,
      symbol,
      meta: {
        priceSource: resolved.priceSource,
        pairPriceUsd: Number(pair?.priceUsd || 0) || null,
        snapPriceUsd: Number(tradeCfg?.entrySnapshot?.priceUsd || 0) || null,
        decimalsHint: (typeof decimals === 'number') ? decimals : null,
        decimalsSource: resolved?.decimalsSource || null,
        decimalsSourcesTried: Array.isArray(resolved?.decimalsSourcesTried) ? resolved.decimalsSourcesTried : [],
        mintResolvedForDecimals: resolved?.mintResolvedForDecimals || mint || null,
        pairBaseTokenAddress: resolved?.pairBaseTokenAddress || pair?.baseToken?.address || null,
      },
    };
  }

  let entryPriceUsd = Number(resolved.entryPriceUsd);
  let stopPriceUsd = Number(resolved.stopPriceUsd);
  // Adaptive trailing system baseline: pnl < 30% => hard stop at entry (no buffer).
  stopPriceUsd = entryPriceUsd;
  const decimalsResolved = resolved.decimals;

  // Convert USD target into SOL at current SOLUSD.
  const maxSol = usdTarget / solUsd;
  const inAmountLamports = toBaseUnits(maxSol, DECIMALS[cfg.SOL_MINT] ?? 9);

  const res = await executeSwap({
    conn,
    wallet,
    inputMint: cfg.SOL_MINT,
    outputMint: mint,
    inAmountBaseUnits: inAmountLamports,
    slippageBps,
    maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
    expectedOutAmount: tradeCfg?.expectedOutAmount,
    expectedInAmount: tradeCfg?.expectedInAmount,
    maxQuoteDegradePct: cfg.MAX_QUOTE_DEGRADE_PCT,
    twoStageSlippageRetryEnabled: !!(cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED),
    twoStageSlippageRetryBps: cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS,
    twoStageSlippageMaxBps: cfg.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS,
  });

  const fillIn = Number(res?.fill?.inAmountRaw || 0);
  const fillOut = Number(res?.fill?.outAmountRaw || 0);
  const fillOutDecimals = Number(res?.fill?.outDecimals || decimalsResolved || 0);
  const fillInSol = fillIn > 0 ? (fillIn / 1e9) : null;
  const fillOutTokens = (fillOut > 0 && fillOutDecimals >= 0) ? (fillOut / (10 ** fillOutDecimals)) : null;
  const liveEntryPriceUsd = (fillInSol && fillOutTokens && solUsd > 0)
    ? ((fillInSol * solUsd) / fillOutTokens)
    : null;

  if (Number.isFinite(Number(liveEntryPriceUsd)) && Number(liveEntryPriceUsd) > 0) {
    entryPriceUsd = Number(liveEntryPriceUsd);
    // Adaptive baseline: hard stop at entry before trailing activation.
    stopPriceUsd = entryPriceUsd;
  }

  const now = Date.now();

  state.positions[mint] = {
    status: 'open',
    mint,
    symbol: symbol || null,
    tokenName: tokenName || null,
    decimals: decimalsResolved,
    pairUrl: pair?.url || null,
    entryAt: new Date(now).toISOString(),
    entryPriceUsd,
    peakPriceUsd: entryPriceUsd,
    trailingActive: false,
    stopAtEntry,
    stopEvalMode: 'conservative_exec_mark',
    stopPriceUsd,
    mcapUsdAtEntry: Number.isFinite(Number(mcapUsdAtEntry)) ? Number(mcapUsdAtEntry) : null,
    liquidityUsdAtEntry: Number(liqUsdAtEntry || 0) || null,
    trailActivatePct,
    trailDistancePct,
    lastStopUpdateAt: new Date(now).toISOString(),
    lastSeenPriceUsd: entryPriceUsd,
    mcapUsd,
    liquidityUsd: liqUsdAtEntry || 0,
    txns1h: (pair?.txns?.h1?.buys || 0) + (pair?.txns?.h1?.sells || 0),
    signal,
    signalBuyDominance: Number.isFinite(signalBuyDominance) ? signalBuyDominance : null,
    signalTx1h: Number(signal?.tx1h || ((pair?.txns?.h1?.buys || 0) + (pair?.txns?.h1?.sells || 0))) || null,
    holdersAtEntry: snapHolders,
    uniqueBuyersAtEntry: snapUniqueBuyers,
    topHolderPctAtEntry: conc?.topHolderPct ?? null,
    top10PctAtEntry: conc?.top10Pct ?? null,
    bundleClusterPctAtEntry: conc?.bundleClusterPct ?? null,
    creatorClusterPctAtEntry: conc?.creatorClusterPct ?? null,
    lpLockPctAtEntry: conc?.lpLockPct ?? null,
    lpUnlockedAtEntry: conc?.lpUnlocked ?? null,
    spreadPctAtEntry: Number(entrySnapshot?.spreadPct ?? pair?.spreadPct ?? pair?.market?.spreadPct ?? NaN) || null,
    marketDataSourceAtEntry: entrySnapshot?.source || null,
    marketDataConfidenceAtEntry: entrySnapshot?.confidence || null,
    marketDataFreshnessMsAtEntry: Number(entrySnapshot?.freshnessMs || 0) || null,
    quotePriceImpactPctAtEntry: Number(entrySnapshot?.entryHints?.priceImpactPct || 0) || null,
    requestedSlippageBpsAtEntry: Number(slippageBps || 0) || null,
    maxPriceImpactPctAtEntry: Number(cfg.MAX_PRICE_IMPACT_PCT || 0) || null,
    rugScore: rugReport?.score_normalised,
    entryTx: res.signature,
    spentSolApprox: (fillInSol && fillInSol > 0) ? fillInSol : maxSol,
    spentSolTarget: maxSol,
    receivedTokensRaw: fillOut || null,
    entryFeeLamports: Number(res?.fill?.feeLamports || 0) || null,
    entryFeeUsd: Number(res?.fill?.feeLamports || 0) ? ((Number(res.fill.feeLamports) / 1e9) * solUsd) : null,
    solUsdAtEntry: solUsd,
    entryPriceSource: Number.isFinite(Number(liveEntryPriceUsd)) && Number(liveEntryPriceUsd) > 0 ? 'jupiter_fill' : (resolved.priceSource || null),
  };

  // Persist trade entry to TimescaleDB
  if (process.env.TIMESCALE_ENABLED === 'true') {
    import('./timeseries_db.mjs').then(({ insertTradeEntry }) => {
      insertTradeEntry({
        timestamp: now,
        mint,
        entryPriceUsd,
        sizeUsd: usdTarget,
        signature: res?.signature || null,
        momentumScore: signal?.score || null,
        liquidityUsd: liqUsdAtEntry || null,
        source: 'live',
        metadata: { symbol, mcapUsdAtEntry, signalBuyDominance }
      }).catch(() => {});
    }).catch(() => {});
  }

  // Ensure BirdEye WS remains subscribed to active positions for live updates
  try {
    cache.set(`birdeye:sub:${mint}`, true, Math.ceil((cfg.BIRDEYE_LITE_CACHE_TTL_MS || 45000)/1000));
  } catch (e) {
    // ignore cache errors
  }

  // Durable entry ledger row (for exact live replay/backtests later)
  const entryRow = {
    time: nowIso(),
    kind: 'entry',
    mint,
    symbol: display || null,
    entryAt: state.positions[mint].entryAt || null,
    entryTx: res.signature || null,
    spentSolApprox: (fillInSol && fillInSol > 0) ? fillInSol : maxSol,
    spentUsdTarget: Number(cfg.MAX_POSITION_USDC || usdTarget) || null,
    solUsdAtEntry: solUsd,
    entryPriceUsd: entryPriceUsd || null,
    entryPriceSource: state.positions[mint].entryPriceSource || null,
    entryFeeLamports: Number(res?.fill?.feeLamports || 0) || null,
    entryFeeUsd: Number(state.positions[mint].entryFeeUsd || 0) || null,
    liquidityUsdAtEntry: Number(liqUsdAtEntry || 0) || null,
    mcapUsdAtEntry: Number.isFinite(Number(mcapUsdAtEntry)) ? Number(mcapUsdAtEntry) : null,
    holdersAtEntry: Number(state.positions[mint].holdersAtEntry || 0) || null,
    uniqueBuyersAtEntry: Number(state.positions[mint].uniqueBuyersAtEntry || 0) || null,
    topHolderPctAtEntry: Number(state.positions[mint].topHolderPctAtEntry || 0) || null,
    top10PctAtEntry: Number(state.positions[mint].top10PctAtEntry || 0) || null,
    bundleClusterPctAtEntry: Number(state.positions[mint].bundleClusterPctAtEntry || 0) || null,
    creatorClusterPctAtEntry: Number(state.positions[mint].creatorClusterPctAtEntry || 0) || null,
    lpLockPctAtEntry: Number(state.positions[mint].lpLockPctAtEntry || 0) || null,
    lpUnlockedAtEntry: state.positions[mint].lpUnlockedAtEntry ?? null,
    signalBuyDominance: Number(state.positions[mint].signalBuyDominance || 0) || null,
    signalTx1h: Number(state.positions[mint].signalTx1h || 0) || null,
    spreadPctAtEntry: Number(state.positions[mint].spreadPctAtEntry || 0) || null,
    marketDataSourceAtEntry: state.positions[mint].marketDataSourceAtEntry || null,
    marketDataConfidenceAtEntry: state.positions[mint].marketDataConfidenceAtEntry || null,
    marketDataFreshnessMsAtEntry: Number(state.positions[mint].marketDataFreshnessMsAtEntry || 0) || null,
    quotePriceImpactPctAtEntry: Number(state.positions[mint].quotePriceImpactPctAtEntry || 0) || null,
    requestedSlippageBpsAtEntry: Number(state.positions[mint].requestedSlippageBpsAtEntry || 0) || null,
    maxPriceImpactPctAtEntry: Number(state.positions[mint].maxPriceImpactPctAtEntry || 0) || null,
    trailActivatePct: Number(state.positions[mint].trailActivatePct || cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT) || null,
    trailDistancePct: Number(state.positions[mint].trailDistancePct || cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT) || null,
    stopPriceUsdAtEntry: Number(state.positions[mint].stopPriceUsd || 0) || null,
    stopEvalMode: state.positions[mint].stopEvalMode || null,
  };
  try {
    const { appendJsonl } = await import('./candidates_ledger.mjs');
    appendJsonl(cfg.TRADES_LEDGER_PATH, entryRow);
  } catch (e) {
    try { await tgSend(cfg, `⚠️ ENTRY executed but failed to append entry ledger row for ${display} (${mint}): ${e.message || e}`); } catch {}
  }

  const entryHeader = tokenDisplayWithSymbol({
    name: tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
    symbol: symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
    mint,
  });
  const entryBasisSource = state.positions[mint].entryPriceSource || 'snapshot';
  const snapshotMarketPx = Number(entrySnapshot?.priceUsd || pair?.priceUsd || 0);
  const routePlan = Array.isArray(res?.route?.routePlan) ? res.route.routePlan : [];
  const routeHopCount = routePlan.length;
  const routeDexLabels = Array.from(new Set(routePlan
    .map((hop) => String(hop?.swapInfo?.label || '').trim())
    .filter(Boolean)));
  const routePoolKeys = Array.from(new Set(routePlan
    .map((hop) => String(hop?.swapInfo?.ammKey || '').trim())
    .filter(Boolean)));
  const executionDex = routeDexLabels.length ? routeDexLabels.join(' → ') : 'unknown';
  const executionPool = routePoolKeys.length ? routePoolKeys.join(' | ') : 'unknown';
  const executionRoute = routeHopCount <= 0
    ? 'Jupiter (no route metadata)'
    : (routeHopCount === 1 ? 'Jupiter single-hop' : `Jupiter multi-hop (${routeHopCount} hops)`);
  const tokensReceivedLine = (fillOutTokens && Number.isFinite(Number(fillOutTokens)) && Number(fillOutTokens) > 0)
    ? Number(fillOutTokens).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : 'n/a';

  const msg = [
    `🟢 *ENTRY* — ${entryHeader}`,
    '',
    `🧾 Mint: \`${mint}\``,
    `💸 Spent: ~${((fillInSol && fillInSol > 0) ? fillInSol : maxSol).toFixed(4)} SOL (target≈ ${fmtUsd(usdTarget)})`,
    `🏷️ Entry basis (executed): $${entryPriceUsd} (${entryBasisSource})`,
    Number.isFinite(snapshotMarketPx) && snapshotMarketPx > 0
      ? `📊 Market snapshot: $${snapshotMarketPx.toFixed(10)} (${entrySnapshot?.source || 'snapshot'})`
      : `📊 Market snapshot: n/a (${entrySnapshot?.source || 'snapshot'})`,
    `🧩 Execution DEX: ${executionDex}`,
    `🏊 Pool: \`${executionPool}\``,
    `🛣️ Route: ${executionRoute}`,
    `🪙 Tokens received: ${tokensReceivedLine}`,
    `🟠 Stop: $${state.positions[mint].stopPriceUsd.toFixed(6)}  (entry hard stop)`,
    `🟣 Trail: adaptive tiers (0-30%=stop@entry, 30-80%=30%, ≥80%=22%, ≥150%=18%)`,
    '',
    `💧 Liq: ${fmtUsd(liqUsdAtEntry)}   🧢 Mcap: ${fmtUsd(mcapUsdAtEntry)}`,
    `🌞 SOLUSD: $${solUsd.toFixed(2)}`,
    '',
    `🧾 Tx: https://solscan.io/tx/${res.signature}`,
  ].join('\n');

  await tgSend(cfg, msg);
  appendTradingLog(cfg.TRADING_LOG_PATH,
    `\n## ENTRY ${display} (${mint})\n- time: ${nowIso()}\n- spentSolApprox: ${((fillInSol && fillInSol > 0) ? fillInSol : maxSol)}\n- spentUsdTarget: ${cfg.MAX_POSITION_USDC}\n- tokenPriceUsd: ${entryPriceUsd}\n- entryPriceSource: ${state.positions[mint].entryPriceSource || 'snapshot'}\n- solUsd: ${solUsd}\n- entryFeeLamports: ${Number(res?.fill?.feeLamports || 0) || 0}\n- tokensReceived: ${fillOutTokens || 'n/a'}\n- executionDex: ${executionDex}\n- executionPool: ${executionPool}\n- executionRoute: ${executionRoute}\n- mcapUsd: ${mcapUsd}\n- liquidityUsd: ${Number(liqUsdAtEntry || pair?.liquidity?.usd || pair?.birdeye?.raw?.liquidity || 0)}\n- signal: ${JSON.stringify(signal)}\n- rugScore: ${rugReport?.score_normalised}\n- tx: ${res.signature}\n`);

  return res;
}

async function processExposureQueue(cfg, conn, wallet, state) {
  state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
  const nowMs = Date.now();
  // Remove expired queued entries
  state.exposure.queue = (state.exposure.queue || []).filter(q => Number(q.expiryMs || 0) > nowMs);
  // If paused, do nothing
  if (Number(state.exposure.pausedUntilMs || 0) > nowMs) return;
  while (state.exposure.queue.length && Number(state.exposure.activeRunnerCount || 0) < Number(cfg.MAX_ACTIVE_RUNNERS || 3)) {
    const q = state.exposure.queue.shift();
    try {
      const tradeCfg = q.tradeCfg || {};
      if (!enforceEntryCapacityGate({ state, cfg, mint: q.mint, symbol: q.symbol, tag: 'queue' })) continue;
      const entryRes = await openPosition(cfg, conn, wallet, state, q.solUsdNow || 0, q.pair, q.mcap || 0, q.decimals || null, q.report || null, q.sigReasons || null, tradeCfg);
      if (!entryRes?.blocked) {
        state.exposure.activeRunnerCount = Number(state.exposure.activeRunnerCount || 0) + 1;
        pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: `QUEUE(executed)` });
      } else {
        pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: `QUEUE(blocked:${entryRes.reason})` });
      }
    } catch (e) {
      pushDebug(state, { t: nowIso(), mint: q.mint, symbol: q.symbol, reason: `QUEUE(execError:${String(e?.message||e)})` });
    }
  }
  saveState(cfg.STATE_PATH, state);
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
      state.runtime ||= {};
      state.runtime.requalifyAfterStopByMint ||= {};
      state.runtime.requalifyAfterStopByMint[mint] = {
        blockedAtMs: Date.now(),
        trigger: 'stop',
        entryPriceUsd: Number(pos.entryPriceUsd || 0) || null,
        exitPriceUsd: Number(exitPriceUsd || 0) || null,
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

  let changed = false;

  // Determine desired trail pct based on PnL tiers
  const desiredTrailPct = computeTrailPct(profitPct);

  // Rule: pnl < 30% => stop at entry (no buffer), but NEVER widen once tightened.
  if (profitPct < 0.30) {
    // If trailing had already activated, do not lower/reset stop.
    if (pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct))) {
      return { changed, stopPriceUsd: pos.stopPriceUsd };
    }

    const stopPrice = entry * (1 - Number(cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT || 0));
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
          stopPct: pos?.stopAtEntry ? 0 : 0.01,
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

        // Reconcile legacy buffered stops for non-trailing positions.
        const e0 = Number(pos.entryPriceUsd || 0);
        const trailing0 = !!pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct));
        if (e0 > 0 && !trailing0 && (!Number.isFinite(Number(pos.stopPriceUsd)) || Number(pos.stopPriceUsd) < e0)) {
          pos.stopPriceUsd = e0;
          pos.lastStopUpdateAt = nowIso();
          pos.lastStopPrice = e0;
          saveState(cfg.STATE_PATH, state);
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
      const birdeyeCallsPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.birdeyeCalls || 0), 0) / scannerCycleCount)
        : null;
      const rpcCallsPerScan = scannerCycleCount > 0
        ? (scanCyclesWin.reduce((a, x) => a + Number(x?.rpcCalls || 0), 0) / scannerCycleCount)
        : null;
      const maxSingleCallDurationMs = scannerCycleCount > 0
        ? Math.max(...scanCyclesWin.map((x) => Number(x?.maxSingleCallDurationMs || 0)))
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
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none';
      const repeatReasonTop = Object.entries(repeatReasonCountsWin)
        .sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
      const samples = inWindowObj(compactWindow.momentumInputSamples || [])
        .slice(-3)
        .map(x => {
          const m = String(x?.mint || 'n/a').slice(0,6);
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
        .map(x => `- ${String(x?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(x?.liq||0))} mcap=${Math.round(Number(x?.mcap||0))} agePresent=${x?.agePresent ? 'true' : 'false'} ageMin=${Number.isFinite(x?.ageMin) ? Number(x.ageMin).toFixed(1) : 'null'} early=${x?.early ? 'true' : 'false'} branch=${String(x?.branch||'mature_3_of_4')} ${x?.final||'passed'}`);
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

      if (mode === 'execution') {
        const lastAttemptTs = Math.max(...attemptWin.slice(-1), ...fillWin.slice(-1), ...confirmPassedWin.slice(-1), 0);
        const lastAttemptAgeSec = lastAttemptTs > 0 ? Math.max(0, Math.round((nowMs - lastAttemptTs) / 1000)) : 'n/a';
        const hourConfirmPassedE = Number(confirmPassedWin.filter(t=>t>=hourCutoffMs).length);
        const hourAttemptReachedE = Number(attemptWin.filter(t=>t>=hourCutoffMs).length);
        const hourFillE = Number(fillWin.filter(t=>t>=hourCutoffMs).length);
        const hourAttemptPassedE = hourFillE;
        const cumConfirmPassedE = Number(confirmPassedWin.length);
        const cumAttemptReachedE = Number(attemptWin.length);
        const cumFillE = Number(fillWin.length);
        const cumAttemptPassedE = cumFillE;

        const finalLaneRejectCounts = {};
        for (const ev of postFlowWin) {
          if (String(ev?.outcome || '') !== 'rejected') continue;
          const r = String(ev?.reason || 'unknown');
          finalLaneRejectCounts[r] = Number(finalLaneRejectCounts[r] || 0) + 1;
        }
        const topFinalLaneBlockers = Object.entries(finalLaneRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`- ${k} = ${v}`);

        const momentumPassedRowsE = inWindowObj(compactWindow.momentumRecent || []).filter(x => String(x?.final || '').includes('momentum.passed')).slice(-20);
        const postByMintE = {};
        for (const ev of postFlowWin) {
          const m = String(ev?.mint || 'unknown');
          postByMintE[m] ||= [];
          postByMintE[m].push(ev);
        }

        const recentAttemptCandidates = momentumPassedRowsE.slice(-8).map((x) => {
          const mint = String(x?.mint || 'unknown');
          const flow = (postByMintE[mint] || []).filter(e => Number(e?.tMs||0) >= Number(x?.tMs||0));
          const confirmResult = flow.find(e=>e.stage==='confirm'&&e.outcome==='passed') ? 'passed' : (flow.find(e=>e.stage==='confirm'&&e.outcome==='rejected') ? 'rejected' : (flow.find(e=>e.stage==='confirm') ? 'reached' : 'none'));
          const attemptResult = flow.find(e=>e.stage==='attempt'&&e.outcome==='reached') ? 'reached' : (flow.find(e=>e.stage==='attempt'&&e.outcome==='rejected') ? 'rejected' : 'none');
          const fillResult = flow.find(e=>e.stage==='fill'&&e.outcome==='passed') ? 'passed' : 'none';
          const finalReason = flow.slice().reverse().find(e=>String(e?.reason||'none')!=='none')?.reason || (fillResult === 'passed' ? 'filled' : 'none');
          const freshness = flow.find(e=>Number.isFinite(Number(e?.freshnessMs)))?.freshnessMs;
          const pi = flow.find(e=>Number.isFinite(Number(e?.priceImpactPct)))?.priceImpactPct;
          const slip = flow.find(e=>Number.isFinite(Number(e?.slippageBps)))?.slippageBps;
          return `- ${mint.slice(0,6)} liq=${Math.round(Number(x?.liq||0))} mcap=${Math.round(Number(x?.mcap||0))} freshnessMs=${Number.isFinite(Number(freshness)) ? Math.round(Number(freshness)) : 'null'} priceImpactPct=${Number.isFinite(Number(pi)) ? Number(pi).toFixed(4) : 'null'} slippageBps=${Number.isFinite(Number(slip)) ? Number(slip) : 'null'} confirm=${confirmResult} attempt=${attemptResult} reason=${finalReason}`;
        });

        const recentSuccessE = postFlowWin.filter(e => e.stage === 'fill' && e.outcome === 'passed').slice(-5).map((e) => `- ${String(e?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(e?.liq||0))} mcap=${Math.round(Number(e?.mcap||0))} priceImpactPct=${Number.isFinite(Number(e?.priceImpactPct)) ? Number(e.priceImpactPct).toFixed(4) : 'null'} slippageBps=${Number.isFinite(Number(e?.slippageBps)) ? Number(e.slippageBps) : 'null'} fill=passed`);

        const attemptReachedRows = postFlowWin.filter((e) => String(e?.stage || '') === 'attempt' && String(e?.outcome || '') === 'reached').slice(-10);
        const attemptBranchDebugRows = (counters?.watchlist?.attemptBranchDebugLast10 || []);
        const attemptTransitionLast10 = attemptReachedRows.map((e) => {
          const mint = String(e?.mint || 'unknown');
          const reachedTs = Number(e?.tMs || 0);
          const flow = (postByMintE[mint] || [])
            .filter((x) => Number(x?.tMs || 0) >= reachedTs)
            .filter((x) => ['attempt', 'swap', 'fill', 'executeSwap'].includes(String(x?.stage || '')))
            .sort((a,b)=>Number(a?.tMs||0)-Number(b?.tMs||0));
          const next = flow.find((x) => !(String(x?.stage||'') === 'attempt' && String(x?.outcome||'') === 'reached')) || null;
          const fill = flow.find((x) => String(x?.stage||'') === 'fill' && String(x?.outcome||'') === 'passed') || null;
          const swapReject = flow.find((x) => String(x?.stage||'') === 'swap' && String(x?.outcome||'') === 'rejected') || null;
          const branch = attemptBranchDebugRows.slice().reverse().find((x) => String(x?.mint || '') === mint) || null;
          const swapSubmitted = branch ? !!branch?.swapSubmissionEntered : !!fill;
          const nextState = fill ? 'fill.passed' : (next ? `${String(next?.stage||'unknown')}.${String(next?.outcome||'unknown')}` : 'none');
          const finalState = branch
            ? String(branch?.finalReason || 'none')
            : (fill ? 'filled' : (swapReject ? `rejected(${String(swapReject?.reason||'unknown')})` : (next ? `observed(${nextState})` : 'no_followup_recorded')));
          return `- ${mint.slice(0,6)} reachedAt=${reachedTs ? fmtCt(reachedTs) : 'n/a'} swapSubmitted=${swapSubmitted ? 'true' : 'false'} nextState=${nextState} final=${finalState}`;
        });
        const attemptBranchDebugLast10 = attemptBranchDebugRows.slice(-10).map((x) => `- ${String(x?.mint||'n/a').slice(0,6)} attemptEntered=${x?.attemptEntered ? 'true' : 'false'} swapSubmissionEntered=${x?.swapSubmissionEntered ? 'true' : 'false'} branchTaken=${String(x?.branchTaken||'unknown')} finalReason=${String(x?.finalReason||'none')}`);

        const swapErrors = Object.entries(finalLaneRejectCounts).filter(([k]) => k.startsWith('attempt.swap') || k.startsWith('swap.')).reduce((a,[,v])=>a+Number(v||0),0);
        const attemptFailures = Object.entries(finalLaneRejectCounts).filter(([k]) => k.startsWith('attempt.')).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';

        return [
          `🧪 *Diag (execution)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`, 
          'HEADER',
          `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} lastAttemptAgeSec=${lastAttemptAgeSec} status=${warmingUp ? 'warming_up' : 'ready'}`,
          `circuit: circuitOpen=${circuitOpen ? 'true' : 'false'} circuitOpenReason=${circuitOpenReason} circuitOpenSince=${circuitOpenSinceMs ? fmtCt(circuitOpenSinceMs) : 'n/a'} circuitCooldownRemainingSec=${circuitOpenRemainingSec} failures(dex/rpc/jup)=${Number(circuitFailures?.dex || 0)}/${Number(circuitFailures?.rpc || 0)}/${Number(circuitFailures?.jup || 0)}`, 
          '',
          'ACTIVITY',
          `lastHour: confirmPassed=${hourConfirmPassedE} attemptReached=${hourAttemptReachedE} attemptPassed=${hourAttemptPassedE} fill=${hourFillE}`,
          `cumulative: confirmPassed=${cumConfirmPassedE} attemptReached=${cumAttemptReachedE} attemptPassed=${cumAttemptPassedE} fill=${cumFillE}`,
          `attemptSemantics: attemptReached=entered attempt stage pre-swap; attemptPassed=swap submission completed and fill recorded (currently equivalent to fill)`,
          '',
          'TOP BLOCKERS',
          ...(topFinalLaneBlockers.length ? topFinalLaneBlockers : ['- none']),
          '',
          'EXECUTION RULES',
          `- LIVE_ATTEMPT_MIN_LIQ_USD=${Number(cfg.LIVE_ATTEMPT_MIN_LIQ_USD ?? cfg.LIVE_CONFIRM_MIN_LIQ_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD)}`,
          `- MIN_LIQUIDITY_FLOOR_USD=${Number(cfg.MIN_LIQUIDITY_FLOOR_USD || 0)}`,
          `- slippage.maxAllowedBps=${Number(cfg.DEFAULT_SLIPPAGE_BPS || 0)}`,
          `- maxPriceImpactPct=${Number(cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT || 0)}`,
          `- reservePolicy=minSolForFees=${Number(cfg.MIN_SOL_FOR_FEES || 0)} softReserveSol=${Number(cfg.CAPITAL_SOFT_RESERVE_SOL || 0)} retryBufferPct=${Number(cfg.CAPITAL_RETRY_BUFFER_PCT || 0)}`,
          '',
          'RESERVE / CAPITAL',
          `- execution.reserveBlocked=${Number(counters?.watchlist?.executionReserveBlocked || 0)}`,
          `- execution.targetUsdTooSmall=${Number(counters?.watchlist?.executionTargetUsdTooSmall || 0)} trigger=(adjustedUsdTarget < 1.0)`,
          `- reserveRule=block when !applySoftReserveToUsdTarget.ok (policy=MIN_SOL_FOR_FEES + CAPITAL_SOFT_RESERVE_SOL + retryBufferPct*plannedSol); adjustedUsdTarget<1 -> execution.targetUsdTooSmall`,
          `- reserveLast=${(counters?.watchlist?.executionReserveLast || []).slice(-1).map(x => `mint=${String(x?.mint||'n/a').slice(0,6)} reserveRequired=${Number(x?.reserveRequired||0).toFixed(4)} reserveAvailable=${Number(x?.reserveAvailable||0).toFixed(4)} walletBalanceUsed=${Number(x?.walletBalanceUsed||0).toFixed(4)} reason=${String(x?.reason||'unknown')} ok=${x?.ok ? 'true' : 'false'}`).join(' | ') || 'none'}`,
          `- topReserveBlockReasons=${Object.entries(counters?.watchlist?.executionReserveBlockedReasons || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
          `- reserveBlockDebugLast10=${(counters?.watchlist?.executionReserveBlockedLast10 || []).slice(-10).map(x => `${String(x?.mint||'n/a').slice(0,6)} req=${Number(x?.reserveRequired||0).toFixed(4)} avail=${Number(x?.reserveAvailable||0).toFixed(4)} bal=${Number(x?.walletBalanceUsed||0).toFixed(4)} policy=${String(x?.thresholdPolicyFailed||'unknown')} final=${String(x?.finalReserveRejectReason||'execution.reserveBlocked')}`).join(' | ') || 'none'}`,
          `- reserveTraceLast5=${(counters?.watchlist?.executionReserveTraceLast5 || []).slice(-5).map(x => `${String(x?.mint||'n/a').slice(0,6)} reserveOk=${x?.reserveOk ? 'true' : 'false'} adjustedUsdTarget=${Number.isFinite(Number(x?.adjustedUsdTarget)) ? Number(x.adjustedUsdTarget).toFixed(6) : 'null'} branchTaken=${String(x?.branchTaken||'unknown')} finalReason=${String(x?.finalReason||'none')}`).join(' | ') || 'none'}`,
          `- targetUsdTooSmallLast10=${(counters?.watchlist?.targetUsdTooSmallLast10 || []).slice(-10).map(x => `${String(x?.mint||'n/a').slice(0,6)} initialUsdTarget=${Number.isFinite(Number(x?.initialUsdTarget)) ? Number(x.initialUsdTarget).toFixed(6) : 'null'} adjustedUsdTarget=${Number.isFinite(Number(x?.adjustedUsdTarget)) ? Number(x.adjustedUsdTarget).toFixed(6) : 'null'} plannedSol=${Number.isFinite(Number(x?.plannedSol)) ? Number(x.plannedSol).toFixed(9) : 'null'} reserveRequired=${Number.isFinite(Number(x?.reserveRequired)) ? Number(x.reserveRequired).toFixed(9) : 'null'} reserveAvailable=${Number.isFinite(Number(x?.reserveAvailable)) ? Number(x.reserveAvailable).toFixed(9) : 'null'} retryBufferApplied=${Number.isFinite(Number(x?.retryBufferAppliedSol)) ? Number(x.retryBufferAppliedSol).toFixed(9) : 'null'} retryBufferPct=${Number.isFinite(Number(x?.retryBufferPct)) ? Number(x.retryBufferPct).toFixed(6) : 'null'} final=${String(x?.finalReason||'execution.targetUsdTooSmall')}`).join(' | ') || 'none'}`,
          `- execution.nonTradableMintRejected=${Number(counters?.execution?.nonTradableMintRejected || 0)} execution.nonTradableMintCooldownActive=${Number(counters?.execution?.nonTradableMintCooldownActive || 0)} execution.nonTradableMintsTop=${Object.entries(counters?.execution?.nonTradableMintsTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none'}`,
          '',
          'ATTEMPT QUALITY',
          `- decimalsResolutionPolicy=decimalsHint -> pair.baseToken.decimals -> rpc.getTokenSupply.value.decimals`,
          `- swap.entryBlocked=${Number(counters?.guardrails?.entryBlocked || 0)} topReasons=${Object.entries(counters?.guardrails?.entryBlockedReasons || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
          `- swapEntryBlockedMissingDecimalsLast10=${(counters?.guardrails?.entryBlockedLast10 || []).filter(x => String(x?.reason||'') === 'missingDecimals').slice(-10).map(x => { const rpc=(Array.isArray(x?.decimalsSourcesTried)?x.decimalsSourcesTried.find(s=>String(s?.source||'')==='rpc.getTokenSupply.value.decimals'):null); return `${String(x?.mint||'n/a').slice(0,6)} candMint=${String(x?.mint||'n/a')} pairMint=${String(x?.pairBaseTokenAddress||'none')} rpcTarget=${String(x?.mintResolvedForDecimals||'none')} decimalsSource=${String(x?.decimalsSource||'none')} failedLookups=${String(x?.missingLookup||'none')} rpcSuccess=${rpc?.rpcSuccess === true ? 'true' : (rpc?.rpcSuccess === false ? 'false' : 'n/a')} rpcDecimals=${Number.isFinite(Number(rpc?.value)) ? Number(rpc.value) : 'null'} rpcErr=${String(rpc?.error || rpc?.parseReason || 'none')} final=${String(x?.finalMissingDecimalsReason||'swap.entryBlocked_missingDecimals')}`; }).join(' | ') || 'none'}`,
          ...(recentAttemptCandidates.length ? recentAttemptCandidates : ['- none']),
          '',
          'RECENT SUCCESS PATHS',
          ...(recentSuccessE.length ? recentSuccessE : ['- none']),
          '',
          'FILL OUTCOMES',
          `- fills=${cumFillE} swapErrors=${swapErrors}`,
          `- attemptFailuresByReason=${attemptFailures}`,
          `- attemptTransitionLast10=${attemptTransitionLast10.join(' | ') || 'none'}`,
          `- attemptBranchDebugLast10=${attemptBranchDebugLast10.join(' | ') || 'none'}`,
          `- quoteDegradeLast10=${(counters?.watchlist?.quoteDegradeLast10 || []).slice(-10).map(x => `${String(x?.mint||'n/a').slice(0,6)} quotedOut=${Number(x?.quotedOut||0)} finalOut=${Number(x?.finalOut||0)} minOut=${Number(x?.minOut||0)} slippageBps=${Number(x?.slippageBps||0)} priceImpactPct=${Number.isFinite(Number(x?.priceImpactPct)) ? Number(x.priceImpactPct).toFixed(4) : 'null'} quoteAgeMs=${Number(x?.quoteAgeMs||0)} routeSource=${String(x?.routeSource||'unknown')} routeChanged=${x?.routeChanged==null?'unknown':(x.routeChanged?'true':'false')} quoteRefreshed=${x?.quoteRefreshed?'true':'false'} finalReason=${String(x?.finalReason||'none')}`).join(' | ') || 'none'}`,
          `- executionPathLast10=${(counters?.watchlist?.executionPathLast10 || []).slice(-10).map(x => `${String(x?.mint||'n/a').slice(0,6)} attemptEntered=${x?.attemptEntered?'true':'false'} quoteBuilt=${x?.quoteBuilt?'true':'false'} quoteRefreshed=${x?.quoteRefreshed?'true':'false'} swapSubmissionEntered=${x?.swapSubmissionEntered?'true':'false'} outcome=${String(x?.outcome||'unknown')} finalReason=${String(x?.finalReason||'none')}`).join(' | ') || 'none'}`,
        ].join('\n');
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
          `pairFetchCallsPerScan=${pairFetchCallsPerScan != null ? pairFetchCallsPerScan.toFixed(2) : 'n/a'} birdeyeCallsPerScan=${birdeyeCallsPerScan != null ? birdeyeCallsPerScan.toFixed(2) : 'n/a'} rpcCallsPerScan=${rpcCallsPerScan != null ? rpcCallsPerScan.toFixed(2) : 'n/a'} maxSingleCallDurationMs=${maxSingleCallDurationMs != null ? Math.round(maxSingleCallDurationMs) : 'n/a'}`,
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
            continuationConfirmStartedAtMs: Number(withContinuation?.continuationConfirmStartedAtMs ?? withTx?.continuationConfirmStartedAtMs ?? ev?.continuationConfirmStartedAtMs ?? NaN),
            continuationWsUpdateCountWithinWindow: Number(withContinuation?.continuationWsUpdateCountWithinWindow ?? withTx?.continuationWsUpdateCountWithinWindow ?? ev?.continuationWsUpdateCountWithinWindow ?? 0),
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
          return `- ${mint.slice(0,6)} liq=${Math.round(Number(x?.liq||0))} mcap=${Math.round(Number(x?.mcap||0))} ageMin=${Number.isFinite(x?.ageMin) ? Number(x.ageMin).toFixed(1) : 'null'} freshnessMs=${Number.isFinite(Number(freshness)) ? Math.round(Number(freshness)) : 'null'} momentum=passed preConfirm=${preConfirm} confirm=${confirm} attempt=${attempt} fill=${fill} reason=${finalReason}`;
        });

        const recentSuccess = postFlowWin.filter(e => e.stage === 'fill' && e.outcome === 'passed').slice(-5).map((e) => `- ${String(e?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(e?.liq||0))} mcap=${Math.round(Number(e?.mcap||0))} ageMin=${Number.isFinite(e?.ageMin) ? Number(e.ageMin).toFixed(1) : 'null'} route=unknown attempt=passed fill=passed`);

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
        const confirmReachedRunup15 = confirmCandidatesDecorated.filter((r) => Number.isFinite(Number(r.continuationMaxRunupPct)) && Number(r.continuationMaxRunupPct) >= 0.015).length;
        const medianLocal = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
        const medianRunupPct = medianLocal(confirmCandidatesDecorated.map((r) => Number(r.continuationMaxRunupPct || NaN)).filter((v) => Number.isFinite(v)));
        const medianDipPct = medianLocal(confirmCandidatesDecorated.map((r) => Number(r.continuationMaxDipPct || NaN)).filter((v) => Number.isFinite(v)));
        const medianFinalPct = medianLocal(confirmCandidatesDecorated.map((r) => {
          const s = Number(r.continuationStartPrice || NaN);
          const f = Number(r.continuationFinalPrice || NaN);
          if (!(Number.isFinite(s) && Number.isFinite(f) && s > 0)) return NaN;
          return (f / s) - 1;
        }).filter((v) => Number.isFinite(v)));
        const medianTimeToRunupPassMs = medianLocal(confirmCandidatesDecorated.filter((r) => r.final === 'passed').map((r) => Number(r.continuationTimeToRunupPassMs || NaN)).filter((v) => Number.isFinite(v) && v >= 0));
        const recycledRequalifiedPassedCount = Number(state?.runtime?.confirmRetryRequalifiedPassed || 0);
        const top3ConfirmBlockers = Object.entries(confirmRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const top3AttemptBlockers = Object.entries(attemptRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ') || 'none';
        const topHandoffBlocker = Object.entries(attemptRejectCounts).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0]?.[0] || 'none';
        const strongestFailedConfirmCompact = confirmCandidatesDecorated
          .filter((r) => r.final === 'rejected')
          .sort((a, b) => Number(b.failedStrength || 0) - Number(a.failedStrength || 0))
          .slice(0, 3)
          .map((r) => {
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
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
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
            return `- ${label} liq=${Math.round(Number(r.liq || 0))} mcap=${Math.round(Number(r.mcap || 0))} passReason=${String(r.continuationPassReason || 'none')}`;
          });
        const wsTraceSampleRows = confirmCandidatesDecorated
          .filter((r) => Number(r?.continuationWsUpdateCountWithinWindow || 0) > 0 || String(r?.continuationPriceSource || '').includes('snapshot_fallback'))
          .slice(-3)
          .map((r) => {
            const frag = `${r.mint.slice(0,5)}...`;
            const label = (r.symbol === frag) ? frag : `${r.symbol} (${frag})`;
            const wsTs = Array.isArray(r?.continuationWsUpdateTimestamps) ? r.continuationWsUpdateTimestamps.slice(0, 10).map((x)=>fmtCt(Number(x))).join(', ') : 'none';
            const wsPx = Array.isArray(r?.continuationWsUpdatePrices) ? r.continuationWsUpdatePrices.slice(0, 10).map((x)=>Number(x).toFixed(10)).join(', ') : 'none';
            const trTs = Array.isArray(r?.continuationTradeUpdateTimestamps) ? r.continuationTradeUpdateTimestamps.slice(0, 10).map((x)=>fmtCt(Number(x))).join(', ') : 'none';
            const trPx = Array.isArray(r?.continuationTradeUpdatePrices) ? r.continuationTradeUpdatePrices.slice(0, 10).map((x)=>Number(x).toFixed(10)).join(', ') : 'none';
            return `- ${label} startedAt=${Number.isFinite(Number(r?.continuationConfirmStartedAtMs)) ? fmtCt(Number(r.continuationConfirmStartedAtMs)) : 'n/a'} startPx=${Number.isFinite(Number(r?.continuationStartPrice)) ? Number(r.continuationStartPrice).toFixed(10) : 'n/a'} source=${String(r?.continuationPriceSource || 'unknown')} wsUpdates=${Number(r?.continuationWsUpdateCountWithinWindow || 0)} selectedTrade=${Number(r?.continuationSelectedTradeReads || 0)} selectedOhlcv=${Number(r?.continuationSelectedOhlcvReads || 0)} wsTs=[${wsTs}] wsPx=[${wsPx}] tradeTs=[${trTs}] tradePx=[${trPx}] final=${r.final} reason=${String(r?.rejectReason || r?.continuationPassReason || 'none')}`;
          });
        const continuationFailMix = { hardDip: 0, windowExpiredStall: 0, windowExpiredWeak: 0, liqDegraded: 0, impact: 0, route: 0, retryCooldown: 0, retryNoImprovement: 0, other: 0 };
        for (const [k, v] of Object.entries(confirmRejectCounts)) {
          const n = Number(v || 0);
          if (k.includes('confirmContinuation.hardDip')) continuationFailMix.hardDip += n;
          else if (k.includes('confirmContinuation.windowExpiredStall')) continuationFailMix.windowExpiredStall += n;
          else if (k.includes('confirmContinuation.windowExpired') || k.includes('confirmContinuation.windowClose')) continuationFailMix.windowExpiredWeak += n;
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
          `- fail: hardDip=${continuationFailMix.hardDip} windowExpiredStall=${continuationFailMix.windowExpiredStall} windowExpiredWeak=${continuationFailMix.windowExpiredWeak} liqDegraded=${continuationFailMix.liqDegraded} route=${continuationFailMix.route} impact=${continuationFailMix.impact} retryCooldown=${continuationFailMix.retryCooldown} retryNoImprovement=${continuationFailMix.retryNoImprovement} other=${continuationFailMix.other}`,
          `- reached+1.5%InWindow=${confirmReachedRunup15}`,
          `- medianTimeToRunupMs=${Number.isFinite(medianTimeToRunupPassMs) ? Math.round(Number(medianTimeToRunupPassMs)) : 'n/a'}`,
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
      const executionAllowed = cfg.EXECUTION_ENABLED && state.tradingEnabled && !playbookBlocks && circuitOk && !lowSolPaused && capOk;
      const executionAllowedReason = !cfg.EXECUTION_ENABLED ? 'cfgExecutionOff'
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
      const scanBirdeyeReqStart = Number(state?.marketData?.providers?.birdeye?.requests || 0);
      let scanCandidatesFound = 0;
      let scanPairFetchCalls = 0;
      let scanBirdeyeCalls = 0;
      let scanRpcCalls = 0;
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
          birdeyeCalls: Number(scanBirdeyeCalls || 0),
          rpcCalls: Number(scanRpcCalls || 0),
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
                    const q = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                    scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
                    const pi = Number(q?.priceImpactPct || 0);
                    const routeable = !!q?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
                    const _tCacheWrite = Date.now();
                    quoteCache[mint] = { atMs: Date.now(), routeable };
                    scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tCacheWrite);
                    resolved.push({ pick, routeable });
                  } catch (e) {
                    scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
                    if (isJup429(e)) hitRateLimit = true;
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
          const noPairTemporary = ensureNoPairTemporaryState(state);
          const noPairDeadMints = ensureNoPairDeadMintState(state);
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
              bumpRouteCounter(counters, 'noPairTempSkips');
              pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair_temporary(active:${Math.round((tempNoPair.untilMs - t) / 1000)}s)` });
              continue;
            }
            if (tempNoPair && Number(tempNoPair.untilMs || 0) > t) {
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
              } else {
              const jupRemain = jupCooldownRemainingMs(state, t);
              if (jupRemain > 0) {
                jupHit429 = true;
                bumpRouteCounter(counters, 'prefilterRateLimited');
                pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `jupPrefilter(COOLDOWN:${Math.round(jupRemain / 1000)}s)` });
                break;
              }

              try {
                const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                const q = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                const r0 = q;
                const pi = Number(r0?.priceImpactPct || 0);
                routeAvailable = !!r0?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
                if (routeAvailable) {
                  cacheRouteReadyMint({ state, cfg, mint, quote: r0, nowMs: t, source: 'route-first-prefilter' });
                }
                if (!routeAvailable) {
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
                routeErrorKind = parseJupQuoteFailure(e);
                if (isJup429(e) || routeErrorKind === 'rateLimited') {
                  jupHit429 = true;
                  hitRateLimit = true;
                  bumpRouteCounter(counters, 'prefilterRateLimited');
                  pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: 'jupPrefilter(JUPITER_429)' });
                  circuitHit({ state, nowMs: t, dep: 'jup', note: 'prefilter(JUPITER_429)', persist: () => saveState(cfg.STATE_PATH, state) });
                  hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'jupPrefilter(429)', persist: () => saveState(cfg.STATE_PATH, state) });
                  break;
                }
                const reason = (routeErrorKind === 'nonTradableMint') ? 'nonTradableMint' : (routeErrorKind || 'providerEmpty');
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
                  if (recovered) bumpRouteCounter(counters, 'rejectRecheckRecovered');
                  else bumpRouteCounter(counters, 'rejectRecheckMisses');
                }
                if (!recovered) {
                  bumpRouteCounter(counters, 'prefilterRejected');
                  bumpNoPairReason(counters, reason, candidateSource);
                  setNoPairTemporary(noPairTemporary, mint, { reason, nowMs: t, attempts: prevAttempts + 1 });
                  if (reason === 'nonTradableMint') {
                    recordNonTradableMint(counters, mint, 'rejected');
                    const strikes = Number(noPairDeadMints[mint]?.strikes || 0) + 1;
                    if (strikes >= NO_PAIR_DEAD_MINT_STRIKES) {
                      noPairDeadMints[mint] = { untilMs: t + NO_PAIR_DEAD_MINT_TTL_MS, atMs: t, strikes, reason: 'nonTradableMint' };
                    } else {
                      noPairDeadMints[mint] = { untilMs: t + NO_PAIR_NON_TRADABLE_TTL_MS, atMs: t, strikes, reason: 'nonTradableMint' };
                    }
                  }
                  continue;
                }
              }
              }
            }

            if (!routeFirstEnabled && JUP_SOURCE_PREFLIGHT_ENABLED && tok?._source === 'jup') {
              const cachedRoute = getFreshRouteCacheEntry({ state, cfg, mint, nowMs: t });
              if (cachedRoute) {
                routeAvailable = true;
              } else {
                try {
                const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                const route = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                const pi = Number(route?.priceImpactPct || 0);
                routeAvailable = !!route?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
                if (routeAvailable) {
                  cacheRouteReadyMint({ state, cfg, mint, quote: route, nowMs: t, source: 'jup-source-preflight' });
                }
                if (!routeAvailable) {
                  bumpNoPairReason(counters, 'routeNotFound', candidateSource);
                  setNoPairTemporary(noPairTemporary, mint, { reason: 'routeNotFound', nowMs: t, attempts: prevAttempts + 1 });
                  continue;
                }
              } catch (e) {
                routeErrorKind = parseJupQuoteFailure(e);
                if (routeErrorKind === 'rateLimited') {
                  hitRateLimit = true;
                  jupHit429 = true;
                  pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: 'jupPreflight(JUPITER_429)' });
                  circuitHit({ state, nowMs: t, dep: 'jup', note: 'preflight(JUPITER_429)', persist: () => saveState(cfg.STATE_PATH, state) });
                  hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'jupPreflight(429)', persist: () => saveState(cfg.STATE_PATH, state) });
                  break;
                }
                const reason = (routeErrorKind === 'nonTradableMint') ? 'nonTradableMint' : (routeErrorKind || 'providerEmpty');
                bumpNoPairReason(counters, reason, candidateSource);
                setNoPairTemporary(noPairTemporary, mint, { reason, nowMs: t, attempts: prevAttempts + 1 });
                if (reason === 'nonTradableMint') {
                  recordNonTradableMint(counters, mint, 'rejected');
                  const strikes = Number(noPairDeadMints[mint]?.strikes || 0) + 1;
                  if (strikes >= NO_PAIR_DEAD_MINT_STRIKES) {
                    noPairDeadMints[mint] = { untilMs: t + NO_PAIR_DEAD_MINT_TTL_MS, atMs: t, strikes, reason };
                  } else {
                    noPairDeadMints[mint] = { untilMs: t + NO_PAIR_NON_TRADABLE_TTL_MS, atMs: t, strikes, reason };
                  }
                }
                continue;
              }
              }
            }

            scanPhase.candidateRouteabilityChecksMs += Math.max(0, Date.now() - _tRouteability);
            scanPhase.candidateOtherMs += Math.max(0, Date.now() - _tRouteLoopStart);
            if (routeAvailable === true) pushScanCompactEvent('candidateRouteable', { mint, source: candidateSource });
            pairFetchQueue.push({ tok, mint, candidateSource, routeAvailable, routeErrorKind, hitRateLimit, prevAttempts });
          }
          scanPhase.routePrepMs += Math.max(0, Date.now() - _tRoutePrep);

          if (jupHit429) {
            // Jupiter is rate-limiting; skip ranking/execution this cycle.
            continue;
          }

          if (dexHit429) {
            // DexScreener is rate-limiting; skip ranking/execution this cycle.
            continue;
          }

          const pairFetchConcurrency = Math.max(1, Math.min(8, Number(cfg.PAIR_FETCH_CONCURRENCY || 1)));
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

            if (!snapshot?.priceUsd || !pair) {
              counters.pairFetch.failed += 1;
              if (routeAvailable == null) {
                try {
                  const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
                  const route = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                  routeAvailable = !!route?.routePlan?.length;
                  if (routeAvailable) {
                    cacheRouteReadyMint({ state, cfg, mint, quote: route, nowMs: t, source: 'pairfetch-fallback' });
                  }
                } catch (e) {
                  routeErrorKind = parseJupQuoteFailure(e);
                  if (routeErrorKind === 'rateLimited') hitRateLimit = true;
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
                const q = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: c.mint, amount: lam, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
                const pi = Number(q?.priceImpactPct || 0);
                const routeable = !!q?.routePlan?.length && (!pi || pi <= cfg.MAX_PRICE_IMPACT_PCT);
                return { mint: c.mint, routeable };
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
          const executionAllowed = cfg.EXECUTION_ENABLED && state.tradingEnabled && !playbookBlocks && circuitOk && !lowSolPaused && capOk;
          const executionAllowedReason = !cfg.EXECUTION_ENABLED ? 'cfgExecutionOff'
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
                    const fallbackQuote = await jupQuote({
                      inputMint: cfg.SOL_MINT,
                      outputMint: mint,
                      amount: probeLamports,
                      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                    });
                    const piFallback = Number(fallbackQuote?.priceImpactPct || 0);
                    const routeableFallback = !!fallbackQuote?.routePlan?.length && (!piFallback || piFallback <= cfg.MAX_PRICE_IMPACT_PCT);
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
      const paperOn = Number(state.paper?.enabledUntilMs || 0) > nowMs;
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
