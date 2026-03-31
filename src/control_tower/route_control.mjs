import { toBaseUnits, DECIMALS } from '../trader.mjs';
import { jupQuote } from '../jupiter.mjs';
import { getTokenPairs, pickBestPair } from '../dexscreener.mjs';
import { getRaydiumPools, pickBestRaydiumPool } from '../raydium.mjs';
import { isDexScreener429 } from '../dex_cooldown.mjs';
import { isJup429 } from '../jup_cooldown.mjs';
import { bump, bumpSourceCounter } from '../metrics.mjs';

const AGGRESSIVE_BOOT_MODE = (process.env.AGGRESSIVE_MODE ?? 'false') === 'true';
const NO_PAIR_RETRY_ATTEMPTS = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS || 5));
export const NO_PAIR_RETRY_BASE_MS = Math.max(50, Number(process.env.NO_PAIR_RETRY_BASE_MS || (AGGRESSIVE_BOOT_MODE ? 90 : 300)));
export const NO_PAIR_RETRY_MAX_BACKOFF_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_MAX_BACKOFF_MS || (AGGRESSIVE_BOOT_MODE ? 900 : 4_000)));
export const NO_PAIR_RETRY_TOTAL_BUDGET_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_TOTAL_BUDGET_MS || (AGGRESSIVE_BOOT_MODE ? 1_500 : 6_000)));
const NO_PAIR_RETRY_ATTEMPTS_CAP = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS_CAP || 10));
const NO_PAIR_TEMP_TTL_MS = Math.max(5_000, Number(process.env.NO_PAIR_TEMP_TTL_MS || (AGGRESSIVE_BOOT_MODE ? 40_000 : 120_000)));
const NO_PAIR_TEMP_TTL_ROUTEABLE_MS = Math.max(10_000, Number(process.env.NO_PAIR_TEMP_TTL_ROUTEABLE_MS || (AGGRESSIVE_BOOT_MODE ? 18_000 : 45_000)));
export const NO_PAIR_NON_TRADABLE_TTL_MS = Math.max(NO_PAIR_TEMP_TTL_MS, Number(process.env.NO_PAIR_NON_TRADABLE_TTL_MS || 20 * 60_000));
export const NO_PAIR_DEAD_MINT_TTL_MS = Math.max(NO_PAIR_NON_TRADABLE_TTL_MS, Number(process.env.NO_PAIR_DEAD_MINT_TTL_MS || 90 * 60_000));
const NO_PAIR_REVISIT_MIN_MS = Math.max(150, Number(process.env.NO_PAIR_REVISIT_MIN_MS || (AGGRESSIVE_BOOT_MODE ? 450 : 1_500)));
const NO_PAIR_REVISIT_MAX_MS = Math.max(NO_PAIR_REVISIT_MIN_MS, Number(process.env.NO_PAIR_REVISIT_MAX_MS || (AGGRESSIVE_BOOT_MODE ? 120_000 : 6 * 60_000)));
export const NO_PAIR_DEAD_MINT_STRIKES = Math.max(2, Number(process.env.NO_PAIR_DEAD_MINT_STRIKES || 3));
export const JUP_ROUTE_FIRST_ENABLED = (process.env.JUP_ROUTE_FIRST_ENABLED ?? 'true') === 'true';
export const JUP_SOURCE_PREFLIGHT_ENABLED = (process.env.JUP_SOURCE_PREFLIGHT_ENABLED ?? 'true') === 'true';

export function effectiveNoPairRetryAttempts() {
  return Math.max(1, Math.min(NO_PAIR_RETRY_ATTEMPTS, NO_PAIR_RETRY_ATTEMPTS_CAP));
}

export async function mapWithConcurrency(items, concurrency, worker) {
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

export function jitter(ms, pct = 0.25) {
  const delta = ms * pct;
  return Math.max(0, Math.round(ms + ((Math.random() * 2 - 1) * delta)));
}

export async function quickRouteRecheck({ cfg, mint, solUsdNow, slippageBps, attempts, delayMs, passes = 1, passDelayMs = 80 }) {
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
        const route = await getRouteQuoteWithFallback({
          cfg,
          mint,
          amountLamports: lam,
          slippageBps,
          solUsdNow,
          source: 'quick-recheck',
        });
        if (route.routeAvailable) return { recovered: true, attempts: totalAttempts, pass: pass + 1 };
        if (route.rateLimited) return { recovered: false, attempts: totalAttempts, pass: pass + 1, rateLimited: true };
      } catch {}
    }
  }
  return { recovered: false, attempts: totalAttempts, pass: maxPasses };
}

