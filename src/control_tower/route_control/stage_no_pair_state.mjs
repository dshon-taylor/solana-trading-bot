import { bump, bumpSourceCounter } from '../../core/metrics.mjs';
import {
  NO_PAIR_RETRY_BASE_MS,
  NO_PAIR_RETRY_MAX_BACKOFF_MS,
  NO_PAIR_TEMP_TTL_MS,
  NO_PAIR_TEMP_TTL_ROUTEABLE_MS,
  NO_PAIR_NON_TRADABLE_TTL_MS,
  NO_PAIR_DEAD_MINT_TTL_MS,
  NO_PAIR_REVISIT_MIN_MS,
  NO_PAIR_REVISIT_MAX_MS,
} from './stage_constants.mjs';
import { jitter } from './stage_concurrency_utils.mjs';

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
