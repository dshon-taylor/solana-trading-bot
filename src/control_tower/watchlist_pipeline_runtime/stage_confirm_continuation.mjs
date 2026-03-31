export async function runConfirmContinuationStage(ctx) {
  const {
    cfg,
    state,
    counters,
    nowMs,
    mint,
    row,
    conn,
    pub,
    solUsdNow,
    executionAllowed,
    executionAllowedReason,
    birdseye,
    immediateMode,
    runtimeDeps,
    pushCompactWindowEvent,
    canaryLog,
    finalizeHotBypassTrace,
    fail,
  } = ctx;
  const {
    getRugcheckReport,
    isTokenSafe,
    passesBaseFilters,
    getSolBalanceLamports,
    applySoftReserveToUsdTarget,
    toBaseUnits,
    DECIMALS,
    jupQuote,
    resolveWatchlistRouteMeta,
    cacheRouteReadyMint,
    entryCapacityAvailable,
    nowIso,
  } = runtimeDeps;

  let report = null;
  let mcap = { ok: true, reason: 'skipped', mcapUsd: null, decimals: null };
  let mcapComputed = { ok: false, reason: 'not_attempted', mcapUsd: null, decimals: null };

  const mcapCandidates = [
    { source: 'row.latest.mcapUsd', value: Number(row?.latest?.mcapUsd ?? 0) || 0 },
    { source: 'snapshot.marketCapUsd', value: Number(ctx.snapshot?.marketCapUsd ?? 0) || 0 },
    { source: 'pair.marketCap', value: Number(ctx.pair?.marketCap ?? 0) || 0 },
    { source: 'pair.fdv', value: Number(ctx.pair?.fdv ?? 0) || 0 },
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

  const parallelResults = await Promise.allSettled([
    cfg.RUGCHECK_ENABLED ? getRugcheckReport(mint).catch((err) => ({ _error: err })) : Promise.resolve(null),
    needsMcapComputation ? ctx.deps.computeMcapUsd(cfg, ctx.pair, cfg.SOLANA_RPC_URL).catch((err) => ({ ok: false, reason: 'error', _error: err })) : Promise.resolve({ ok: false, reason: 'not_needed' }),
  ]);

  if (cfg.RUGCHECK_ENABLED) {
    if (parallelResults[0].status === 'fulfilled') {
      report = parallelResults[0].value;
      if (report && !report._error) {
        const safe = isTokenSafe(report);
        if (!safe.ok) {
          if (fail('rugUnsafe', { stage: 'safety', cooldownMs: Math.min(cfg.WATCHLIST_MINT_TTL_MS, 5 * 60_000) }) === 'break') return 'break';
          return 'continue';
        }
      } else {
        if (fail('rugcheckFetch', { stage: 'safety' }) === 'break') return 'break';
        return 'continue';
      }
    } else {
      if (fail('rugcheckFetch', { stage: 'safety' }) === 'break') return 'break';
      return 'continue';
    }
  }

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
        if (fail('mcapFetch', { stage: 'filters' }) === 'break') return 'break';
        return 'continue';
      }
    } else {
      if (fail('mcapFetch', { stage: 'filters' }) === 'break') return 'break';
      return 'continue';
    }
  }

  if (mcapForFilters > 0 && !(mcap?.mcapUsd > 0)) {
    mcap = { ok: true, reason: 'resolvedFromNormalized', mcapUsd: Number(mcapForFilters), decimals: mcap?.decimals ?? null };
  }

  ctx.report = report;
  ctx.mcap = mcap;
  ctx.mcapComputed = mcapComputed;
  ctx.preConfirmMcapSourceUsed = preConfirmMcapSourceUsed;

  counters.watchlist.preConfirmMcapSourceUsed ||= {};
  counters.watchlist.preConfirmMcapSourceUsed[preConfirmMcapSourceUsed] = Number(counters.watchlist.preConfirmMcapSourceUsed[preConfirmMcapSourceUsed] || 0) + 1;

  const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
  const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
  const base = passesBaseFilters({ pair: ctx.pair, minLiquidityUsd: effLiqFloor, minAgeHours: effMinAge });
  if (cfg.BASE_FILTERS_ENABLED && !base.ok) {
    if (fail('baseFiltersFailed', { stage: 'filters', cooldownMs: 60_000 }) === 'break') return 'break';
    return 'continue';
  }

  const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
  if (cfg.MCAP_FILTER_ENABLED) {
    if (!(Number(mcapForFilters || 0) > 0)) {
      counters.watchlist.preConfirmMcapMissingRejected = Number(counters.watchlist.preConfirmMcapMissingRejected || 0) + 1;
      if (fail('mcapMissing', { stage: 'filters', meta: { mcapSourceUsed: preConfirmMcapSourceUsed, computedReason: mcapComputed?.reason || null } }) === 'break') return 'break';
      return 'continue';
    }
    if (Number(mcapForFilters || 0) < Number(effMinMcap || 0)) {
      counters.watchlist.preConfirmMcapLowRejected = Number(counters.watchlist.preConfirmMcapLowRejected || 0) + 1;
      if (fail('mcapLow', { stage: 'filters', meta: { mcapSourceUsed: preConfirmMcapSourceUsed, mcapForFilters, required: effMinMcap } }) === 'break') return 'break';
      return 'continue';
    }
  }

  const effRatio = state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO;
  const reqLiq = Math.max(effLiqFloor, effRatio * Number(mcapForFilters || 0));
  if (cfg.LIQ_RATIO_FILTER_ENABLED && ctx.liqUsd < reqLiq) {
    if (fail('liqRatioFailed', { stage: 'filters' }) === 'break') return 'break';
    return 'continue';
  }

  if (!solUsdNow) {
    if (fail('solUsdMissing', { stage: 'execution', cooldownMs: 15_000 }) === 'break') return 'break';
    return 'continue';
  }
  if (!executionAllowed) {
    const why = executionAllowedReason || 'unknown';
    if (fail(`executionDisabled.${why}`, { stage: 'execution', cooldownMs: 15_000 }) === 'break') return 'break';
    return 'continue';
  }

  const throttle = runtimeDeps.canOpenNewEntry({ state, nowMs, maxNewEntriesPerHour: cfg.MAX_NEW_ENTRIES_PER_HOUR });
  if (!throttle.ok) {
    if (fail('throttleBlocked', { stage: 'execution' }) === 'break') return 'break';
    return 'continue';
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
    if (fail('reserveBlocked', { stage: 'execution', meta: { reserveRequired: Number(softReserve?.reserveSol || 0), reserveAvailable: Number(softReserve?.spendableSol || 0), walletBalanceUsed: Number(solForReserve || 0), reserveReason } }) === 'break') return 'break';
    return 'continue';
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
    if (fail('targetUsdTooSmall', { stage: 'execution', meta: { adjustedUsdTarget, reserveReason } }) === 'break') return 'break';
    return 'continue';
  }
  counters.watchlist.executionReserveTraceLast5.push({ t: nowIso(), mint, reserveOk, adjustedUsdTarget, branchTaken: 'pass', finalReason: 'none' });
  if (counters.watchlist.executionReserveTraceLast5.length > 5) counters.watchlist.executionReserveTraceLast5 = counters.watchlist.executionReserveTraceLast5.slice(-5);

  const finalUsdTarget = softReserve.adjustedUsdTarget;
  const solLamportsFinal = toBaseUnits((finalUsdTarget / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
  ctx.finalUsdTarget = finalUsdTarget;
  ctx.solLamportsFinal = solLamportsFinal;

  const routeMeta = await resolveWatchlistRouteMeta({
    cfg,
    state,
    mint,
    row,
    solUsdNow,
    nowMs,
    counters,
  });
  ctx.routeMeta = routeMeta;

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
    const confirmDelayMs = Math.max(200, Math.round(cfg.CONFIRM_DELAY_MIN_MS + (Math.random() * (Math.max(cfg.CONFIRM_DELAY_MAX_MS, cfg.CONFIRM_DELAY_MIN_MS) - cfg.CONFIRM_DELAY_MIN_MS))));
    await new Promise((r) => setTimeout(r, confirmDelayMs));

    let quoteFinal;
    try {
      quoteFinal = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: solLamportsFinal, slippageBps: cfg.DEFAULT_SLIPPAGE_BPS });
    } catch {
      if (fail('quoteFailed', { stage: 'confirm' }) === 'break') return 'break';
      return 'continue';
    }
    const pi2 = Number(quoteFinal?.priceImpactPct || 0);
    confirmPriceImpactPct = pi2 || null;
    const confirmMaxPi = cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT;
    if (pi2 && pi2 > confirmMaxPi) {
      if (fail('confirmPriceImpact', { stage: 'confirm' }) === 'break') return 'break';
      return 'continue';
    }
    if (!quoteFinal?.routePlan?.length) {
      if (fail('confirmNoRoute', { stage: 'confirm' }) === 'break') return 'break';
      return 'continue';
    }
    expectedOutAmount = Number(quoteFinal?.outAmount || 0) || null;
    expectedInAmount = Number(quoteFinal?.inAmount || solLamportsFinal || 0) || null;
    cacheRouteReadyMint({ state, cfg, mint, quote: quoteFinal, nowMs, source: immediateMode ? 'immediate-final-quote' : 'watchlist-final-quote' });
  }
  ctx.expectedOutAmount = expectedOutAmount;
  ctx.expectedInAmount = expectedInAmount;
  ctx.confirmPriceImpactPct = confirmPriceImpactPct;
  ctx.confirmSlippageBps = confirmSlippageBps;
  ctx.usedRouteCacheForAttempt = usedRouteCacheForAttempt;

  const canonicalCarryObj = state?.watchlist?.mints?.[mint]?.meta?.confirmTxCarry || null;
  const runtimeCarryObj = state?.runtime?.confirmTxCarryByMint?.[mint] || null;
  const carryObj = row?.meta?.confirmTxCarry || canonicalCarryObj || runtimeCarryObj || null;
  const carryPresent = !!(carryObj && Number(carryObj?.atMs || 0) > 0);
  ctx.carryObj = carryObj;
  ctx.carryPresent = carryPresent;
  ctx.deps.recordConfirmCarryTrace(state, mint, 'preConfirm', {
    carryPresent,
    carryTx1m: Number(carryObj?.tx1m || 0) || null,
    carryTx5mAvg: Number(carryObj?.tx5mAvg || 0) || null,
    carryBuySellRatio: Number(carryObj?.buySellRatio || 0) || null,
    canonicalCarryPresent: !!(canonicalCarryObj && Number(canonicalCarryObj?.atMs || 0) > 0),
    runtimeCarryPresent: !!(runtimeCarryObj && Number(runtimeCarryObj?.atMs || 0) > 0),
    rowPath: 'evaluateWatchlistRows.row.meta.confirmTxCarry',
  });
  const confirmTxResolved = await ctx.deps.resolveConfirmTxMetrics({ state, row, snapshot: ctx.snapshot, pair: ctx.pair, mint, birdseye });
  const confirmSigReasons = {
    ...(ctx.sig?.reasons || {}),
    tx_1m: Number(confirmTxResolved?.tx1m || 0),
    tx_5m_avg: Number(confirmTxResolved?.tx5mAvg || 0),
    tx_30m_avg: Number(confirmTxResolved?.tx30mAvg || 0),
    buySellRatio: Number(confirmTxResolved?.buySellRatio || 0),
  };
  ctx.confirmSigReasons = confirmSigReasons;
  const confirmTx1m = Number(confirmSigReasons?.tx_1m || 0);
  const confirmTx5mAvg = Number(confirmSigReasons?.tx_5m_avg || 0);
  const confirmTx30mAvg = Number(confirmSigReasons?.tx_30m_avg || 0);
  const confirmTxAccelObserved = confirmTx5mAvg > 0 ? (confirmTx1m / Math.max(1, confirmTx5mAvg)) : 0;
  const confirmTxAccelThreshold = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
  const confirmTxAccelMissDistance = Math.max(0, confirmTxAccelThreshold - confirmTxAccelObserved);
  const confirmBuySellRatioObserved = Number(confirmSigReasons?.buySellRatio || 0);
  const confirmBuySellThreshold = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
  const confirmTxMetricSource = String(confirmTxResolved?.source || 'unknown');
  ctx.confirmTx1m = confirmTx1m;
  ctx.confirmTx5mAvg = confirmTx5mAvg;
  ctx.confirmTx30mAvg = confirmTx30mAvg;
  ctx.confirmTxAccelObserved = confirmTxAccelObserved;
  ctx.confirmTxAccelThreshold = confirmTxAccelThreshold;
  ctx.confirmTxAccelMissDistance = confirmTxAccelMissDistance;
  ctx.confirmBuySellRatioObserved = confirmBuySellRatioObserved;
  ctx.confirmBuySellThreshold = confirmBuySellThreshold;
  ctx.confirmTxMetricSource = confirmTxMetricSource;
  ctx.deps.recordConfirmCarryTrace(state, mint, 'confirmEval', {
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
    rowPath: 'confirm.eval(sigReasons from resolved carry chain)',
  });

  ctx.confirmReachedThisEval = true;
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
    liq: Number(ctx.liqUsd || 0),
    mcap: Number(ctx.mcapHot || 0),
    ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
    freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
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
  const liqForEntry = Number(ctx.snapshot?.liquidityUsd ?? ctx.pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0) || 0;
  ctx.liqForEntry = liqForEntry;
  ctx.attemptMinLiqUsd = attemptMinLiqUsd;
  if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
    counters.watchlist.hotLiqBypassReachedConfirm = Number(counters.watchlist.hotLiqBypassReachedConfirm || 0) + 1;
    counters.watchlist.hotPostBypassReachedConfirm = Number(counters.watchlist.hotPostBypassReachedConfirm || 0) + 1;
  }
  if (!((process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true') && liqForEntry < confirmMinLiqUsd) {
    counters.watchlist.confirmFullLiqRejected = Number(counters.watchlist.confirmFullLiqRejected || 0) + 1;
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.fullLiqRejected', momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
    if (fail('fullLiqRejected', { stage: 'confirm', cooldownMs: 20_000, meta: { liqForEntry, required: confirmMinLiqUsd } }) === 'break') return 'break';
    return 'continue';
  }

  state.runtime ||= {};
  state.runtime.confirmLiqTrack ||= {};
  const confirmLiqKey = String(mint || ctx.pair?.baseToken?.address || '').trim();
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
    if (fail('liqDrop60sRejected', { stage: 'confirm', cooldownMs: 20_000, meta: { liqNow: confirmLiqNow, liq60sAgo: confirmLiq60sAgo, liqDropPct: confirmLiqDropPct } }) === 'break') return 'break';
    return 'continue';
  }

  const mcapForEntry = Number(mcap?.mcapUsd ?? row?.latest?.mcapUsd ?? ctx.snapshot?.marketCapUsd ?? ctx.pair?.marketCap ?? ctx.pair?.fdv ?? 0) || 0;
  ctx.mcapForEntry = mcapForEntry;
  if (!(mcapForEntry > 0)) {
    counters.watchlist.confirmMcapMissingRejected = Number(counters.watchlist.confirmMcapMissingRejected || 0) + 1;
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.mcapMissingRejected', momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
    if (fail('mcapMissingRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') return 'break';
    return 'continue';
  }

  const confirmMinAgeHours = Number(state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS ?? 0);
  const confirmPairCreatedAt = Number(ctx.snapshot?.pair?.pairCreatedAt ?? ctx.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? 0) || null;
  const confirmAgeSec = confirmPairCreatedAt ? Math.max(0, (nowMs - confirmPairCreatedAt) / 1000) : null;
  if (confirmMinAgeHours > 0 && !(confirmAgeSec != null)) {
    counters.watchlist.confirmAgeMissingRejected = Number(counters.watchlist.confirmAgeMissingRejected || 0) + 1;
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.ageMissingRejected', momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
    if (fail('ageMissingRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') return 'break';
    return 'continue';
  }

  const continuationActive = (process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true';
  ctx.continuationActive = continuationActive;
  const mcapFreshnessForConfirmMs = Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN);
  if (!continuationActive && Number.isFinite(mcapFreshnessForConfirmMs) && mcapFreshnessForConfirmMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
    counters.watchlist.confirmMcapStaleRejected = Number(counters.watchlist.confirmMcapStaleRejected || 0) + 1;
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: 'confirm.mcapStaleRejected', momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
    if (fail('mcapStaleRejected', { stage: 'confirm', cooldownMs: 20_000 }) === 'break') return 'break';
    return 'continue';
  }

  state.runtime ||= {};
  state.runtime.confirmRetryGateByMint ||= {};
  state.runtime.confirmRetryRequalifiedPassed ||= 0;
  const retryGate = state.runtime.confirmRetryGateByMint[mint] || null;
  const retryStartPrice = Number(ctx.snapshot?.priceUsd ?? row?.latest?.priceUsd ?? ctx.pair?.priceUsd ?? 0) || 0;
  const retryMomentumScore = Number(confirmSigReasons?.momentumScore || ctx.sig?.reasons?.momentumScore || 0) || 0;
  const retryWalletExpansion = Number(confirmSigReasons?.walletExpansion || ctx.sig?.reasons?.walletExpansion || 0) || 0;
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
        ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
        priceImpactPct: confirmPriceImpactPct,
        slippageBps: confirmSlippageBps,
        stage: 'confirm',
        outcome: 'rejected',
        reason: retryReason,
        continuationMode: true,
        continuationPassReason: 'none',
      });
      if (fail(retryReason, { stage: 'confirm', cooldownMs: 20_000, meta: { retryGate, retryAgeMs, retryMinDelayMs } }) === 'break') return 'break';
      return 'continue';
    }
  }
  ctx.retryImprovedThisPass = retryImprovedThisPass;
  ctx.retryGate = retryGate;

  const confirmStartLiqUsd = Number(liqForEntry || 0) || 0;
  const confirmGate = continuationActive
    ? await ctx.deps.confirmContinuationGate({ cfg, mint, row, snapshot: ctx.snapshot, pair: ctx.pair, confirmMinLiqUsd, confirmPriceImpactPct, confirmStartLiqUsd })
    : ctx.deps.confirmQualityGate({ cfg, sigReasons: confirmSigReasons, snapshot: ctx.snapshot });
  ctx.confirmGate = confirmGate;
  if (!confirmGate.ok) {
    const rejectReason = continuationActive ? `confirmContinuation.${String(confirmGate?.failReason || 'windowExpired')}` : String(confirmGate.reason || 'confirmGateRejected');
    pushCompactWindowEvent('postMomentumFlow', null, {
      mint,
      liq: Number(liqForEntry || 0),
      mcap: Number(mcapForEntry || 0),
      ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
      freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
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
      continuationInitialSourceUsed: String(confirmGate?.diag?.initialSourceUsed || 'unknown'),
      continuationDominantSourceUsed: String(confirmGate?.diag?.dominantSourceUsed || 'unknown'),
      continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
      continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
      continuationUniqueOhlcvTicksWithinWindow: Number(confirmGate?.diag?.uniqueOhlcvTicksWithinWindow || 0) || 0,
      continuationTradeUpdateCountWithinWindow: Number(confirmGate?.diag?.tradeUpdateCountWithinWindow || 0) || 0,
      continuationUniqueTradeTicksWithinWindow: Number(confirmGate?.diag?.uniqueTradeTicksWithinWindow || 0) || 0,
      continuationRunupSourceUsed: String(confirmGate?.diag?.runupSourceUsed || 'no_runup'),
      continuationTradeSequenceSourceUsed: String(confirmGate?.diag?.tradeSequenceSourceUsed || 'ws_trade'),
      continuationTradeTickCountAtRunupMoment: Number(confirmGate?.diag?.tradeTickCountAtRunupMoment || 0) || 0,
      continuationTradeSequenceEligibleAtRunup: !!confirmGate?.diag?.tradeSequenceEligibleAtRunup,
      continuationMaxConsecutiveTradeUpticks: Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0) || 0,
      continuationMinConsecutiveTradeUpticks: Number(confirmGate?.diag?.minConsecutiveTradeUpticks || 0) || 0,
      continuationRequireTradeUpticks: !!confirmGate?.diag?.requireTradeUpticks,
      continuationSelectedTradeReads: Number(confirmGate?.diag?.selectedTradeReads || 0) || 0,
      continuationSelectedOhlcvReads: Number(confirmGate?.diag?.selectedOhlcvReads || 0) || 0,
      continuationWsUpdateTimestamps: Array.isArray(confirmGate?.diag?.wsUpdateTimestamps) ? confirmGate.diag.wsUpdateTimestamps.slice(0, 24) : [],
      continuationWsUpdatePrices: Array.isArray(confirmGate?.diag?.wsUpdatePrices) ? confirmGate.diag.wsUpdatePrices.slice(0, 24) : [],
      continuationTradeUpdateTimestamps: Array.isArray(confirmGate?.diag?.tradeUpdateTimestamps) ? confirmGate.diag.tradeUpdateTimestamps.slice(0, 24) : [],
      continuationTradeUpdatePrices: Array.isArray(confirmGate?.diag?.tradeUpdatePrices) ? confirmGate.diag.tradeUpdatePrices.slice(0, 24) : [],
    });
    if (continuationActive && String(confirmGate?.failReason || '') === 'dataUnavailable') {
      return 'continue';
    }
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
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: `confirm.${rejectReason}`, momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: false });
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
    } }) === 'break') return 'break';
    return 'continue';
  }

  runtimeDeps.bumpWatchlistFunnel(counters, 'confirmPassed', { nowMs });
  pushCompactWindowEvent('confirmPassed');
  pushCompactWindowEvent('postMomentumFlow', null, {
    mint,
    liq: Number(liqForEntry || 0),
    mcap: Number(mcapForEntry || 0),
    ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
    freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
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
    continuationInitialSourceUsed: String(confirmGate?.diag?.initialSourceUsed || 'unknown'),
    continuationDominantSourceUsed: String(confirmGate?.diag?.dominantSourceUsed || 'unknown'),
    continuationConfirmStartedAtMs: Number.isFinite(Number(confirmGate?.diag?.confirmStartedAtMs)) ? Number(confirmGate.diag.confirmStartedAtMs) : null,
    continuationWsUpdateCountWithinWindow: Number(confirmGate?.diag?.wsUpdateCountWithinWindow || 0) || 0,
    continuationUniqueOhlcvTicksWithinWindow: Number(confirmGate?.diag?.uniqueOhlcvTicksWithinWindow || 0) || 0,
    continuationTradeUpdateCountWithinWindow: Number(confirmGate?.diag?.tradeUpdateCountWithinWindow || 0) || 0,
    continuationUniqueTradeTicksWithinWindow: Number(confirmGate?.diag?.uniqueTradeTicksWithinWindow || 0) || 0,
    continuationRunupSourceUsed: String(confirmGate?.diag?.runupSourceUsed || 'no_runup'),
    continuationTradeSequenceSourceUsed: String(confirmGate?.diag?.tradeSequenceSourceUsed || 'ws_trade'),
    continuationTradeTickCountAtRunupMoment: Number(confirmGate?.diag?.tradeTickCountAtRunupMoment || 0) || 0,
    continuationTradeSequenceEligibleAtRunup: !!confirmGate?.diag?.tradeSequenceEligibleAtRunup,
    continuationMaxConsecutiveTradeUpticks: Number(confirmGate?.diag?.maxConsecutiveTradeUpticks || 0) || 0,
    continuationMinConsecutiveTradeUpticks: Number(confirmGate?.diag?.minConsecutiveTradeUpticks || 0) || 0,
    continuationRequireTradeUpticks: !!confirmGate?.diag?.requireTradeUpticks,
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
  if (ctx.hotBypassTraceCtx) {
    counters.watchlist.hotPostBypassReachedConfirm = Number(counters.watchlist.hotPostBypassReachedConfirm || 0) + 1;
    ctx.hotBypassTraceCtx._confirmPassed = true;
    finalizeHotBypassTrace({ nextStageReached: 'confirm', finalPreMomentumRejectReason: null, momentumCounterIncremented: !!ctx.hotBypassTraceCtx?._momentumPassed, confirmCounterIncremented: true });
  }
  if (immediateMode) counters.watchlist.immediateConfirmPassed += 1;

  return 'next';
}
