const NO_PAIR_REASON_KEYS = [
  'providerEmpty',
  'providerCooldown',
  'rateLimited',
  'routeNotFound',
  'nonTradableMint',
  'deadMint',
  'routeableNoMarketData',
  'staleData',
  'retriesExhausted',
];

const WATCHLIST_BLOCK_REASON_KEYS = [
  'cooldown',
  'maxPositions',
  'alreadyOpen',
  'missingPairOrSnapshot',
  'unsafeSnapshot',
  'momentumFailed',
  'baseFiltersFailed',
  'rugUnsafe',
  'rugcheckFetch',
  'mcapFetch',
  'mcapLowOrMissing',
  'liqRatioFailed',
  'executionDisabled',
  'throttleBlocked',
  'reserveBlocked',
  'quoteFailed',
  'confirmPriceImpact',
  'confirmNoRoute',
  'forceGuardMintCooldown',
  'forceGuardMintHourlyCap',
  'forceGuardGlobalMinuteCap',
  'swapError',
  'forcePolicyMintCooldown',
  'forcePolicyMintHourlyCap',
  'forcePolicyGlobalRateCap',
];

function makeNoPairReasons() {
  return NO_PAIR_REASON_KEYS.reduce((acc, k) => {
    acc[k] = 0;
    return acc;
  }, {});
}

function makeWatchlistBlockedReasons() {
  return WATCHLIST_BLOCK_REASON_KEYS.reduce((acc, k) => {
    acc[k] = 0;
    return acc;
  }, {});
}

function makeWatchlistFunnelCounts() {
  return {
    watchlistSeen: 0,
    watchlistEvaluated: 0,
    momentumPassed: 0,
    confirmPassed: 0,
    attempted: 0,
    filled: 0,
    blockedByReason: makeWatchlistBlockedReasons(),
  };
}

export function makeCounters() {
  return {
    scanned: 0,
    scanCycles: 0,
    consideredPairs: 0,
    entryAttempts: 0,
    entrySuccesses: 0,
    reject: {
      noPair: 0,
      noPairReasons: makeNoPairReasons(),
      baseFilters: 0,
      rugcheckFetch: 0,
      rugUnsafe: 0,
      mcapFetch: 0,
      mcapLowOrMissing: 0,
      momentum: 0,
      noSocialMeta: 0,
      alreadyOpen: 0,
      lowSolFees: 0,
      capitalThrottle: 0,
      capitalReserve: 0,
      swapError: 0,
    },
    route: {
      shortlistPrefilterDropped: 0,
      shortlistPrefilterPassed: 0,
      prefilterChecks: 0,
      prefilterRouteable: 0,
      prefilterRejected: 0,
      prefilterRateLimited: 0,
      noPairTempSkips: 0,
      noPairTempRevisits: 0,
      deadMintSkips: 0,
      routeableByJupiter: 0,
      rejectRecheckRecovered: 0,
      rejectRecheckMisses: 0,
      quoteFanoutChecked: 0,
      quoteFanoutRouteable: 0,
      routeAvailableSeen: 0,
      routeAvailablePromotedToWatchlist: 0,
      routeAvailableDropped: {},
    },
    pairFetch: {
      queued: 0,
      started: 0,
      completed: 0,
      success: 0,
      failed: 0,
      rateLimited: 0,
      attempts: 0,
      latencyMsTotal: 0,
      latencySamples: 0,
      queueDepthPeak: 0,
    },
    funnel: {
      signals: 0,
      signalFallbackPass: 0,
      probeShortlist: 0,
      confirmPassed: 0,
      attempts: 0,
      fills: 0,
      attemptsFromStandard: 0,
      attemptsFromFallback: 0,
      entriesFromStandard: 0,
      entriesFromFallback: 0,
    },
    retry: {
      slippageRetryAttempted: 0,
      slippageRetrySucceeded: 0,
      slippageRetryFailed: 0,
    },
    guardrails: {
      swapErrors: 0,
      rateLimited: 0,
      forceAttempt: {
        considered: 0,
        executed: 0,
        blockedMintCooldown: 0,
        blockedMintHourlyCap: 0,
        blockedGlobalMinuteCap: 0,
      },
    },
    watchlist: {
      ingested: 0,
      refreshed: 0,
      evicted: 0,
      ageEvicted: 0,
      staleEvicted: 0,
      ttlEvicted: 0,
      evals: 0,
      triggerHits: 0,
      attempts: 0,
      fills: 0,
      hotEnqueued: 0,
      hotConsumed: 0,
      hotAttempts: 0,
      hotFills: 0,
      routeCacheHit: 0,
      routeCacheMiss: 0,
      attemptFromRouteCache: 0,
      routeCacheStaleInvalidated: 0,
      immediateRoutePromoted: 0,
      immediateConfirmPassed: 0,
      immediateAttempts: 0,
      immediateFills: 0,
      immediateBlockedByReason: makeWatchlistBlockedReasons(),
      funnelMinuteKey: null,
      funnelMinute: makeWatchlistFunnelCounts(),
      funnelCumulative: makeWatchlistFunnelCounts(),
    },
    source: {},
    lastFlushAt: Date.now(),
  };
}

