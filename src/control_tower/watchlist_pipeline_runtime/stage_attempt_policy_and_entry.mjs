export async function runAttemptPolicyAndEntryStage(ctx) {
  const {
    cfg,
    state,
    counters,
    nowMs,
    mint,
    row,
    conn,
    wallet,
    solUsdNow,
    immediateMode,
    birdseye,
    runtimeDeps,
    pushCompactWindowEvent,
    canaryLog,
    canaryRecord,
    fail,
  } = ctx;
  const { nowIso, enforceEntryCapacityGate, ensureForceAttemptPolicyState, pruneForceAttemptPolicyWindows, evaluateForceAttemptPolicyGuards, recordForceAttemptPolicyAttempt, safeMsg } = runtimeDeps;

  state.runtime ||= {};
  state.runtime.requalifyAfterStopByMint ||= {};
  const requalifyBlock = state.runtime.requalifyAfterStopByMint[mint] || null;
  if (requalifyBlock) {
    let allowAttemptAfterFastStop = false;
    try {
      if (requalifyBlock.fastStopActive) {
        const nowMsLocal = Date.now();
        const holdUntilMs = Number(requalifyBlock.holdUntilMs || 0);
        if (Number.isFinite(holdUntilMs) && holdUntilMs > 0 && nowMsLocal >= holdUntilMs) {
          allowAttemptAfterFastStop = true;
        } else {
          const requireNewHigh = (requalifyBlock.requireNewHigh ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH) === true;
          const requireTradeUpticks = (requalifyBlock.requireTradeUpticks ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS) === true;
          const minConsecutiveTradeUpticks = Math.max(1, Number(requalifyBlock.minConsecutiveTradeUpticks || cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2));
          const breakoutAboveUsd = Number(requalifyBlock.breakoutAboveUsd || 0);
          const currentPx = Number(ctx.snapshot?.priceUsd ?? row?.latest?.priceUsd ?? ctx.pair?.priceUsd ?? 0);
          const maxConsecutiveTradeUpticks = Number(ctx.confirmGate?.diag?.maxConsecutiveTradeUpticks || 0);
          const newHighOk = !requireNewHigh || (currentPx > 0 && breakoutAboveUsd > 0 && currentPx > breakoutAboveUsd);
          const upticksOk = !requireTradeUpticks || maxConsecutiveTradeUpticks >= minConsecutiveTradeUpticks;
          allowAttemptAfterFastStop = newHighOk && upticksOk;
        }
      }
    } catch {
      allowAttemptAfterFastStop = false;
    }

    if (allowAttemptAfterFastStop) {
      delete state.runtime.requalifyAfterStopByMint[mint];
      counters.watchlist.requalifyClearedOnFastStopBreakout = Number(counters.watchlist.requalifyClearedOnFastStopBreakout || 0) + 1;
    } else {
      counters.watchlist.requalifyBlockedAttempts = Number(counters.watchlist.requalifyBlockedAttempts || 0) + 1;
      if (fail('attemptNeedsRequalify', { stage: 'attempt', meta: {
        blockedAtMs: Number(requalifyBlock?.blockedAtMs || 0),
        trigger: String(requalifyBlock?.trigger || 'stop'),
        fastStopActive: !!requalifyBlock?.fastStopActive,
        holdUntilMs: Number(requalifyBlock?.holdUntilMs || 0),
        breakoutAboveUsd: Number(requalifyBlock?.breakoutAboveUsd || 0),
        requireNewHigh: (requalifyBlock?.requireNewHigh ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH) === true,
        requireTradeUpticks: (requalifyBlock?.requireTradeUpticks ?? cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS) === true,
        minConsecutiveTradeUpticks: Math.max(1, Number(requalifyBlock?.minConsecutiveTradeUpticks || cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2)),
        maxConsecutiveTradeUpticks: Number(ctx.confirmGate?.diag?.maxConsecutiveTradeUpticks || 0),
      } }) === 'break') return 'break';
      return 'continue';
    }
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
      if (fail(guard.reason, { stage: 'forcePolicy' }) === 'break') return 'break';
      return 'continue';
    }
    counters.guardrails.forceAttemptTriggered = Number(counters.guardrails.forceAttemptTriggered || 0) + 1;
    recordForceAttemptPolicyAttempt({ policyState, mint, nowMs });
  }

  const liqForAttempt = Number(ctx.snapshot?.liquidityUsd ?? ctx.pair?.liquidity?.usd ?? row?.latest?.liqUsd ?? 0) || 0;
  ctx.liqForAttempt = liqForAttempt;
  if (liqForAttempt < ctx.attemptMinLiqUsd) {
    counters.watchlist.attemptFullLiqRejected = Number(counters.watchlist.attemptFullLiqRejected || 0) + 1;
    if (fail('fullLiqRejected', { stage: 'attempt', cooldownMs: 20_000, meta: { liqForAttempt, required: ctx.attemptMinLiqUsd } }) === 'break') return 'break';
    return 'continue';
  }

  row.meta ||= {};
  row.meta.attemptSuppression ||= {};
  const suppress = row.meta.attemptSuppression;
  const attemptCooldownMs = Number(cfg.ATTEMPT_PER_MINT_COOLDOWN_MS || 1_800_000);
  const lastAttemptTs = Number(suppress.lastAttemptAtMs || 0);
  const withinAttemptCooldown = lastAttemptTs > 0 && (nowMs - lastAttemptTs) < attemptCooldownMs;
  const priceNowForSuppression = Number(ctx.snapshot?.priceUsd ?? row?.latest?.priceUsd ?? ctx.pair?.priceUsd ?? 0) || 0;
  const newHigh = priceNowForSuppression > 0 && Number(suppress.lastAttemptPriceUsd || 0) > 0
    ? (priceNowForSuppression > (Number(suppress.lastAttemptPriceUsd || 0) * Number(cfg.ATTEMPT_NEW_HIGH_MULTIPLIER || 1.03)))
    : false;
  const liqExpandedMaterially = liqForAttempt > 0 && Number(suppress.lastAttemptLiqUsd || 0) > 0
    ? (liqForAttempt > (Number(suppress.lastAttemptLiqUsd || 0) * Number(cfg.ATTEMPT_LIQ_EXPAND_MULTIPLIER || 1.20)))
    : false;
  if (withinAttemptCooldown && !(newHigh && liqExpandedMaterially)) {
    counters.watchlist.attemptMintSuppressed = Number(counters.watchlist.attemptMintSuppressed || 0) + 1;
    if (fail('attemptMintSuppressed', { stage: 'attempt', cooldownMs: Math.max(5_000, attemptCooldownMs - Math.max(0, nowMs - lastAttemptTs)), meta: { lastAttemptTs, attemptCooldownMs, newHigh, liqExpandedMaterially } }) === 'break') return 'break';
    return 'continue';
  }

  counters.watchlist.attemptBranchDebugLast10 ||= [];
  counters.watchlist.executionPathLast10 ||= [];
  const quoteBuilt = Number.isFinite(Number(ctx.expectedOutAmount)) && Number(ctx.expectedOutAmount) > 0;
  const quoteRefreshed = !ctx.usedRouteCacheForAttempt;
  const routeSource = ctx.usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote';
  const attemptEnteredAtMs = Date.now();
  const quoteAgeMs = null;
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
  ctx.pushExecutionPath = pushExecutionPath;
  ctx.pushAttemptBranchDebug = pushAttemptBranchDebug;
  ctx.attemptEnteredAtMs = attemptEnteredAtMs;
  ctx.quoteAgeMs = quoteAgeMs;
  ctx.quoteBuilt = quoteBuilt;
  ctx.quoteRefreshed = quoteRefreshed;
  ctx.routeSource = routeSource;

  counters.entryAttempts += 1;
  counters.funnel.attempts += 1;
  counters.watchlist.attempts += 1;
  if (ctx.isHot) counters.watchlist.hotAttempts += 1;
  if (immediateMode) counters.watchlist.immediateAttempts += 1;
  if (ctx.usedRouteCacheForAttempt) counters.watchlist.attemptFromRouteCache += 1;
  ctx.attemptReachedThisEval = true;
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
  runtimeDeps.bumpWatchlistFunnel(counters, 'attempted', { nowMs });
  pushCompactWindowEvent('attempt');
  pushCompactWindowEvent('postMomentumFlow', null, {
    mint,
    liq: Number(liqForAttempt || 0),
    mcap: Number(ctx.mcapForEntry || 0),
    ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
    freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
    priceImpactPct: ctx.confirmPriceImpactPct,
    slippageBps: ctx.confirmSlippageBps,
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
  row.meta.attemptSuppression.lastAttemptPriceUsd = Number(ctx.snapshot?.priceUsd ?? row?.latest?.priceUsd ?? ctx.pair?.priceUsd ?? 0) || null;
  row.meta.attemptSuppression.lastAttemptLiqUsd = Number(liqForAttempt || 0) || null;
  if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: ctx.pair?.baseToken?.symbol || row?.pair?.baseToken?.symbol || null, tag: 'watchlist' })) {
    pushCompactWindowEvent('postMomentumFlow', null, {
      mint,
      liq: Number(liqForAttempt || 0),
      mcap: Number(ctx.mcapForEntry || 0),
      ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
      freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
      stage: 'swap',
      outcome: 'rejected',
      reason: 'entryCapacityBlocked',
    });
    pushAttemptBranchDebug({ branchTaken: 'capacityBlockedPreSwap', finalReason: 'execution.entryCapacityBlocked', swapSubmissionEntered: false });
    pushExecutionPath({ swapSubmissionEntered: false, outcome: 'noop', finalReason: 'execution.entryCapacityBlocked' });
    return 'continue';
  }
  const decimalsHintForAttempt = [
    ctx.mcap?.decimals,
    row?.latest?.decimals,
    ctx.snapshot?.raw?.decimals,
    ctx.snapshot?.pair?.baseToken?.decimals,
    ctx.pair?.baseToken?.decimals,
  ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
  const swapSubmittedAtMs = Date.now();
  ctx.swapSubmittedAtMs = swapSubmittedAtMs;
  try {
    const entryRes = await ctx.deps.openPosition(cfg, conn, wallet, state, solUsdNow, ctx.pair, ctx.mcap.mcapUsd, decimalsHintForAttempt, ctx.report, ctx.sig.reasons, {
      mint,
      tokenName: ctx.pair?.baseToken?.name || ctx.snapshot?.tokenName || ctx.snapshot?.raw?.name || row?.pair?.baseToken?.name || null,
      symbol: ctx.pair?.baseToken?.symbol || ctx.snapshot?.tokenSymbol || ctx.snapshot?.raw?.symbol || row?.pair?.baseToken?.symbol || null,
      entrySnapshot: ctx.snapshot,
      birdeyeEnabled: birdseye?.enabled,
      getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
      usdTarget: ctx.finalUsdTarget,
      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
      expectedOutAmount: ctx.expectedOutAmount,
      expectedInAmount: ctx.expectedInAmount,
      paperOnly: ctx.paperModeActive,
      stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
      stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
      trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
      trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
    });
    ctx.attemptOutcome = { kind: entryRes?.blocked ? 'blocked' : 'success', entryRes };
    return 'postAttempt';
  } catch (e) {
    ctx.attemptOutcome = { kind: 'error', error: e, degradeMsg: safeMsg(e) };
    return 'postAttempt';
  }
}