export function ensureNoPairTemporaryState(state) {
  state.marketData ||= {};
  state.marketData.noPairTemporary ||= {};
  return state.marketData.noPairTemporary;
}

export function ensureNoPairDeadMintState(state) {
  state.marketData ||= {};
  state.marketData.noPairDeadMints ||= {};
  return state.marketData.noPairDeadMints;
}

export function normalizeCandidateSource(source) {
  const s = String(source || '').trim().toLowerCase();
  return s || 'unknown';
}

export function bumpNoPairReason(counters, reason = 'providerEmpty', source = 'unknown') {
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

export function bumpRouteCounter(counters, key) {
  counters.route ||= {};
  counters.route[key] = Number(counters.route[key] || 0) + 1;
}

export function recordNonTradableMint(counters, mint, kind = 'rejected') {
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

export function getBoostUsd(tok) {
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

export function shouldApplyEarlyShortlistPrefilter({ cfg, tok }) {
  if (!cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE) return false;
  const source = normalizeCandidateSource(tok?._source || 'unknown');
  if (source === 'dex') return true;
  return false;
}

function computeNoPairRevisitMs(reason, attempts = 1) {
  const r = String(reason || 'providerEmpty');
  const factor = Math.max(0, Number(attempts || 1) - 1);
  const base = Math.min(NO_PAIR_RETRY_MAX_BACKOFF_MS, NO_PAIR_RETRY_BASE_MS * (2 ** factor));
  const transient = r === 'providerEmpty' || r === 'staleData' || r === 'retriesExhausted';
  const weighted = (r === 'routeAvailable')
    ? Math.round(base * 0.7)
    : (transient ? Math.round(base * 0.5) : base);
  return Math.max(NO_PAIR_REVISIT_MIN_MS, Math.min(NO_PAIR_REVISIT_MAX_MS, jitter(weighted, transient ? 0.25 : 0.35)));
}

function computeNoPairTtlMs(reason, attempts = 1) {
  const r = String(reason || 'providerEmpty');
  if (r === 'nonTradableMint') return NO_PAIR_NON_TRADABLE_TTL_MS;
  if (r === 'deadMint') return NO_PAIR_DEAD_MINT_TTL_MS;
  if (r === 'routeAvailable') return NO_PAIR_TEMP_TTL_ROUTEABLE_MS;
  if (r === 'providerCooldown' || r === 'rateLimited') {
    const tier = Math.min(3, Math.max(0, Number(attempts || 1) - 1));
    const base = Math.max(25_000, Math.min(NO_PAIR_TEMP_TTL_MS, 45_000));
    return base + (tier * 15_000);
  }
  if (r === 'providerEmpty' || r === 'staleData' || r === 'retriesExhausted') {
    const tier = Math.min(3, Math.max(0, Number(attempts || 1) - 1));
    const base = Math.max(20_000, Math.min(NO_PAIR_TEMP_TTL_MS, 35_000));
    return base + (tier * 10_000);
  }
  const tier = Math.min(4, Math.max(0, Number(attempts || 1) - 1));
  return NO_PAIR_TEMP_TTL_MS + (tier * 20_000);
}

export function setNoPairTemporary(noPairTemporary, mint, { reason, nowMs, attempts = 1 }) {
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

export function shouldSkipNoPairTemporary(temp, nowMs) {
  if (!temp) return false;
  const untilMs = Number(temp.untilMs || 0);
  if (untilMs <= nowMs) return false;
  const nextRetryAtMs = Number(temp.nextRetryAtMs || temp.untilMs || 0);
  return nextRetryAtMs > nowMs;
}

export function ensureForceAttemptPolicyState(state) {
  state.guardrails ||= {};
  state.guardrails.forceAttempt ||= {
    globalAttemptTimestampsMs: [],
    perMintAttemptTimestampsMs: {},
  };
  state.guardrails.forceAttempt.globalAttemptTimestampsMs ||= [];
  state.guardrails.forceAttempt.perMintAttemptTimestampsMs ||= {};
  return state.guardrails.forceAttempt;
}

export function pruneForceAttemptPolicyWindows(policyState, nowMs) {
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

export function evaluateForceAttemptPolicyGuards({ cfg, policyState, row, mint, nowMs }) {
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

export function recordForceAttemptPolicyAttempt({ policyState, mint, nowMs }) {
  policyState.globalAttemptTimestampsMs ||= [];
  policyState.perMintAttemptTimestampsMs ||= {};
  policyState.globalAttemptTimestampsMs.push(nowMs);
  policyState.perMintAttemptTimestampsMs[mint] ||= [];
  policyState.perMintAttemptTimestampsMs[mint].push(nowMs);
}

export function parseJupQuoteFailure(err) {
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

function isRouteQuoteable({ quote, maxPriceImpactPct }) {
  if (!quote?.routePlan?.length) return false;
  const pi = Number(quote?.priceImpactPct || 0);
  return (!pi || pi <= Number(maxPriceImpactPct || 0));
}

function isSolLikeQuoteToken(token) {
  const symbol = String(token?.symbol || '').toUpperCase();
  const addr = String(token?.address || '');
  return symbol === 'SOL' || symbol === 'WSOL' || addr === 'So11111111111111111111111111111111111111112';
}

function isUsdcLikeQuoteToken(token) {
  const symbol = String(token?.symbol || '').toUpperCase();
  const addr = String(token?.address || '');
  return symbol === 'USDC' || addr === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
}

function buildAlternativeRouteQuote({ mint, amountLamports, slippageBps, pair, estimatedPriceImpactPct }) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: mint,
    inAmount: String(Math.max(0, Math.floor(Number(amountLamports || 0)))),
    outAmount: null,
    slippageBps: Number(slippageBps || 0),
    priceImpactPct: Number(estimatedPriceImpactPct || 0),
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: `DexScreenerAlt:${String(pair?.dexId || 'unknown')}`,
          ammKey: String(pair?.pairAddress || ''),
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: mint,
        },
      },
    ],
    synthetic: true,
    provider: 'dexscreener-alt',
  };
}

function isRaydiumPoolSupported(pool, targetMint) {
  if (!pool) return false;
  const mintA = pool.mintA;
  const mintB = pool.mintB;
  const aIsTarget = mintA?.address === targetMint;
  const bIsTarget = mintB?.address === targetMint;
  if (aIsTarget) return isSolLikeQuoteToken(mintB) || isUsdcLikeQuoteToken(mintB);
  if (bIsTarget) return isSolLikeQuoteToken(mintA) || isUsdcLikeQuoteToken(mintA);
  return false;
}

function buildRaydiumRouteQuote({ mint, amountLamports, slippageBps, pool, estimatedPriceImpactPct }) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: mint,
    inAmount: String(Math.max(0, Math.floor(Number(amountLamports || 0)))),
    outAmount: null,
    slippageBps: Number(slippageBps || 0),
    priceImpactPct: Number(estimatedPriceImpactPct || 0),
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: `RaydiumAlt:${String(pool?.type || 'Standard')}`,
          ammKey: String(pool?.id || ''),
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: mint,
        },
      },
    ],
    synthetic: true,
    provider: 'raydium-alt',
  };
}