export function bump(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)]++;
}

export function rollWatchlistMinuteWindow(counters, nowMs = Date.now()) {
  counters.watchlist ||= {};
  const minuteKey = Math.floor(Number(nowMs || Date.now()) / 60_000);
  if (counters.watchlist.funnelMinuteKey !== minuteKey) {
    counters.watchlist.funnelMinuteKey = minuteKey;
    counters.watchlist.funnelMinute = makeWatchlistFunnelCounts();
  }
}

export function bumpWatchlistFunnel(counters, key, { nowMs = Date.now(), blockedReason = null } = {}) {
  counters.watchlist ||= {};
  counters.watchlist.funnelCumulative ||= makeWatchlistFunnelCounts();
  rollWatchlistMinuteWindow(counters, nowMs);

  if (key === 'blockedByReason') {
    const reasonKey = String(blockedReason || 'unknown');
    if (!(reasonKey in counters.watchlist.funnelMinute.blockedByReason)) {
      counters.watchlist.funnelMinute.blockedByReason[reasonKey] = 0;
    }
    if (!(reasonKey in counters.watchlist.funnelCumulative.blockedByReason)) {
      counters.watchlist.funnelCumulative.blockedByReason[reasonKey] = 0;
    }
    counters.watchlist.funnelMinute.blockedByReason[reasonKey] += 1;
    counters.watchlist.funnelCumulative.blockedByReason[reasonKey] += 1;
    return;
  }

  counters.watchlist.funnelMinute[key] = safeCount(counters.watchlist.funnelMinute[key]) + 1;
  counters.watchlist.funnelCumulative[key] = safeCount(counters.watchlist.funnelCumulative[key]) + 1;
}

export function snapshotAndReset(counters) {
  const snap = JSON.parse(JSON.stringify(counters));
  const next = makeCounters();
  next.lastFlushAt = Date.now();
  next.watchlist.funnelCumulative = JSON.parse(JSON.stringify(counters.watchlist?.funnelCumulative || makeWatchlistFunnelCounts()));
  next.watchlist.funnelMinuteKey = counters.watchlist?.funnelMinuteKey ?? null;
  next.watchlist.funnelMinute = JSON.parse(JSON.stringify(counters.watchlist?.funnelMinute || makeWatchlistFunnelCounts()));
  return { snap, next };
}

function perHour(count, elapsedHours) {
  if (!elapsedHours || elapsedHours <= 0) return 0;
  return count / elapsedHours;
}

