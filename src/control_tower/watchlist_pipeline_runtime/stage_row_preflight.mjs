export async function runRowPreflightStage(ctx) {
  const {
    cfg,
    state,
    counters,
    nowMs,
    executionAllowed,
    mint,
    row,
    isHot,
    birdseye,
    runtimeDeps,
    pushCompactWindowEvent,
    canaryLog,
    tryHotEnrichedRefresh,
    bumpPostBypassReject,
    finalizeHotBypassTrace,
    fail,
  } = ctx;
  const {
    getSnapshotStatus,
    isEntrySnapshotSafe,
    getWatchlistEntrySnapshotUnsafeReason,
    snapshotFromBirdseye,
    applySnapshotToLatest,
    normalizeEpochMs,
    getCachedMintCreatedAt,
    scheduleMintCreatedAtLookup,
    holdersGateCheck,
    entryCapacityAvailable,
  } = runtimeDeps;

  canaryLog('seen', ctx.immediateMode ? 'immediate' : 'scheduled');
  if (isHot) counters.watchlist.hotConsumed += 1;
  runtimeDeps.bumpWatchlistFunnel(counters, 'watchlistSeen', { nowMs });
  pushCompactWindowEvent('watchlistSeen');

  const lastEvalMs = Number(row?.lastEvaluatedAtMs || 0);
  const preRunnerFastMinMs = Number(cfg.PRE_RUNNER_EVAL_MIN_MS || 500);
  const preRunnerFastMaxMs = Number(cfg.PRE_RUNNER_EVAL_MAX_MS || preRunnerFastMinMs);
  const preRunnerMeta = row?.meta?.preRunner || null;
  const burstMeta = row?.meta?.burst || null;
  const preRunnerFastActive = !!(preRunnerMeta?.active && Number(preRunnerMeta?.fastUntilMs || 0) > nowMs);
  const burstFastMinMs = Number(cfg.BURST_EVAL_MIN_MS || 500);
  const burstFastMaxMs = Number(cfg.BURST_EVAL_MAX_MS || burstFastMinMs);
  const burstFastActive = !!(burstMeta?.active && Number(burstMeta?.fastUntilMs || 0) > nowMs);
  if (preRunnerMeta?.active && Number(preRunnerMeta?.fastUntilMs || 0) > 0 && Number(preRunnerMeta?.fastUntilMs || 0) <= nowMs) {
    row.meta.preRunner.active = false;
    counters.watchlist.preRunnerExpired = Number(counters.watchlist.preRunnerExpired || 0) + 1;
  }
  if (burstMeta?.active && Number(burstMeta?.fastUntilMs || 0) > 0 && Number(burstMeta?.fastUntilMs || 0) <= nowMs) {
    row.meta.burst.active = false;
    counters.watchlist.burstExpired = Number(counters.watchlist.burstExpired || 0) + 1;
  }
  const minGapMs = (preRunnerFastActive || burstFastActive)
    ? Math.max(500, Math.round((preRunnerFastActive ? preRunnerFastMinMs : burstFastMinMs) + (Math.random() * ((preRunnerFastActive ? preRunnerFastMaxMs : burstFastMaxMs) - (preRunnerFastActive ? preRunnerFastMinMs : burstFastMinMs)))))
    : (isHot
      ? Math.max(500, Math.round(cfg.HOT_EVAL_MIN_MS + (Math.random() * (Math.max(cfg.HOT_EVAL_MAX_MS, cfg.HOT_EVAL_MIN_MS) - cfg.HOT_EVAL_MIN_MS))))
      : Math.max(15_000, Math.round(cfg.COLD_EVAL_MIN_MS + (Math.random() * (Math.max(cfg.COLD_EVAL_MAX_MS, cfg.COLD_EVAL_MIN_MS) - cfg.COLD_EVAL_MIN_MS)))));
  if (lastEvalMs && (nowMs - lastEvalMs) < minGapMs) {
    return 'continue';
  }

  counters.watchlist.evals += 1;
  row.lastEvaluatedAtMs = nowMs;
  row.staleCycles = Number(row.staleCycles || 0) + 1;

  if (Number(row.cooldownUntilMs || 0) > nowMs) {
    if (!(cfg.CONVERSION_CANARY_MODE && ctx.isCanary)) {
      if (fail('cooldown', { stage: 'precheck' }) === 'break') return 'break';
      return 'continue';
    }
  }
  if (executionAllowed && !entryCapacityAvailable(state, cfg)) {
    if (fail('maxPositions', { stage: 'precheck', breakLoop: true }) === 'break') return 'break';
    return 'continue';
  }
  if (state.positions[mint]?.status === 'open') {
    if (fail('alreadyOpen', { stage: 'precheck' }) === 'break') return 'break';
    return 'continue';
  }

  let pair = row.pair || null;
  let snapshot = row.snapshot || null;
  ctx.pair = pair;
  ctx.snapshot = snapshot;
  ctx.wasRouteAvailableOnly = String(row?.latest?.marketDataSource || row?.snapshot?.source || '').toLowerCase() === 'routeavailableonly';
  ctx.hotMomentumMinLiqUsd = Number(cfg.HOT_MOMENTUM_MIN_LIQ_USD || 40_000);
  ctx.hotBypassTraceCtx = null;
  row.meta ||= {};
  row.meta.hotMomentumOnlyLiquidityBypass = false;
  ctx.enrichedRefreshUsed = false;
  ctx.enrichedRetryUsed = false;

  const snapshotLooksUnsafe = !snapshot?.priceUsd || !isEntrySnapshotSafe(snapshot);
  if (snapshotLooksUnsafe && birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
    try {
      const bird = await birdseye.getTokenSnapshot(mint);
      const birdSnap = snapshotFromBirdseye(bird, nowMs);
      if (birdSnap) {
        ctx.birdseyeSnapshot = birdSnap;
        snapshot = birdSnap;
        row.snapshot = birdSnap;
        ctx.snapshot = snapshot;
      }
    } catch {}
  }

  let snapshotStatus = getSnapshotStatus({ snapshot, birdseyeSnapshot: ctx.birdseyeSnapshot });
  if (snapshotStatus.snapshotStatus !== 'safe') {
    let unsafeReason = getWatchlistEntrySnapshotUnsafeReason({ snapshot, birdseyeSnapshot: ctx.birdseyeSnapshot });
    const shouldEnrich = unsafeReason === 'unsafeSnapshot.liquidityBelowThreshold' || unsafeReason === 'unsafeSnapshot.birdeyeStale';
    if (shouldEnrich) {
      const refreshed = await tryHotEnrichedRefresh(unsafeReason === 'unsafeSnapshot.liquidityBelowThreshold' ? 'liquidity' : 'staleData');
      snapshot = ctx.snapshot;
      if (refreshed) {
        snapshotStatus = getSnapshotStatus({ snapshot, birdseyeSnapshot: snapshot });
        unsafeReason = getWatchlistEntrySnapshotUnsafeReason({ snapshot, birdseyeSnapshot: snapshot });
        if (snapshotStatus.snapshotStatus === 'safe') {
          counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
        } else {
          counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
        }
      }
    }
    if (snapshotStatus.snapshotStatus !== 'safe') {
      const unsafeReasons = Array.isArray(snapshotStatus.unsafeReasons) ? snapshotStatus.unsafeReasons : [];
      const reasonsSet = new Set(unsafeReasons);
      const liqNow = Number(snapshot?.liquidityUsd ?? row?.latest?.liqUsd ?? 0) || 0;
      const fullLiqFloorNow = Number(cfg.MIN_LIQUIDITY_FLOOR_USD);
      const mcapNow = Number(row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || 0;
      const hasMissingSnapshot = reasonsSet.has('missingSnapshot');
      const hasMissingPrice = reasonsSet.has('missingPrice');
      const hasLiqUnsafe = reasonsSet.has('liquidityBelowThreshold');
      const hasStale = reasonsSet.has('staleTimestamp');
      const hasOnlyLiq = (unsafeReasons.length === 1 && hasLiqUnsafe);
      const hasLiqPlusStaleOnly = (unsafeReasons.length === 2 && hasLiqUnsafe && hasStale);
      const hasUnknownHardUnsafe = unsafeReasons.some((r) => !['liquidityBelowThreshold', 'staleTimestamp'].includes(String(r || '')));
      const hasMcapMissing = !(mcapNow > 0);

      if (isHot && hasLiqUnsafe) {
        counters.watchlist.hotLiqBypassUnsafeCombo ||= {};
        const comboKey = unsafeReasons.slice().sort().join('+') || 'none';
        counters.watchlist.hotLiqBypassUnsafeCombo[comboKey] = Number(counters.watchlist.hotLiqBypassUnsafeCombo[comboKey] || 0) + 1;

        const liqInBypassBand = (liqNow < fullLiqFloorNow) && (liqNow >= ctx.hotMomentumMinLiqUsd);
        const reasonsAllowedSubset = !hasUnknownHardUnsafe && (hasOnlyLiq || hasLiqPlusStaleOnly);
        const bypassEligible = liqInBypassBand && reasonsAllowedSubset && !hasMissingPrice && !hasMissingSnapshot;

        const mcapTraceValue = Number(row?.latest?.mcapUsd ?? snapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || null;
        const mcapTraceSource = (Number(row?.latest?.mcapUsd || 0) > 0) ? 'row.latest'
          : (Number(snapshot?.marketCapUsd || 0) > 0) ? 'snapshot.marketCapUsd'
          : (Number(pair?.marketCap || 0) > 0) ? 'pair.marketCap'
          : (Number(pair?.fdv || 0) > 0) ? 'pair.fdv'
          : 'missing';
        const pairCreatedAtTrace = Number(snapshot?.pair?.pairCreatedAt ?? row?.latest?.pairCreatedAt ?? pair?.pairCreatedAt ?? 0) || 0;
        const ageHoursTrace = pairCreatedAtTrace > 0 ? Math.max(0, (nowMs - pairCreatedAtTrace) / 3600000) : null;
        const holderSummaryTrace = {
          holders: Number(snapshot?.entryHints?.participation?.holders ?? row?.latest?.holders ?? pair?.participation?.holders ?? 0) || null,
          topHolderPct: Number(row?.latest?.topHolderPct ?? snapshot?.topHolderPct ?? NaN),
          top10Pct: Number(row?.latest?.top10Pct ?? snapshot?.top10HoldersPct ?? snapshot?.top10Pct ?? NaN),
          bundleClusterPct: Number(row?.latest?.bundleClusterPct ?? snapshot?.bundleClusterPct ?? NaN),
        };
        const traceBase = {
          timestamp: runtimeDeps.nowIso(),
          mint,
          liquidityUsd: liqNow,
          HOT_MOMENTUM_MIN_LIQ_USD: ctx.hotMomentumMinLiqUsd,
          MIN_LIQUIDITY_FLOOR_USD: fullLiqFloorNow,
          unsafeReasonsBeforeBypass: unsafeReasons,
          freshnessMs: Number(snapshot?.freshnessMs ?? row?.latest?.marketDataFreshnessMs ?? null),
          ageHours: ageHoursTrace,
          holderSummary: holderSummaryTrace,
          mcapValueSeenByHot: mcapTraceValue,
          mcapSourceUsed: mcapTraceSource,
        };

        if (bypassEligible) {
          counters.watchlist.hotLiqMomentumBypassAllowed = Number(counters.watchlist.hotLiqMomentumBypassAllowed || 0) + 1;
          try { ctx.pushCompactWindowEvent?.('hotBypass', null, { mint, decision: 'allowed', primary: 'allowed' }); } catch {}
          row.meta.hotMomentumOnlyLiquidityBypass = true;
          row.meta.hotMomentumBypassLiquidityUsd = liqNow;
          row.meta.hotMomentumBypassAtMs = nowMs;
          ctx.hotBypassTraceCtx = {
            ...traceBase,
            bypassDecision: 'allowed',
            bypassPrimaryRejectReason: null,
            bypassSecondaryTags: [],
          };
          snapshotStatus = { snapshotStatus: 'safe', unsafeReasons: [], confidenceScore: snapshotStatus.confidenceScore };
        } else {
          counters.watchlist.hotLiqMomentumBypassRejected = Number(counters.watchlist.hotLiqMomentumBypassRejected || 0) + 1;
          counters.watchlist.hotLiqBypassPrimaryRejectReason ||= {};
          counters.watchlist.hotLiqBypassSecondaryTags ||= {};
          const bumpPrimary = (k) => { counters.watchlist.hotLiqBypassPrimaryRejectReason[k] = Number(counters.watchlist.hotLiqBypassPrimaryRejectReason[k] || 0) + 1; };
          const bumpSecondary = (k) => { counters.watchlist.hotLiqBypassSecondaryTags[k] = Number(counters.watchlist.hotLiqBypassSecondaryTags[k] || 0) + 1; };

          let primary = null;
          if (hasMissingSnapshot) primary = 'missingSnapshot';
          else if (hasMissingPrice) primary = 'missingPrice';
          else if (hasUnknownHardUnsafe) primary = 'disallowedUnsafeReason';
          else if (!liqInBypassBand) primary = (liqNow < ctx.hotMomentumMinLiqUsd) ? 'belowHotStalkingFloor' : 'atOrAboveFullFloor';
          else primary = 'other';
          bumpPrimary(primary);
          try { ctx.pushCompactWindowEvent?.('hotBypass', null, { mint, decision: 'rejected', primary }); } catch {}

          const secondaryTags = [];
          if (hasMcapMissing) { bumpSecondary('mcapMissing(diagnostic)'); secondaryTags.push('mcapMissing(diagnostic)'); }
          if (hasLiqPlusStaleOnly) { bumpSecondary('liq+stale'); secondaryTags.push('liq+stale'); }
          if (hasOnlyLiq) { bumpSecondary('liqOnly'); secondaryTags.push('liqOnly'); }
          if (hasLiqUnsafe) { bumpSecondary('liqUnsafe'); secondaryTags.push('liqUnsafe'); }
          if (hasStale) { bumpSecondary('stale'); secondaryTags.push('stale'); }

          ctx.emitHotBypassTrace({
            ...traceBase,
            bypassDecision: 'rejected',
            bypassPrimaryRejectReason: primary,
            bypassSecondaryTags: secondaryTags,
            nextStageReached: 'snapshotGateReject',
            finalPreMomentumRejectReason: `snapshot.${unsafeReason || 'unsafe'}`,
            momentumCounterIncremented: false,
            confirmCounterIncremented: false,
          });
        }
      }
    }
    if (snapshotStatus.snapshotStatus !== 'safe') {
      const providerStatus = state.marketData?.providers?.birdeye?.status || (state.streaming?.health?.providerStatus || null);
      const meta = {
        unsafeReasons: snapshotStatus.unsafeReasons,
        confidenceScore: snapshotStatus.confidenceScore,
        providerStatus,
        snapshotAgeMs: snapshot?.freshnessMs ?? null,
      };
      if (fail(unsafeReason, { stage: 'snapshot', meta }) === 'break') return 'break';
      return 'continue';
    }
  }

  if (!pair) {
    pair = {
      baseToken: { address: mint, symbol: row?.pair?.baseToken?.symbol || null },
      liquidity: { usd: Number(snapshot?.liquidityUsd || 0) },
      volume: { h1: Number(snapshot?.volume?.h1 || 0), h4: 0 },
      txns: { h1: { buys: Number(snapshot?.txns?.h1?.buys || 0), sells: Number(snapshot?.txns?.h1?.sells || 0) } },
      priceChange: { h1: 0, h4: 0 },
      pairCreatedAt: Number(row?.latest?.pairCreatedAt || 0) || null,
      pairAddress: null,
      dexId: snapshot?.source || 'birdseye',
      priceUsd: Number(snapshot?.priceUsd || 0) || null,
    };
  }
  ctx.pair = pair;
  ctx.snapshot = snapshot;

  const hotMinMcap = Number(state?.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD ?? 0);
  const hotMinAgeHours = Number(state?.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS ?? 0);
  const mcapRefreshRetries = Number(cfg.HOT_MCAP_REFRESH_RETRIES || 2);
  const mcapRefreshDelayMs = Number(cfg.HOT_MCAP_REFRESH_DELAY_MS || 220);
  const mcapRefreshWindowMs = Number(cfg.HOT_MCAP_REFRESH_WINDOW_MS || 1800);
  const resolveMcapHot = () => {
    const mcapFromRow = Number(row?.latest?.mcapUsd ?? 0);
    const mcapFromSnap = Number(snapshot?.marketCapUsd ?? 0);
    const mcapFromPairMcap = Number(pair?.marketCap ?? 0);
    const mcapFromPairFdv = Number(pair?.fdv ?? 0);
    if (Number.isFinite(mcapFromRow) && mcapFromRow > 0) return { value: mcapFromRow, source: 'row.latest' };
    if (Number.isFinite(mcapFromSnap) && mcapFromSnap > 0) return { value: mcapFromSnap, source: 'snapshot.marketCapUsd' };
    if (Number.isFinite(mcapFromPairMcap) && mcapFromPairMcap > 0) return { value: mcapFromPairMcap, source: 'pair.marketCap' };
    if (Number.isFinite(mcapFromPairFdv) && mcapFromPairFdv > 0) return { value: mcapFromPairFdv, source: 'pair.fdv' };
    return { value: null, source: 'missing' };
  };
  let { value: mcapHot, source: mcapSourceUsed } = resolveMcapHot();
  ctx.mcapHot = mcapHot;
  ctx.mcapSourceUsed = mcapSourceUsed;

  if (!(mcapHot > 0)) {
    const enriched = await tryHotEnrichedRefresh('mcapMissing');
    snapshot = ctx.snapshot;
    pair = ctx.pair;
    if (enriched) {
      ({ value: mcapHot, source: mcapSourceUsed } = resolveMcapHot());
      if (mcapHot > 0) counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
      else counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
    }

    if (!(mcapHot > 0)) {
      if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
        row.meta.hotMomentumBypassMcapMissingAllowedAtMs = nowMs;
        mcapHot = null;
      } else {
        counters.watchlist.hotDeferredMissingMcap = Number(counters.watchlist.hotDeferredMissingMcap || 0) + 1;
        row.meta ||= {};
        row.meta.hotMcapDeferredAtMs = nowMs;
        row.meta.hotMcapDeferredRetries = Number(row.meta.hotMcapDeferredRetries || 0) + 1;

        const refreshStartMs = Date.now();
        for (let i = 0; i < mcapRefreshRetries; i++) {
          if ((Date.now() - refreshStartMs) > mcapRefreshWindowMs) break;
          try {
            if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
              const bird = await birdseye.getTokenSnapshot(mint);
              const birdSnap = snapshotFromBirdseye(bird, Date.now());
              if (birdSnap) {
                snapshot = birdSnap;
                row.snapshot = birdSnap;
                applySnapshotToLatest({ row, snapshot: birdSnap });
                ctx.snapshot = snapshot;
              }
            }
          } catch {}

          ({ value: mcapHot, source: mcapSourceUsed } = resolveMcapHot());
          if (mcapHot > 0) break;
          if (i < (mcapRefreshRetries - 1)) await new Promise((r) => setTimeout(r, mcapRefreshDelayMs));
        }

        if (!(mcapHot > 0)) {
          counters.watchlist.hotDeferredFailed = Number(counters.watchlist.hotDeferredFailed || 0) + 1;
          bumpPostBypassReject('mcapMissing');
          finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.mcapMissing', momentumCounterIncremented: false, confirmCounterIncremented: false });
          if (fail('mcapMissing', { stage: 'hot', cooldownMs: 30_000 }) === 'break') return 'break';
          return 'continue';
        }
        counters.watchlist.hotDeferredRecovered = Number(counters.watchlist.hotDeferredRecovered || 0) + 1;
      }
    }
  }
  ctx.mcapHot = mcapHot;
  ctx.mcapSourceUsed = mcapSourceUsed;

  counters.watchlist.hotMcapSourceUsed ||= {};
  counters.watchlist.hotMcapSourceUsed[mcapSourceUsed] = Number(counters.watchlist.hotMcapSourceUsed[mcapSourceUsed] || 0) + 1;
  if (mcapHot > 0) counters.watchlist.hotMcapNormalizedPresent = Number(counters.watchlist.hotMcapNormalizedPresent || 0) + 1;
  else counters.watchlist.hotMcapNormalizedMissing = Number(counters.watchlist.hotMcapNormalizedMissing || 0) + 1;

  let mcapFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
  if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
    const enriched = await tryHotEnrichedRefresh('staleData');
    snapshot = ctx.snapshot;
    if (enriched) {
      mcapFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? NaN);
      if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
        counters.watchlist.hotEnrichedRefreshFailed = Number(counters.watchlist.hotEnrichedRefreshFailed || 0) + 1;
      } else {
        counters.watchlist.hotEnrichedRefreshRecovered = Number(counters.watchlist.hotEnrichedRefreshRecovered || 0) + 1;
      }
    }
    if (Number.isFinite(mcapFreshnessMs) && mcapFreshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
      if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
        counters.watchlist.hotPostBypassAllowedStaleMcap = Number(counters.watchlist.hotPostBypassAllowedStaleMcap || 0) + 1;
      } else {
        bumpPostBypassReject('other');
        finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.mcapStaleData', momentumCounterIncremented: false, confirmCounterIncremented: false });
        if (fail('mcapStaleData', { stage: 'hot', cooldownMs: 30_000, meta: { mcapFreshnessMs } }) === 'break') return 'break';
        return 'continue';
      }
    }
  }

  function resolvePairCreatedAt({ pair, snapshot, row }) {
    const candidates = [
      { value: pair?.pairCreatedAt, source: 'pair.pairCreatedAt' },
      { value: snapshot?.pairCreatedAt, source: 'snapshot.pairCreatedAt' },
      { value: snapshot?.pair?.pairCreatedAt, source: 'snapshot.pair.pairCreatedAt' },
      { value: row?.latest?.pairCreatedAt, source: 'row.latest.pairCreatedAt' },
      { value: snapshot?.raw?.created_at ?? snapshot?.raw?.pair_created_at ?? snapshot?.pair?.birdeye?.created_at ?? snapshot?.pair?.created_at, source: 'snapshot.birdeyeCreated' },
    ];
    for (const c of candidates) {
      const n = normalizeEpochMs(c.value);
      if (n) return { pairCreatedAtMs: n, source: c.source };
    }
    return { pairCreatedAtMs: null, source: 'missing' };
  }
  row.meta ||= {};
  if (!row.meta.resolvedPairCreatedAt) row.meta.resolvedPairCreatedAt = {};
  let resolved = row.meta.resolvedPairCreatedAt;
  if (!resolved || resolved?.mint !== mint) {
    const r = resolvePairCreatedAt({ pair, snapshot, row });
    resolved = { mint, pairCreatedAtMs: r.pairCreatedAtMs, source: r.source, tMs: nowMs };
    row.meta.resolvedPairCreatedAt = resolved;
  }
  const pairCreatedAtForHolders = Number(resolved?.pairCreatedAtMs || 0) || null;
  const poolAgeSecForHolders = pairCreatedAtForHolders ? Math.max(0, (nowMs - pairCreatedAtForHolders) / 1000) : null;
  ctx.resolved = resolved;
  ctx.pairCreatedAtForHolders = pairCreatedAtForHolders;
  ctx.poolAgeSecForHolders = poolAgeSecForHolders;

  if (mcapHot != null && mcapHot < hotMinMcap) {
    bumpPostBypassReject('other');
    finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: `hot.mcapLow(<${Math.round(hotMinMcap)})`, momentumCounterIncremented: false, confirmCounterIncremented: false });
    if (fail(`mcapLow(<${Math.round(hotMinMcap)})`, { stage: 'hot', cooldownMs: 30_000 }) === 'break') return 'break';
    return 'continue';
  }
  if (!(poolAgeSecForHolders != null)) {
    const HOT_ALLOW_AGE_PENDING = !!cfg.HOT_ALLOW_AGE_PENDING;
    const HOT_AGE_PENDING_MAX_EVALS = Number(cfg.HOT_AGE_PENDING_MAX_EVALS || 3);
    const HOT_AGE_PENDING_MAX_MS = Number(cfg.HOT_AGE_PENDING_MAX_MS || 180000);
    const HOT_AGE_PENDING_COOLDOWN_MS = Number(cfg.HOT_AGE_PENDING_COOLDOWN_MS || 300000);

    const snapshotUsable = getSnapshotStatus({ snapshot, latest: row?.latest })?.usable ?? true;
    const liquidityPasses = Number(pair?.liquidity?.usd || snapshot?.liquidityUsd || row?.latest?.liqUsd || 0) >= 0;
    const dataFresh = Number(row?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? Infinity) <= Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000);
    const hardSafetyOk = !(row?.meta?.hardSafetyReject);

    if (row?.meta?.hotMomentumOnlyLiquidityBypass && Number(hotMinAgeHours || 0) <= 0) {
      counters.watchlist.hotPostBypassAllowedMissingAge = Number(counters.watchlist.hotPostBypassAllowedMissingAge || 0) + 1;
    } else if (HOT_ALLOW_AGE_PENDING && snapshotUsable && liquidityPasses && dataFresh && hardSafetyOk) {
      counters.watchlist.hotAgePendingAllowed = Number(counters.watchlist.hotAgePendingAllowed || 0) + 1;
      row.meta.agePendingHot ||= { tStartedMs: nowMs, evals: 0, lastEvalMs: nowMs };
      row.meta.agePendingHot.evals = Number(row.meta.agePendingHot.evals || 0) + 1;
      row.meta.agePendingHot.lastEvalMs = nowMs;
      counters.watchlist.momentumAgePendingSeen = Number(counters.watchlist.momentumAgePendingSeen || 0) + 1;
      row.meta.agePendingHot.status = 'allowed';
      if (Number(row.meta.agePendingHot.evals || 0) > HOT_AGE_PENDING_MAX_EVALS || (nowMs - Number(row.meta.agePendingHot.tStartedMs || nowMs)) > HOT_AGE_PENDING_MAX_MS) {
        row.meta.agePendingHot.status = 'expired';
        counters.watchlist.hotAgePendingExpired = Number(counters.watchlist.hotAgePendingExpired || 0) + 1;
        bumpPostBypassReject('agePendingExpired');
        if (fail('agePendingExpired', { stage: 'hot', cooldownMs: HOT_AGE_PENDING_COOLDOWN_MS }) === 'break') return 'break';
        return 'continue';
      }
    } else {
      bumpPostBypassReject('age');
      finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: 'hot.ageMissingForHot', momentumCounterIncremented: false, confirmCounterIncremented: false });
      if (fail('ageMissingForHot', { stage: 'hot', cooldownMs: 30_000 }) === 'break') return 'break';
      return 'continue';
    }
  } else if (Number(hotMinAgeHours || 0) > 0 && poolAgeSecForHolders < (hotMinAgeHours * 3600)) {
    bumpPostBypassReject('age');
    finalizeHotBypassTrace({ nextStageReached: 'hotGate', finalPreMomentumRejectReason: `hot.ageBelowHotMin(<${hotMinAgeHours}h)`, momentumCounterIncremented: false, confirmCounterIncremented: false });
    if (fail(`ageBelowHotMin(<${hotMinAgeHours}h)`, { stage: 'hot', cooldownMs: 30_000 }) === 'break') return 'break';
    return 'continue';
  }

  const holders = Number(snapshot?.entryHints?.participation?.holders ?? row?.latest?.holders ?? pair?.participation?.holders ?? 0) || null;
  const holdersGate = holdersGateCheck({ cfg, holders, poolAgeSec: poolAgeSecForHolders });
  if (!holdersGate.ok) {
    bumpPostBypassReject('holders');
    finalizeHotBypassTrace({ nextStageReached: 'holdersGate', finalPreMomentumRejectReason: `holders.${holdersGate.reason}`, momentumCounterIncremented: false, confirmCounterIncremented: false });
    if (fail(holdersGate.reason, { stage: 'holders', cooldownMs: 30_000 }) === 'break') return 'break';
    return 'continue';
  }

  const cachedAge = resolved?.pairCreatedAtMs ? null : getCachedMintCreatedAt({ state, mint, nowMs, maxAgeMs: 60 * 60_000 });
  if (!resolved?.pairCreatedAtMs && cachedAge?.createdAtMs) {
    row.latest ||= {};
    row.latest.pairCreatedAt = Number(cachedAge.createdAtMs);
    row.meta.resolvedPairCreatedAt = { mint, pairCreatedAtMs: Number(cachedAge.createdAtMs), source: String(cachedAge.source || 'cache.mintCreatedAt'), tMs: nowMs };
    ctx.resolved = row.meta.resolvedPairCreatedAt;
  } else if (!resolved?.pairCreatedAtMs) {
    scheduleMintCreatedAtLookup({
      state,
      mint,
      nowMs,
      minRetryMs: Number(cfg.MINT_AGE_LOOKUP_RETRY_MS || 30_000),
      lookupFn: () => ctx.deps.resolveMintCreatedAtFromRpc?.({ state, conn: ctx.conn, mint, nowMs: Date.now(), maxPages: 3 }),
    });
  }

  return 'next';
}