export async function getRouteQuoteWithFallback({ cfg, mint, amountLamports, slippageBps, solUsdNow, source = 'unknown' }) {
  let jupErrorKind = null;
  let rateLimited = false;
  try {
    const quote = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: amountLamports, slippageBps });
    return {
      routeAvailable: isRouteQuoteable({ quote, maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT }),
      quote,
      provider: 'jupiter',
      rateLimited: false,
      routeErrorKind: null,
    };
  } catch (e) {
    jupErrorKind = parseJupQuoteFailure(e);
    rateLimited = jupErrorKind === 'rateLimited' || isJup429(e);
    if (!cfg.ROUTE_ALT_ENABLED) {
      return {
        routeAvailable: false,
        quote: null,
        provider: 'jupiter',
        rateLimited,
        routeErrorKind: jupErrorKind,
      };
    }
  }

  const notionalUsd = (Number(amountLamports || 0) / 1e9) * Math.max(0, Number(solUsdNow || 0));
  const minLiq = Number(cfg.ROUTE_ALT_MIN_LIQ_USD || 0);
  const maxImpact = Number(cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT || 4);

  const dexTask = (async () => {
    const pairs = await getTokenPairs('solana', mint);
    const best = pickBestPair(pairs);
    const liqUsd = Number(best?.liquidity?.usd || 0);
    const quoteToken = best?.quoteToken || null;
    const quoteTokenSupported = isSolLikeQuoteToken(quoteToken) || isUsdcLikeQuoteToken(quoteToken);
    const impactPct = liqUsd > 0 && notionalUsd > 0
      ? Math.max(0, Math.min(99, (notionalUsd / Math.max(1, liqUsd)) * 130))
      : maxImpact;
    if (!best || !quoteTokenSupported || liqUsd < minLiq || impactPct > maxImpact) return null;
    return {
      routeAvailable: true,
      quote: buildAlternativeRouteQuote({ mint, amountLamports, slippageBps, pair: best, estimatedPriceImpactPct: impactPct }),
      provider: 'dexscreener-alt',
      rateLimited,
      routeErrorKind: jupErrorKind,
      meta: { source, liquidityUsd: liqUsd, impactPct },
    };
  })();

  const raydiumTask = cfg.ROUTE_ALT_RAYDIUM_ENABLED
    ? (async () => {
        const pools = await getRaydiumPools(mint);
        const best = pickBestRaydiumPool(pools);
        const tvl = Number(best?.tvl || 0);
        const impactPct = tvl > 0 && notionalUsd > 0
          ? Math.max(0, Math.min(99, (notionalUsd / Math.max(1, tvl)) * 130))
          : maxImpact;
        if (!best || !isRaydiumPoolSupported(best, mint) || tvl < minLiq || impactPct > maxImpact) return null;
        return {
          routeAvailable: true,
          quote: buildRaydiumRouteQuote({ mint, amountLamports, slippageBps, pool: best, estimatedPriceImpactPct: impactPct }),
          provider: 'raydium-alt',
          rateLimited,
          routeErrorKind: jupErrorKind,
          meta: { source, liquidityUsd: tvl, impactPct },
        };
      })()
    : Promise.resolve(null);

  const [dexSettled, raydiumSettled] = await Promise.allSettled([dexTask, raydiumTask]);

  const raydiumResult = raydiumSettled.status === 'fulfilled' ? raydiumSettled.value : null;
  const dexResult = dexSettled.status === 'fulfilled' ? dexSettled.value : null;
  const winner = raydiumResult || dexResult;

  if (winner) return winner;

  const anyRateLimited =
    (dexSettled.status === 'rejected' && isDexScreener429(dexSettled.reason)) ||
    (raydiumSettled.status === 'rejected' && raydiumSettled.reason?.status === 429);
  return {
    routeAvailable: false,
    quote: null,
    provider: 'alt',
    rateLimited: rateLimited || anyRateLimited,
    routeErrorKind: jupErrorKind || (anyRateLimited ? 'rateLimited' : 'routeNotFound'),
  };
}