function safeCount(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function normalizeSource(source) {
  const s = String(source || '').trim().toLowerCase();
  return s || 'unknown';
}

export function bumpSourceCounter(counters, source, key) {
  counters.source ||= {};
  const s = normalizeSource(source);
  counters.source[s] ||= { seen: 0, considered: 0, rejects: 0, noPairRejects: 0, passedPair: 0 };
  counters.source[s][key] = safeCount(counters.source[s][key]) + 1;
}

export function buildRejectBuckets(reject = {}) {
  return [
    ['noPair', safeCount(reject.noPair)],
    ['baseFilters', safeCount(reject.baseFilters)],
    ['rugUnsafe', safeCount(reject.rugUnsafe)],
    ['mcapLowOrMissing', safeCount(reject.mcapLowOrMissing)],
    ['momentum', safeCount(reject.momentum)],
    ['noSocialMeta', safeCount(reject.noSocialMeta)],
    ['alreadyOpen', safeCount(reject.alreadyOpen)],
    ['lowSolFees', safeCount(reject.lowSolFees)],
    ['capitalThrottle', safeCount(reject.capitalThrottle)],
    ['capitalReserve', safeCount(reject.capitalReserve)],
    ['swapError', safeCount(reject.swapError)],
    ['noPair.rateLimited', safeCount(reject.noPairReasons?.rateLimited)],
    ['noPair.providerEmpty', safeCount(reject.noPairReasons?.providerEmpty)],
    ['noPair.providerCooldown', safeCount(reject.noPairReasons?.providerCooldown)],
    ['noPair.routeNotFound', safeCount(reject.noPairReasons?.routeNotFound)],
    ['noPair.nonTradableMint', safeCount(reject.noPairReasons?.nonTradableMint)],
    ['noPair.deadMint', safeCount(reject.noPairReasons?.deadMint)],
    ['noPair.routeableNoMarketData', safeCount(reject.noPairReasons?.routeableNoMarketData)],
    ['noPair.staleData', safeCount(reject.noPairReasons?.staleData)],
    ['noPair.retriesExhausted', safeCount(reject.noPairReasons?.retriesExhausted)],
    ['rugcheckFetch', safeCount(reject.rugcheckFetch)],
    ['mcapFetch', safeCount(reject.mcapFetch)],
  ];
}

export function formatThroughputSummary({ counters, nowMs = Date.now(), title = '📈 *Throughput*', topN = 5 }) {
  const c = counters || makeCounters();
  const elapsedMs = Math.max(1, nowMs - Number(c.lastFlushAt || nowMs));
  const elapsedHours = elapsedMs / 3_600_000;

  const scansPerHour = perHour(safeCount(c.scanCycles), elapsedHours);
  const candidatesPerHour = perHour(safeCount(c.consideredPairs), elapsedHours);
  const attemptsPerHour = perHour(safeCount(c.entryAttempts), elapsedHours);
  const successPerHour = perHour(safeCount(c.entrySuccesses), elapsedHours);
  const attemptsPerMin = attemptsPerHour / 60;
  const fillsPerMin = successPerHour / 60;

  const buckets = buildRejectBuckets(c.reject)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalReject = buckets.reduce((acc, [, v]) => acc + v, 0);
  const top = buckets.slice(0, Math.max(1, topN));

  const sourceParts = Object.entries(c.source || {})
    .map(([source, stats]) => {
      const seen = safeCount(stats?.seen);
      const rejects = safeCount(stats?.rejects);
      const noPairRejects = safeCount(stats?.noPairRejects);
      if (seen <= 0) return null;
      const rejRate = ((rejects / seen) * 100).toFixed(0);
      const noPairRate = ((noPairRejects / seen) * 100).toFixed(0);
      return `${source}: noPairReject=${rejects}/${seen}(${rejRate}%) noPair=${noPairRejects}/${seen}(${noPairRate}%)`;
    })
    .filter(Boolean)
    .sort();

  const shortlistDrop = safeCount(c.route?.shortlistPrefilterDropped);
  const shortlistPass = safeCount(c.route?.shortlistPrefilterPassed);
  const shortlistTotal = shortlistDrop + shortlistPass;
  const shortlistDropPct = shortlistTotal > 0 ? ((shortlistDrop / shortlistTotal) * 100).toFixed(1) : '0.0';
  const shortlistPassPct = shortlistTotal > 0 ? ((shortlistPass / shortlistTotal) * 100).toFixed(1) : '0.0';
  const routeAvailableDroppedTop = Object.entries(c.route?.routeAvailableDropped || {})
    .filter(([, v]) => safeCount(v) > 0)
    .sort((a, b) => safeCount(b[1]) - safeCount(a[1]))
    .slice(0, 4)
    .map(([k, v]) => `${k}:${safeCount(v)}`)
    .join(', ') || 'none';

  return [
    title,
    `window=${elapsedHours.toFixed(2)}h`,
    `• scans/h: ${scansPerHour.toFixed(1)} (cycles=${safeCount(c.scanCycles)})`,
    `• candidates/h: ${candidatesPerHour.toFixed(1)} (pairs=${safeCount(c.consideredPairs)})`,
    `• entries/h: attempts=${attemptsPerHour.toFixed(2)} success=${successPerHour.toFixed(2)} (ok=${safeCount(c.entrySuccesses)}/${safeCount(c.entryAttempts)})`,
    `• entries/min: attempts=${attemptsPerMin.toFixed(3)} fills=${fillsPerMin.toFixed(3)}`,
    `• funnel: signal=${safeCount(c.funnel?.signals)} fallbackPass=${safeCount(c.funnel?.signalFallbackPass)} -> probe=${safeCount(c.funnel?.probeShortlist)} -> confirm=${safeCount(c.funnel?.confirmPassed)} -> attempt=${safeCount(c.funnel?.attempts)} -> fill=${safeCount(c.funnel?.fills)} (attempts standard=${safeCount(c.funnel?.attemptsFromStandard)} fallback=${safeCount(c.funnel?.attemptsFromFallback)} | fills standard=${safeCount(c.funnel?.entriesFromStandard)} fallback=${safeCount(c.funnel?.entriesFromFallback)})`,
    `• route: shortlistPrefilter drop/pass=${shortlistDrop}/${shortlistPass} (${shortlistDropPct}%/${shortlistPassPct}%) | checks=${safeCount(c.route?.prefilterChecks)} routeable=${safeCount(c.route?.prefilterRouteable)} rejected=${safeCount(c.route?.prefilterRejected)} tempSkips=${safeCount(c.route?.noPairTempSkips)} revisits=${safeCount(c.route?.noPairTempRevisits)} deadSkips=${safeCount(c.route?.deadMintSkips)} recheckRecovered=${safeCount(c.route?.rejectRecheckRecovered)} fanout=${safeCount(c.route?.quoteFanoutRouteable)}/${safeCount(c.route?.quoteFanoutChecked)} routeAvailable(seen/promoted)=${safeCount(c.route?.routeAvailableSeen)}/${safeCount(c.route?.routeAvailablePromotedToWatchlist)} droppedTop=${routeAvailableDroppedTop}`,
    `• pairFetch: q=${safeCount(c.pairFetch?.queued)} peakDepth=${safeCount(c.pairFetch?.queueDepthPeak)} ok=${safeCount(c.pairFetch?.success)}/${safeCount(c.pairFetch?.completed)} avgMs=${safeCount(c.pairFetch?.latencySamples) > 0 ? (safeCount(c.pairFetch?.latencyMsTotal) / safeCount(c.pairFetch?.latencySamples)).toFixed(0) : '0'} rateLimited=${safeCount(c.pairFetch?.rateLimited)} throughput/min=${(perHour(safeCount(c.pairFetch?.completed), elapsedHours) / 60).toFixed(2)} attempts=${safeCount(c.pairFetch?.attempts)}`,
    `• retry: slippage attempted=${safeCount(c.retry?.slippageRetryAttempted)} success=${safeCount(c.retry?.slippageRetrySucceeded)} failed=${safeCount(c.retry?.slippageRetryFailed)}`,
    `• guardrails: swapError=${safeCount(c.guardrails?.swapErrors)} rateLimited=${safeCount(c.guardrails?.rateLimited)} forceAttempt(considered/executed/cooldown/mintHr/globalMin)=${safeCount(c.guardrails?.forceAttempt?.considered)}/${safeCount(c.guardrails?.forceAttempt?.executed)}/${safeCount(c.guardrails?.forceAttempt?.blockedMintCooldown)}/${safeCount(c.guardrails?.forceAttempt?.blockedMintHourlyCap)}/${safeCount(c.guardrails?.forceAttempt?.blockedGlobalMinuteCap)} (noPair.rateLimited=${safeCount(c.reject?.noPairReasons?.rateLimited)} pairFetch.rateLimited=${safeCount(c.pairFetch?.rateLimited)})`,
    `• watchlist: ingested=${safeCount(c.watchlist?.ingested)} refreshed=${safeCount(c.watchlist?.refreshed)} evicted=${safeCount(c.watchlist?.evicted)} (age=${safeCount(c.watchlist?.ageEvicted)} stale=${safeCount(c.watchlist?.staleEvicted)} ttl=${safeCount(c.watchlist?.ttlEvicted)}) evals=${safeCount(c.watchlist?.evals)} hits=${safeCount(c.watchlist?.triggerHits)} attempts=${safeCount(c.watchlist?.attempts)} fills=${safeCount(c.watchlist?.fills)} hot(enq/cons/att/fill)=${safeCount(c.watchlist?.hotEnqueued)}/${safeCount(c.watchlist?.hotConsumed)}/${safeCount(c.watchlist?.hotAttempts)}/${safeCount(c.watchlist?.hotFills)} routeCache(hit/miss/fromCache/staleInvalid)=${safeCount(c.watchlist?.routeCacheHit)}/${safeCount(c.watchlist?.routeCacheMiss)}/${safeCount(c.watchlist?.attemptFromRouteCache)}/${safeCount(c.watchlist?.routeCacheStaleInvalidated)} immediate(promoted/confirm/attempt/fill)=${safeCount(c.watchlist?.immediateRoutePromoted)}/${safeCount(c.watchlist?.immediateConfirmPassed)}/${safeCount(c.watchlist?.immediateAttempts)}/${safeCount(c.watchlist?.immediateFills)} evals/min=${(perHour(safeCount(c.watchlist?.evals), elapsedHours) / 60).toFixed(2)} | minute(seen/eval/momo/confirm/attempt/fill)=${safeCount(c.watchlist?.funnelMinute?.watchlistSeen)}/${safeCount(c.watchlist?.funnelMinute?.watchlistEvaluated)}/${safeCount(c.watchlist?.funnelMinute?.momentumPassed)}/${safeCount(c.watchlist?.funnelMinute?.confirmPassed)}/${safeCount(c.watchlist?.funnelMinute?.attempted)}/${safeCount(c.watchlist?.funnelMinute?.filled)} | cumulative=${safeCount(c.watchlist?.funnelCumulative?.watchlistSeen)}/${safeCount(c.watchlist?.funnelCumulative?.watchlistEvaluated)}/${safeCount(c.watchlist?.funnelCumulative?.momentumPassed)}/${safeCount(c.watchlist?.funnelCumulative?.confirmPassed)}/${safeCount(c.watchlist?.funnelCumulative?.attempted)}/${safeCount(c.watchlist?.funnelCumulative?.filled)}`,
    `• watchlist blocked(min): ${Object.entries(c.watchlist?.funnelMinute?.blockedByReason || {}).filter(([, v]) => safeCount(v) > 0).sort((a, b) => safeCount(b[1]) - safeCount(a[1])).slice(0, 5).map(([k, v]) => `${k}=${safeCount(v)}`).join(', ') || 'none'}`,
    `• watchlist blocked(cum): ${Object.entries(c.watchlist?.funnelCumulative?.blockedByReason || {}).filter(([, v]) => safeCount(v) > 0).sort((a, b) => safeCount(b[1]) - safeCount(a[1])).slice(0, 8).map(([k, v]) => `${k}=${safeCount(v)}`).join(', ') || 'none'}`,
    `• sources: ${sourceParts.length ? sourceParts.join(' | ') : 'none yet'}`,
    `• opportunities/day est: ${(scansPerHour * 24).toFixed(1)} (target≈25/day)`,
    '• top rejects:',
    ...(top.length
      ? top.map(([k, v]) => `  - ${k}: ${v} (${totalReject ? ((v / totalReject) * 100).toFixed(0) : '0'}%)`)
      : ['  - none yet']),
  ].join('\n');
}
