export async function buildPairFetchQueue({
  deps,
  cfg,
  state,
  t,
  solUsdNow,
  boosted,
  counters,
  scanPhase,
  scanState,
  pushScanCompactEvent,
}) {
  const {
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
  } = deps;

  let dexHit429 = false;
  let jupHit429 = false;
  let jupRoutePrefilterDegraded = false;
  let jupRoutePrefilterDegradedReason = null;
  const noPairTemporary = ensureNoPairTemporaryState(state);
  const noPairDeadMints = ensureNoPairDeadMintState(state);

  scanState.scanJupCooldownRemainingMs = Number(jupCooldownRemainingMs(state, t) || 0);
  scanState.scanJupCooldownActive = scanState.scanJupCooldownRemainingMs > 0;

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
      scanState.scanNoPairTempActiveCount += 1;
      bumpRouteCounter(counters, 'noPairTempSkips');
      pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `noPair_temporary(active:${Math.round((tempNoPair.untilMs - t) / 1000)}s)` });
      continue;
    }
    if (tempNoPair && Number(tempNoPair.untilMs || 0) > t) {
      scanState.scanNoPairTempRevisitCount += 1;
      bumpRouteCounter(counters, 'noPairTempRevisits');
      pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: 'noPair_temporary(revisit_due)' });
    }

    scanPhase.candidateCooldownFilteringMs += Math.max(0, Date.now() - _tCooldown);
    const prevAttempts = Math.max(0, Number(tempNoPair?.attempts || 0));
    const _tRouteLoopStart = Date.now();

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
                if (recovered) bumpRouteCounter(counters, 'rejectRecheckRecovered');
                else bumpRouteCounter(counters, 'rejectRecheckMisses');
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
          pushDebug(state, { t: nowIso(), mint, symbol: tok?.tokenSymbol || null, reason: `jupPreflight(UNEXPECTED_ERR:${e?.message || e})` });
          bumpNoPairReason(counters, 'providerEmpty', candidateSource);
          setNoPairTemporary(noPairTemporary, mint, { reason: 'providerEmpty', nowMs: t, attempts: prevAttempts + 1 });
          continue;
        }
      }
    }

    scanState.scanRoutePrefilterDegraded = scanState.scanRoutePrefilterDegraded || jupRoutePrefilterDegraded;
    if (jupRoutePrefilterDegraded) {
      scanState.scanJupCooldownActive = true;
      scanState.scanJupCooldownRemainingMs = Math.max(scanState.scanJupCooldownRemainingMs, Number(jupCooldownRemainingMs(state, t) || 0));
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

  return {
    pairFetchQueue,
    dexHit429,
    jupHit429,
    jupRoutePrefilterDegraded,
    jupRoutePrefilterDegradedReason,
    noPairTemporary,
    noPairDeadMints,
    scanState,
  };
}
