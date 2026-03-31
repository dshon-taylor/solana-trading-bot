export async function runPostAttemptOutcomesStage(ctx) {
  const {
    cfg,
    state,
    counters,
    nowMs,
    mint,
    row,
    runtimeDeps,
    pushCompactWindowEvent,
    canaryLog,
    canaryRecord,
    fail,
  } = ctx;
  const { nowIso, safeMsg, bump, pushDebug, saveState, recordEntryOpened } = runtimeDeps;
  const { wsmgr } = ctx.deps;
  const outcome = ctx.attemptOutcome;
  if (!outcome) return 'continue';

  if (outcome.kind === 'blocked') {
    const entryRes = outcome.entryRes;
    ctx.pushAttemptBranchDebug({ branchTaken: 'swapSubmissionReturnedBlocked', finalReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`, swapSubmissionEntered: true });
    ctx.pushExecutionPath({ swapSubmissionEntered: true, outcome: 'blocked', finalReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}` });
    counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
    counters.guardrails.entryBlockedReasons ||= {};
    counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
    counters.guardrails.entryBlockedLast10 ||= [];
    counters.guardrails.entryBlockedLast10.push({
      t: nowIso(),
      mint,
      reason: String(entryRes?.reason || 'unknown'),
      pairBaseTokenAddress: String(entryRes?.meta?.pairBaseTokenAddress || ctx.pair?.baseToken?.address || ''),
      mintResolvedForDecimals: String(entryRes?.meta?.mintResolvedForDecimals || mint || ''),
      decimalsSource: String(entryRes?.meta?.decimalsSource || 'none'),
      decimalsSourcesTried: Array.isArray(entryRes?.meta?.decimalsSourcesTried) ? entryRes.meta.decimalsSourcesTried : [],
      missingLookup: Array.isArray(entryRes?.meta?.decimalsSourcesTried)
        ? (entryRes.meta.decimalsSourcesTried.filter((x) => !x?.ok).map((x) => String(x?.source || 'unknown')).join('>') || 'none')
        : 'none',
      finalMissingDecimalsReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`,
    });
    if (counters.guardrails.entryBlockedLast10.length > 10) counters.guardrails.entryBlockedLast10 = counters.guardrails.entryBlockedLast10.slice(-10);
    canaryRecord('swap', 'entryBlocked', { reason: entryRes.reason, meta: entryRes.meta || null });
    fail(`entryBlocked_${entryRes.reason}`, { stage: 'swap', cooldownMs: 5_000 });
    ctx.attemptOutcome = null;
    return 'continue';
  }

  if (outcome.kind === 'success') {
    const entryRes = outcome.entryRes;
    canaryRecord('swap', 'openPositionReturned', { signature: entryRes?.signature || null, ok: !!entryRes?.signature });
    ctx.pushAttemptBranchDebug({ branchTaken: 'swapSubmissionReturnedSuccess', finalReason: 'fill.passed', swapSubmissionEntered: true });
    ctx.pushExecutionPath({ swapSubmissionEntered: true, outcome: 'success', finalReason: 'fill.passed' });
    counters.entrySuccesses += 1;
    counters.funnel.fills += 1;
    counters.watchlist.fills += 1;
    if (ctx.isHot) counters.watchlist.hotFills += 1;
    if (ctx.immediateMode) counters.watchlist.immediateFills += 1;
    runtimeDeps.bumpWatchlistFunnel(counters, 'filled', { nowMs });
    if (row?.meta?.preRunner?.taggedAtMs) {
      counters.watchlist.preRunnerFilled = Number(counters.watchlist.preRunnerFilled || 0) + 1;
      counters.watchlist.preRunnerLast10 ||= [];
      for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
          counters.watchlist.preRunnerLast10[i].finalStageReached = 'fill';
          break;
        }
      }
    }
    if (row?.meta?.burst?.taggedAtMs) {
      counters.watchlist.burstFilled = Number(counters.watchlist.burstFilled || 0) + 1;
      counters.watchlist.burstLast10 ||= [];
      for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
        if (counters.watchlist.burstLast10[i]?.mint === mint) {
          counters.watchlist.burstLast10[i].finalStageReached = 'fill';
          break;
        }
      }
    }
    pushCompactWindowEvent('fill');
    const fillAtMs = Date.now();
    const sendToFillMs = Number.isFinite(Number(ctx.swapSubmittedAtMs)) ? Math.max(0, fillAtMs - Number(ctx.swapSubmittedAtMs)) : null;
    const totalAttemptToFillMs = Number.isFinite(Number(ctx.attemptEnteredAtMs)) ? Math.max(0, fillAtMs - Number(ctx.attemptEnteredAtMs)) : null;
    pushCompactWindowEvent('postMomentumFlow', null, {
      mint,
      liq: Number(ctx.liqForAttempt || 0),
      mcap: Number(ctx.mcapForEntry || 0),
      ageMin: Number.isFinite(ctx.tokenAgeMinutes) ? ctx.tokenAgeMinutes : null,
      freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN),
      priceImpactPct: ctx.confirmPriceImpactPct,
      slippageBps: ctx.confirmSlippageBps,
      sendToFillMs,
      totalAttemptToFillMs,
      quoteAgeMs: ctx.quoteAgeMs,
      stage: 'fill',
      outcome: 'passed',
      reason: 'none',
    });
    canaryLog('fill', 'opened');
    row.lastFillAtMs = nowMs;
    row.totalFills = Number(row.totalFills || 0) + 1;
    row.lastTriggerHitAtMs = nowMs;
    row.cooldownUntilMs = nowMs + (cfg.FORCE_ATTEMPT_POLICY_ACTIVE ? cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS : cfg.PAPER_ENTRY_COOLDOWN_MS);
    if (entryRes?.swapMeta?.attempted) {
      counters.retry.slippageRetryAttempted += 1;
      if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
      else counters.retry.slippageRetryFailed += 1;
    }
    recordEntryOpened({ state, nowMs });
    try {
      wsmgr.onFill(mint, {
        entryPrice: state.positions?.[mint]?.entryPriceUsd,
        stopPrice: state.positions?.[mint]?.stopPriceUsd,
        stopPct: null,
        trailingPct: state.positions?.[mint]?.trailDistancePct,
      });
    } catch {}
    saveState(cfg.STATE_PATH, state);
    ctx.attemptOutcome = null;
    return 'continue';
  }

  if (outcome.kind === 'error') {
    const degradeMsg = outcome.degradeMsg || safeMsg(outcome.error);
    counters.watchlist.attemptBranchDebugLast10 ||= [];
    counters.watchlist.attemptBranchDebugLast10.push({
      t: nowIso(),
      mint,
      attemptEntered: true,
      swapSubmissionEntered: true,
      branchTaken: 'swapSubmissionThrew',
      finalReason: `swapError(${degradeMsg})`,
    });
    if (counters.watchlist.attemptBranchDebugLast10.length > 10) counters.watchlist.attemptBranchDebugLast10 = counters.watchlist.attemptBranchDebugLast10.slice(-10);
    counters.watchlist.executionPathLast10 ||= [];
    counters.watchlist.executionPathLast10.push({
      t: nowIso(), mint, attemptEntered: true, quoteBuilt: ctx.quoteBuilt, quoteRefreshed: ctx.quoteRefreshed, routeSource: ctx.routeSource, quoteAgeMs: null, swapSubmissionEntered: true, outcome: 'threw', finalReason: `swapError(${degradeMsg})`,
    });
    if (counters.watchlist.executionPathLast10.length > 10) counters.watchlist.executionPathLast10 = counters.watchlist.executionPathLast10.slice(-10);
    const m = /Quote degraded: out\s+(\d+)\s+<\s+min\s+(\d+)/i.exec(degradeMsg || '');
    if (m) {
      counters.watchlist.quoteDegradeLast10 ||= [];
      counters.watchlist.quoteDegradeLast10.push({
        t: nowIso(),
        mint,
        quotedOut: Number(ctx.expectedOutAmount || 0),
        finalOut: Number(m[1] || 0),
        minOut: Number(m[2] || 0),
        slippageBps: Number(cfg.DEFAULT_SLIPPAGE_BPS || 0),
        priceImpactPct: Number(ctx.confirmPriceImpactPct || 0) || null,
        quoteAgeMs: null,
        routeSource: ctx.usedRouteCacheForAttempt ? 'routeCache.recheck' : 'confirm.finalQuote',
        quoteRefreshed: !ctx.usedRouteCacheForAttempt,
        routeChanged: null,
        finalReason: `swapError(${degradeMsg})`,
      });
      if (counters.watchlist.quoteDegradeLast10.length > 10) counters.watchlist.quoteDegradeLast10 = counters.watchlist.quoteDegradeLast10.slice(-10);
    }
    bump(counters, 'reject.swapError');
    canaryRecord('swap', 'swapError', { message: safeMsg(outcome.error) });
    fail('swapError', { stage: 'executeSwap', cooldownMs: 30_000 });
    pushDebug(state, { t: nowIso(), mint, symbol: ctx.pair?.baseToken?.symbol, reason: `watchlistSwapError(${safeMsg(outcome.error)})` });
    ctx.attemptOutcome = null;
  }

  return 'continue';
}
