import { promoteRouteAvailableCandidateToImmediate } from '../../route_available_watchlist.mjs';
import { resolvePairCreatedAtGlobal } from '../watchlist_control.mjs';

function bumpRouteAvailableDropped(counters, reason) {
  counters.route.routeAvailableDropped ||= {};
  const key = String(reason || 'unknown');
  counters.route.routeAvailableDropped[key] = Number(counters.route.routeAvailableDropped[key] || 0) + 1;
}

export async function promoteRouteAvailableCandidate({
  state,
  cfg,
  counters,
  nowMs,
  tok,
  mint,
  immediateRows,
  immediateRowMints,
  birdseye = null,
  deps,
}) {
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

  await deps.upsertWatchlistMint({ state, cfg, nowMs, tok, mint, pair: syntheticPair, snapshot: syntheticSnapshot, counters, routeHint: true, birdseye });
  const row = state.watchlist?.mints?.[mint] || null;
  if (!row) {
    bumpRouteAvailableDropped(counters, 'watchlistUpsertFailed');
    return false;
  }

  const promotion = promoteRouteAvailableCandidateToImmediate({ mint, row, nowMs, dedupMs: cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS, immediateRows, immediateRowMints });
  if (!promotion.promoted) {
    bumpRouteAvailableDropped(counters, promotion.reason);
    return false;
  }

  counters.watchlist.immediateRoutePromoted += 1;
  counters.route.routeAvailablePromotedToWatchlist = Number(counters.route.routeAvailablePromotedToWatchlist || 0) + 1;
  return true;
}
