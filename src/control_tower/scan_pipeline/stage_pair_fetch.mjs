export async function runPairFetchStage({
  deps,
  cfg,
  state,
  t,
  solUsdNow,
  counters,
  scanPhase,
  scanRateLimitedStart,
  scanState,
  pairFetchQueue,
  noPairTemporary,
  noPairDeadMints,
  pushScanCompactEvent,
}) {
  const {
    nowIso,
    pushDebug,
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
    toBaseUnits,
    DECIMALS,
    getRouteQuoteWithFallback,
    cacheRouteReadyMint,
    parseJupQuoteFailure,
    isJup429,
    isDexScreener429,
    bumpRouteCounter,
    setNoPairTemporary,
    promoteRouteAvailableCandidate,
    logCandidateDaily,
    classifyNoPairReason,
    bumpNoPairReason,
    recordNonTradableMint,
    NO_PAIR_DEAD_MINT_STRIKES,
    NO_PAIR_DEAD_MINT_TTL_MS,
    NO_PAIR_NON_TRADABLE_TTL_MS,
    getSnapshotStatus,
    bumpSourceCounter,
  } = deps;

  state.runtime ||= {};
  state.runtime.pairFetchGovernor ||= { degradedUntilMs: 0 };
  const basePairFetchConcurrency = Math.max(1, Math.min(8, Number(cfg.PAIR_FETCH_CONCURRENCY || 1)));
  const governorDegradedUntilMs = Number(state.runtime.pairFetchGovernor.degradedUntilMs || 0);
  const governorActive = governorDegradedUntilMs > t;
  const pairFetchConcurrency = governorActive
    ? Math.max(1, Math.floor(basePairFetchConcurrency * 0.6))
    : basePairFetchConcurrency;

  scanState.scanPairFetchConcurrency = pairFetchConcurrency;
  const routeAvailableImmediateRows = [];
  const routeAvailableImmediateRowMints = new Set();
  const preCandidates = [];

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
          event: {
            t: nowIso(),
            bot: 'candle-carl',
            mint,
            symbol: tok?.tokenSymbol || null,
            source: tok?._source || 'dex',
            outcome: promoted ? 'watchlist_promoted' : 'noPair_temporary',
            reason: promoted ? 'routeAvailable(viaJupiter,promotedWatchlist)' : 'routeAvailable(viaJupiter)',
          },
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
      scanState.scanUsableSnapshotWithoutPairCount += 1;
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

    const score = (Math.log10(Math.max(liqUsd, 1)) * 3) + (Math.log10(Math.max(v1h, 1)) * 2) + (Math.log10(Math.max(tx1h, 1)) * 2) + (Math.max(0, pc1h) * 0.2);

    bumpSourceCounter(counters, candidateSource, 'passedPair');
    preCandidates.push({ tok, mint, pair, snapshot, score, routeHint: routeAvailable === true });
  });

  const rateLimitedNow = Number(counters?.pairFetch?.rateLimited || 0) + Number(counters?.reject?.noPairReasons?.rateLimited || 0);
  const rateLimitedDelta = Math.max(0, rateLimitedNow - Number(scanRateLimitedStart || 0));
  const governorShouldDegrade = rateLimitedDelta > 0 || scanState.scanRoutePrefilterDegraded;
  if (governorShouldDegrade) {
    state.runtime.pairFetchGovernor.degradedUntilMs = Math.max(
      Number(state.runtime.pairFetchGovernor.degradedUntilMs || 0),
      t + 120_000,
    );
  }
  scanPhase.pairFetchMs += Math.max(0, Date.now() - _tPairFetch);

  return {
    preCandidates,
    routeAvailableImmediateRows,
    scanState,
  };
}