export function classifyNoPairReason({ state, mint, nowMs, maxAgeMs, routeAvailable, routeErrorKind, hitRateLimit }) {
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

export function isPaperModeActive({ state, cfg, nowMs = Date.now() }) {
  if (cfg.PAPER_ENABLED === true) return true;
  return Number(state?.paper?.enabledUntilMs || 0) > Number(nowMs || 0);
}

function minHoldersRequired({ cfg, poolAgeSec }) {
  const age = Number(poolAgeSec);
  if (Number.isFinite(age) && age <= Number(cfg.HOLDER_TIER_NEW_MAX_AGE_SEC || 1800)) {
    return Number(cfg.HOLDER_TIER_MIN_NEW || 400);
  }
  return Number(cfg.HOLDER_TIER_MIN_MATURE || 900);
}

export function holdersGateCheck({ cfg, holders, poolAgeSec }) {
  const h = Number(holders);
  const req = minHoldersRequired({ cfg, poolAgeSec });
  if (!Number.isFinite(h) || h <= 0) {
    if (cfg.HOLDER_MISSING_SOFT_ALLOW) return { ok: true, soft: true, reason: 'holdersMissing_soft', required: req };
    return { ok: false, reason: 'holdersMissing', required: req };
  }
  if (h < req) return { ok: false, reason: `holdersTooLow(${Math.round(h)}<${Math.round(req)})`, required: req };
  return { ok: true, required: req };
}
