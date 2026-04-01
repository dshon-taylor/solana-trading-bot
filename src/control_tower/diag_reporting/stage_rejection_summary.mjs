export async function runRejectionSummary({
  t,
  cfg,
  state,
  counters,
  lastRej,
  snapshotAndReset,
  tgSend,
}) {
  const rejEnabled = state.debug?.rejections ?? cfg.DEBUG_REJECTIONS;
  const rejEveryMs = state.debug?.rejectionsEveryMs ?? cfg.DEBUG_REJECTIONS_EVERY_MS;
  if (!rejEnabled || (t - lastRej) < rejEveryMs) {
    return { lastRej, counters };
  }

  const nextLastRej = t;
  const { snap, next } = snapshotAndReset(counters);
  const nextCounters = next;
  state.runtime.diagCounters = nextCounters;

  const msg = [
    `DEBUG 📊 scanner summary (last ${(rejEveryMs / 60000).toFixed(0)}m)`,
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

  return { lastRej: nextLastRej, counters: nextCounters };
}
