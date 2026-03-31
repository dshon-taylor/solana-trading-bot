import { ensureWatchlistState } from './stage_watchlist_state_cache.mjs';

export function formatWatchlistSummary({ state, counters, nowMs = Date.now() }) {
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

export function bumpImmediateBlockedReason(counters, blockedReason) {
  counters.watchlist.immediateBlockedByReason ||= {};
  const key = String(blockedReason || 'unknown');
  counters.watchlist.immediateBlockedByReason[key] = Number(counters.watchlist.immediateBlockedByReason[key] || 0) + 1;
}
