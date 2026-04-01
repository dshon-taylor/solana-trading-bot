export async function runMomentumEvalStage(ctx) {
  const {
    cfg,
    state,
    counters,
    nowMs,
    mint,
    row,
    canaryLog,
    finalizeHotBypassTrace,
    fail,
    pushCompactWindowEvent,
    runtimeDeps,
  } = ctx;
  const {
    cache,
    evaluateMomentumSignal,
    paperComputeMomentumWindows,
    isMicroFreshEnough,
    applyMomentumPassHysteresis,
    getCachedMintCreatedAt,
    scheduleMintCreatedAtLookup,
    CORE_MOMO_CHECKS,
    canaryMomoShouldSample,
    recordCanaryMomoFailChecks,
    coreMomentumProgress,
    decideMomentumBranch,
    applySnapshotToLatest,
    buildNormalizedMomentumInput,
    nowIso,
  } = runtimeDeps;

  // Keep WS live for late-pipeline freshness (momentum/confirm/execution priority).
  try {
    cache.set(`birdeye:sub:${mint}`, true, Math.ceil(cfg.BIRDEYE_WATCHLIST_SUB_TTL_MS / 1000));
  } catch {}

  runtimeDeps.bumpWatchlistFunnel(counters, 'watchlistEvaluated', { nowMs });
  pushCompactWindowEvent('watchlistEvaluated');
  canaryLog('trigger', 'watchlistEvaluated');
  applySnapshotToLatest({ row, snapshot: ctx.snapshot });
  const liqUsd = Number(ctx.pair?.liquidity?.usd || ctx.snapshot?.liquidityUsd || row?.latest?.liqUsd || 0);
  ctx.liqUsd = liqUsd;
  pushCompactWindowEvent('stalkableSeen', null, { mint, liqUsd });
  const {
    normalized: momentumInput,
    presentFields: momentumInputPresentFields,
    sourceUsed: momentumInputSourceUsed,
    rawAvail: momentumRawAvail,
    microPresent: momentumMicroPresent,
    microSourceUsed: momentumMicroSourceUsed,
  } = buildNormalizedMomentumInput({ snapshot: ctx.snapshot, latest: row?.latest, pair: ctx.pair });
  ctx.momentumInput = momentumInput;
  ctx.momentumInputPresentFields = momentumInputPresentFields;
  ctx.momentumInputSourceUsed = momentumInputSourceUsed;
  ctx.momentumRawAvail = momentumRawAvail;
  ctx.momentumMicroPresent = momentumMicroPresent;
  ctx.momentumMicroSourceUsed = momentumMicroSourceUsed;
  counters.watchlist.momentumInputSourceUsed ||= {};
  counters.watchlist.momentumInputSourceUsed[momentumInputSourceUsed] = Number(counters.watchlist.momentumInputSourceUsed[momentumInputSourceUsed] || 0) + 1;
  if (momentumInputPresentFields >= 4) counters.watchlist.momentumInputCompletenessPresent = Number(counters.watchlist.momentumInputCompletenessPresent || 0) + 1;
  else counters.watchlist.momentumInputCompletenessMissing = Number(counters.watchlist.momentumInputCompletenessMissing || 0) + 1;
  counters.watchlist.momentumMicroSourceUsed ||= {};
  counters.watchlist.momentumMicroSourceUsed[momentumMicroSourceUsed] = Number(counters.watchlist.momentumMicroSourceUsed[momentumMicroSourceUsed] || 0) + 1;
  if (Number(momentumMicroPresent || 0) >= 3) counters.watchlist.momentumMicroFieldsPresent = Number(counters.watchlist.momentumMicroFieldsPresent || 0) + 1;
  else counters.watchlist.momentumMicroFieldsMissing = Number(counters.watchlist.momentumMicroFieldsMissing || 0) + 1;

  const useStrict = !cfg.AGGRESSIVE_MODE && liqUsd > 0 && liqUsd < cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD;
  const sig = evaluateMomentumSignal(momentumInput, { profile: cfg.MOMENTUM_PROFILE, strict: useStrict });
  ctx.sig = sig;
  const zeroSignalFallback = Number(sig?.reasons?.volume5m || 0) === 0
    && Number(sig?.reasons?.buySellRatio || 0) === 0
    && Number(sig?.reasons?.tx_1m || 0) === 0
    && Number(sig?.reasons?.price || sig?.reasons?.priceUsd || 0) === 0;
  if (zeroSignalFallback) counters.watchlist.momentumZeroSignalFallbackCount = Number(counters.watchlist.momentumZeroSignalFallbackCount || 0) + 1;

  const momentumLiqGuardrail = Number(sig?.reasons?.momentumLiqGuardrailUsd || 60000);
  counters.watchlist.momentumLiqGuardrail = momentumLiqGuardrail;
  if (liqUsd >= momentumLiqGuardrail) counters.watchlist.momentumLiqCandidatesAboveGuardrail = Number(counters.watchlist.momentumLiqCandidatesAboveGuardrail || 0) + 1;
  else counters.watchlist.momentumLiqCandidatesBelowGuardrail = Number(counters.watchlist.momentumLiqCandidatesBelowGuardrail || 0) + 1;
  pushCompactWindowEvent('momentumLiq', null, { liqUsd });
  counters.watchlist.momentumLiqBand ||= { lt30: 0, b30_40: 0, b40_50: 0, b30_50: 0, b50_75: 0, gte75: 0 };
  if (liqUsd < 30_000) counters.watchlist.momentumLiqBand.lt30 += 1;
  else if (liqUsd < 40_000) { counters.watchlist.momentumLiqBand.b30_40 += 1; counters.watchlist.momentumLiqBand.b30_50 += 1; }
  else if (liqUsd < 50_000) { counters.watchlist.momentumLiqBand.b40_50 += 1; counters.watchlist.momentumLiqBand.b30_50 += 1; }
  else if (liqUsd < 75_000) counters.watchlist.momentumLiqBand.b50_75 += 1;
  else counters.watchlist.momentumLiqBand.gte75 += 1;

  const canaryBypassActive = ctx.isCanary
    && cfg.CONVERSION_CANARY_MODE
    && cfg.CANARY_BYPASS_MOMENTUM
    && (!cfg.CANARY_BYPASS_MOMENTUM_UNTIL_ISO || (Date.parse(cfg.CANARY_BYPASS_MOMENTUM_UNTIL_ISO) > nowMs));

  let agePicked = { value: null, source: 'missing' };
  if (ctx.resolved?.pairCreatedAtMs) {
    agePicked = { value: Number(ctx.resolved.pairCreatedAtMs), source: String(ctx.resolved.source || 'resolved') };
  } else {
    const cachedAge = getCachedMintCreatedAt({ state, mint, nowMs, maxAgeMs: 60 * 60_000 });
    if (cachedAge?.createdAtMs) {
      row.latest ||= {};
      row.latest.pairCreatedAt = Number(cachedAge.createdAtMs);
      agePicked = { value: Number(cachedAge.createdAtMs), source: String(cachedAge.source || 'cache.mintCreatedAt') };
      row.meta.resolvedPairCreatedAt = { mint, pairCreatedAtMs: agePicked.value, source: agePicked.source, tMs: nowMs };
    } else {
      scheduleMintCreatedAtLookup({
        state,
        mint,
        nowMs,
        minRetryMs: Number(cfg.MINT_AGE_LOOKUP_RETRY_MS || 30_000),
        lookupFn: () => ctx.deps.resolveMintCreatedAtFromRpc?.({ state, conn: ctx.conn, mint, nowMs: Date.now(), maxPages: 3 }),
      });
      agePicked = { value: null, source: 'pending_rpc' };
    }
  }
  ctx.agePicked = agePicked;
  counters.watchlist.hotAgeSourceUsed ||= {};
  counters.watchlist.hotAgeSourceUsed[agePicked.source || 'missing'] = Number(counters.watchlist.hotAgeSourceUsed[agePicked.source || 'missing'] || 0) + 1;

  const momentumPairCreatedAt = agePicked.value;
  const tokenAgeMinutes = momentumPairCreatedAt ? Math.max(0, (nowMs - momentumPairCreatedAt) / 60_000) : null;
  const { agePresent, matureTokenMode, earlyTokenMode, breakoutBranchUsed } = decideMomentumBranch(tokenAgeMinutes);
  ctx.tokenAgeMinutes = tokenAgeMinutes;
  ctx.agePresent = agePresent;
  ctx.matureTokenMode = matureTokenMode;
  ctx.earlyTokenMode = earlyTokenMode;
  ctx.breakoutBranchUsed = breakoutBranchUsed;
  counters.watchlist.momentumAgePresent = Number(counters.watchlist.momentumAgePresent || 0) + (agePresent ? 1 : 0);
  counters.watchlist.momentumAgeMissing = Number(counters.watchlist.momentumAgeMissing || 0) + (agePresent ? 0 : 1);
  counters.watchlist.momentumAgeSourceUsed ||= {};
  counters.watchlist.momentumAgeSourceUsed[agePicked.source] = Number(counters.watchlist.momentumAgeSourceUsed[agePicked.source] || 0) + 1;
  counters.watchlist.momentumEarlyTokenModeCount = Number(counters.watchlist.momentumEarlyTokenModeCount || 0) + (earlyTokenMode ? 1 : 0);
  counters.watchlist.momentumMatureTokenModeCount = Number(counters.watchlist.momentumMatureTokenModeCount || 0) + (matureTokenMode ? 1 : 0);
  const fallbackMeta = sig?.reasons?.fallbackMeta || {};
  const txEffective1m = Number(sig?.reasons?.tx_1m || 0);
  const txEffective5m = Number(sig?.reasons?.tx_5m_avg || 0);
  const volumeEffective5m = Number(sig?.reasons?.volume_5m || 0);
  const volumeEffective30m = Number(sig?.reasons?.volume_30m_avg || 0);
  counters.watchlist.momentumPathUsage ||= {
    tx: { normal: 0, fallback: 0, missing: 0 },
    volume: { normal: 0, fallback: 0, missing: 0 },
  };
  const txBucket = (txEffective1m > 0 || txEffective5m > 0) ? (fallbackMeta?.tx ? 'fallback' : 'normal') : 'missing';
  const volumeBucket = (volumeEffective5m > 0 || volumeEffective30m > 0) ? (fallbackMeta?.volume ? 'fallback' : 'normal') : 'missing';
  counters.watchlist.momentumPathUsage.tx[txBucket] = Number(counters.watchlist.momentumPathUsage.tx[txBucket] || 0) + 1;
  counters.watchlist.momentumPathUsage.volume[volumeBucket] = Number(counters.watchlist.momentumPathUsage.volume[volumeBucket] || 0) + 1;

  const snapshotFreshnessMs = Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? NaN);
  const wsPxForMicro = cache.get(`birdeye:ws:price:${mint}`) || null;
  const wsTsForMicro = Number(wsPxForMicro?.tsMs || 0);
  const wsFreshnessMsForMicro = wsTsForMicro > 0 ? Math.max(0, nowMs - wsTsForMicro) : NaN;
  const freshnessForMicroGate = Number.isFinite(wsFreshnessMsForMicro)
    ? Math.min(wsFreshnessMsForMicro, snapshotFreshnessMs)
    : snapshotFreshnessMs;
  const freshnessSourceForMicroGate = Number.isFinite(wsFreshnessMsForMicro)
    ? (wsFreshnessMsForMicro <= snapshotFreshnessMs ? 'ws' : 'snapshot')
    : 'snapshot';
  const snapshotLagOverWsMs = Number.isFinite(snapshotFreshnessMs) && Number.isFinite(wsFreshnessMsForMicro)
    ? Math.max(0, snapshotFreshnessMs - wsFreshnessMsForMicro)
    : null;
  const baseMicroMaxAgeMs = Number(cfg.MOMENTUM_MICRO_MAX_AGE_MS || 10_000);
  const providerLagToleranceMs = Math.max(0, Number(process.env.MOMENTUM_MICRO_PROVIDER_LAG_TOLERANCE_MS || 20_000));
  const effectiveMicroMaxAgeMs = freshnessSourceForMicroGate === 'snapshot'
    ? (baseMicroMaxAgeMs + providerLagToleranceMs)
    : baseMicroMaxAgeMs;

  if (canaryBypassActive) {
    canaryLog('momentum', 'bypassed');
  } else {
    const dexFailedRaw = Array.isArray(sig?.reasons?.failedChecks) ? sig.reasons.failedChecks.map(String) : [];
    const dexFailed = earlyTokenMode
      ? dexFailedRaw.filter((x) => x !== 'volumeExpansion' && x !== 'txAcceleration')
      : dexFailedRaw;

    const paperSeries = state.paper?.series?.[mint] || null;
    const paperWin = paperComputeMomentumWindows(paperSeries, nowMs);
    const paperThresholds = {
      ret15: cfg.PAPER_ENTRY_RET_15M_PCT,
      ret5: cfg.PAPER_ENTRY_RET_5M_PCT,
      greensLast5: cfg.PAPER_ENTRY_GREEN_LAST5,
    };
    const paperFailed = [];
    if (paperWin.ret15 == null) paperFailed.push('ret15Missing');
    else if (paperWin.ret15 < paperThresholds.ret15) paperFailed.push('ret15Low');
    if (paperWin.ret5 == null) paperFailed.push('ret5Missing');
    else if (paperWin.ret5 < paperThresholds.ret5) paperFailed.push('ret5Low');
    if (Number(paperWin.greensLast5 || 0) < Number(paperThresholds.greensLast5 || 0)) paperFailed.push('greensLow');

    const microFreshGate = isMicroFreshEnough({
      microPresentCount: ctx.momentumMicroPresent,
      freshnessMs: freshnessForMicroGate,
      maxAgeMs: effectiveMicroMaxAgeMs,
      requireFreshMicro: !!cfg.MOMENTUM_REQUIRE_FRESH_MICRO,
      minPresentForGate: Number(cfg.MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE || 3),
    });

    let momentumGateOk = !!sig.ok && !!microFreshGate.ok;
    const combinedFailed = Array.from(new Set([
      ...dexFailed.map((x) => `dex.${x}`),
      ...(microFreshGate.ok ? [] : [`dex.${String(microFreshGate.reason || 'microStale')}`]),
    ]));

    const hysteresis = applyMomentumPassHysteresis({
      state,
      mint,
      nowMs,
      gatePassed: momentumGateOk,
      requiredStreak: Number(cfg.MOMENTUM_PASS_STREAK_REQUIRED || 1),
      streakResetMs: Number(cfg.MOMENTUM_PASS_STREAK_RESET_MS || (10 * 60_000)),
    });
    momentumGateOk = !!hysteresis.passed;
    if (hysteresis.warmup) combinedFailed.push('momentum.hysteresisWarmup');

    if (cfg.MOMENTUM_FILTER_ENABLED && !momentumGateOk) {
      const coreDexFailures = dexFailed.filter((x) => ['volumeExpansion', 'buyPressure', 'txAcceleration', 'walletExpansion'].includes(x));
      const breakoutSignalsFailed = coreDexFailures.length;
      const breakoutSignalsPassed = Math.max(0, 4 - breakoutSignalsFailed);
      counters.watchlist.momentumBreakoutSignalsPassed = Number(counters.watchlist.momentumBreakoutSignalsPassed || 0) + breakoutSignalsPassed;
      counters.watchlist.momentumBreakoutSignalsFailed = Number(counters.watchlist.momentumBreakoutSignalsFailed || 0) + breakoutSignalsFailed;

      recordCanaryMomoFailChecks({ state, nowMs, failedChecks: combinedFailed, windowMin: cfg.MOMENTUM_DIAG_WINDOW_MIN, enabled: ctx.isCanary });
      pushCompactWindowEvent('momentumFailChecks', null, { checks: combinedFailed, mint });

      counters.watchlist.momentumFailedChecksTop ||= {};
      counters.watchlist.momentumFailedMintsTop ||= {};
      counters.watchlist.momentumFailedCheckExamples ||= [];
      counters.watchlist.momentumFailedMintsTop[mint] = Number(counters.watchlist.momentumFailedMintsTop[mint] || 0) + 1;
      for (const chk of combinedFailed) {
        counters.watchlist.momentumFailedChecksTop[chk] = Number(counters.watchlist.momentumFailedChecksTop[chk] || 0) + 1;
      }
      counters.watchlist.momentumFailedCheckExamples.push({
        t: nowIso(),
        mint,
        checks: combinedFailed.slice(0, 8),
        observed: {
          dex: sig.reasons || null,
          paper: paperWin,
        },
        thresholds: {
          dex: sig.thresholds || null,
          paper: paperThresholds,
        },
        liquidityUsd: liqUsd,
        mcapValueSeenByHot: ctx.mcapHot,
        freshnessMs: Number(row?.latest?.marketDataFreshnessMs ?? ctx.snapshot?.freshnessMs ?? null),
        wsFreshnessMs: Number.isFinite(wsFreshnessMsForMicro) ? Number(wsFreshnessMsForMicro) : null,
        freshnessForMicroGateMs: Number.isFinite(freshnessForMicroGate) ? Number(freshnessForMicroGate) : null,
        freshnessSourceForMicroGate,
        snapshotLagOverWsMs: Number.isFinite(Number(snapshotLagOverWsMs)) ? Number(snapshotLagOverWsMs) : null,
        effectiveMicroMaxAgeMs,
        tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
        earlyTokenMode,
        breakoutBranchUsed,
        ageSource: agePicked.source,
      });
      if (counters.watchlist.momentumFailedCheckExamples.length > 20) {
        counters.watchlist.momentumFailedCheckExamples = counters.watchlist.momentumFailedCheckExamples.slice(-20);
      }
      counters.watchlist.momentumInputDebugLast ||= [];
      counters.watchlist.momentumInputDebugLast.push({
        t: nowIso(),
        mint,
        failedChecks: combinedFailed.slice(0, 8),
        raw: momentumRawAvail,
        normalizedUsed: {
          priceUsd: momentumInput?.priceUsd ?? null,
          liqUsd: momentumInput?.liquidity?.usd ?? null,
          mcapUsd: momentumInput?.marketCap ?? null,
          tx1m: momentumInput?.birdeye?.tx_1m ?? null,
          tx5mAvg: momentumInput?.birdeye?.tx_5m_avg ?? null,
          volume5m: momentumInput?.birdeye?.volume_5m ?? null,
          volume30mAvg: momentumInput?.birdeye?.volume_30m_avg ?? null,
          buySellRatio: momentumInput?.birdeye?.buySellRatio ?? null,
          rollingHigh5m: momentumInput?.birdeye?.rolling_high_5m ?? null,
        },
        tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
        earlyTokenMode,
        breakoutBranchUsed,
        ageSource: agePicked.source,
      });
      if (counters.watchlist.momentumInputDebugLast.length > 5) {
        counters.watchlist.momentumInputDebugLast = counters.watchlist.momentumInputDebugLast.slice(-5);
      }
      pushCompactWindowEvent('momentumInputSample', null, {
        mint,
        liq: Number(momentumInput?.liquidity?.usd || 0),
        v5: Number(sig?.reasons?.volume_5m ?? momentumInput?.birdeye?.volume_5m ?? 0),
        v30: Number(sig?.reasons?.volume_30m_avg ?? momentumInput?.birdeye?.volume_30m_avg ?? 0),
        volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
        volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
        volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
        bsr: Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0),
        walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
        buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
        buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
        tx1m: Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0),
        tx5mAvg: Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0),
        tx30mAvg: Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0),
        txThreshold: Number(cfg.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0),
        volThreshold: Number(cfg.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0),
        walletThreshold: Number(cfg.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25),
        hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
        fail: combinedFailed.join('|') || 'none',
      });
      pushCompactWindowEvent('momentumAgeSample', null, {
        mint,
        ageMin: tokenAgeMinutes,
        early: earlyTokenMode,
        source: agePicked.source,
        branch: breakoutBranchUsed,
        fail: combinedFailed.slice(0, 3).join('|') || 'none',
      });
      pushCompactWindowEvent('momentumRecent', null, {
        mint,
        liq: Number(liqUsd || 0),
        mcap: Number(ctx.mcapHot || 0),
        ageMin: tokenAgeMinutes,
        agePresent,
        freshnessMs: Number.isFinite(snapshotFreshnessMs) ? Number(snapshotFreshnessMs) : null,
        wsFreshnessMs: Number.isFinite(wsFreshnessMsForMicro) ? Number(wsFreshnessMsForMicro) : null,
        freshnessForMicroGateMs: Number.isFinite(freshnessForMicroGate) ? Number(freshnessForMicroGate) : null,
        freshnessSourceForMicroGate,
        snapshotLagOverWsMs: Number.isFinite(Number(snapshotLagOverWsMs)) ? Number(snapshotLagOverWsMs) : null,
        effectiveMicroMaxAgeMs,
        early: earlyTokenMode,
        branch: breakoutBranchUsed,
        v5: Number(sig?.reasons?.volume_5m || 0) || null,
        v30: Number(sig?.reasons?.volume_30m_avg || 0) || null,
        volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
        volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
        volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
        walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
        buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
        buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
        hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
        tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
        tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
        tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
        momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
        momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
        momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
        topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 3) : [],
        topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 3) : [],
        final: 'momentum.momentumFailed',
      });
      pushCompactWindowEvent('momentumScoreSample', null, {
        mint,
        momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
        momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
        momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'weak'),
        topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 5) : [],
        topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 5) : [],
        final: 'momentum.momentumFailed',
      });

      const coreFailedNow = combinedFailed.filter((x) => CORE_MOMO_CHECKS.includes(x)).sort();
      const progressNow = coreMomentumProgress(sig);
      const prevRepeat = state.runtime.momentumRepeatFail[mint] || null;
      let repeatSuppressed = false;
      let repeatReason = null;
      if (prevRepeat && coreFailedNow.length > 0) {
        const withinWindow = (nowMs - Number(prevRepeat.tMs || 0)) <= (ctx.repeatFailWindowSec * 1000);
        const prevCore = Array.isArray(prevRepeat.coreFailed) ? prevRepeat.coreFailed.slice().sort() : [];
        const sameCore = prevCore.length === coreFailedNow.length && prevCore.every((v, i) => v === coreFailedNow[i]);
        if (withinWindow && sameCore) {
          let improvedChecks = 0;
          for (const chk of coreFailedNow) {
            const prevV = Number(prevRepeat.progress?.[chk] || 0);
            const nowV = Number(progressNow?.[chk] || 0);
            if (nowV >= (prevV + ctx.repeatImprovementDelta)) improvedChecks += 1;
          }
          if (improvedChecks === 0) {
            repeatSuppressed = true;
            repeatReason = 'sameCoreNoImprovement';
            row.cooldownUntilMs = Math.max(Number(row.cooldownUntilMs || 0), nowMs + (ctx.repeatFailCooldownSec * 1000));
            counters.watchlist.momentumRepeatFailSuppressed = Number(counters.watchlist.momentumRepeatFailSuppressed || 0) + 1;
            counters.watchlist.momentumRepeatFailMintsTop ||= {};
            counters.watchlist.momentumRepeatFailReasonTop ||= {};
            counters.watchlist.momentumRepeatFailMintsTop[mint] = Number(counters.watchlist.momentumRepeatFailMintsTop[mint] || 0) + 1;
            counters.watchlist.momentumRepeatFailReasonTop[repeatReason] = Number(counters.watchlist.momentumRepeatFailReasonTop[repeatReason] || 0) + 1;
            pushCompactWindowEvent('repeatSuppressed', null, { mint, reason: repeatReason });
          }
        }
      }
      const hist = Array.isArray(prevRepeat?.suppressionHistoryMs) ? prevRepeat.suppressionHistoryMs.filter((ts) => (nowMs - Number(ts || 0)) <= (ctx.repeatEscalationWindowSec * 1000)) : [];
      if (repeatSuppressed) hist.push(nowMs);
      let appliedCooldownSec = repeatSuppressed ? ctx.repeatFailCooldownSec : 0;
      if (repeatSuppressed && hist.length >= ctx.repeatEscalationHits) {
        appliedCooldownSec = ctx.repeatEscalationCooldownSec;
        row.cooldownUntilMs = Math.max(Number(row.cooldownUntilMs || 0), nowMs + (ctx.repeatEscalationCooldownSec * 1000));
        counters.watchlist.momentumRepeatFailReasonTop.escalatedHoldout = Number(counters.watchlist.momentumRepeatFailReasonTop.escalatedHoldout || 0) + 1;
      }

      state.runtime.momentumRepeatFail[mint] = {
        tMs: nowMs,
        coreFailed: coreFailedNow,
        progress: progressNow,
        suppressionHistoryMs: hist,
      };

      const sampling = canaryMomoShouldSample({ state, nowMs, limitPerMin: cfg.CANARY_MOMO_FAIL_SAMPLE_PER_MIN });
      const meta = sampling.ok ? {
        momentum: {
          strict: useStrict,
          profile: cfg.MOMENTUM_PROFILE,
          freshnessGate: {
            ok: !!microFreshGate.ok,
            reason: String(microFreshGate.reason || 'unknown'),
            source: freshnessSourceForMicroGate,
            freshnessMs: Number.isFinite(freshnessForMicroGate) ? Number(freshnessForMicroGate) : null,
            wsFreshnessMs: Number.isFinite(wsFreshnessMsForMicro) ? Number(wsFreshnessMsForMicro) : null,
            snapshotFreshnessMs: Number.isFinite(snapshotFreshnessMs) ? Number(snapshotFreshnessMs) : null,
            snapshotLagOverWsMs: Number.isFinite(Number(snapshotLagOverWsMs)) ? Number(snapshotLagOverWsMs) : null,
            maxAgeMs: Number(effectiveMicroMaxAgeMs || 0),
          },
          hysteresis: {
            required: Number(hysteresis.required || 1),
            streak: Number(hysteresis.streak || 0),
            warmup: !!hysteresis.warmup,
          },
          liquidityBand: {
            liqUsd,
            lowLiqStrictUnderUsd: cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD,
            band: useStrict ? 'low' : 'normal',
          },
          dexscreener: {
            metrics: sig.reasons || null,
            thresholds: sig.thresholds || null,
          },
          paper: {
            windows: paperWin,
            thresholds: paperThresholds,
            failedChecks: paperFailed,
            seriesPoints: Array.isArray(paperSeries) ? paperSeries.length : 0,
          },
          failedChecks: combinedFailed,
        },
        sampled: { ok: true, limitPerMin: sampling.limitPerMin, usedThisMin: sampling.usedThisMin },
      } : {
        momentum: {
          strict: useStrict,
          profile: cfg.MOMENTUM_PROFILE,
          liquidityBand: { liqUsd, lowLiqStrictUnderUsd: cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD, band: useStrict ? 'low' : 'normal' },
          failedChecks: combinedFailed,
        },
        sampled: { ok: false, limitPerMin: sampling.limitPerMin, usedThisMin: sampling.usedThisMin },
      };

      finalizeHotBypassTrace({
        nextStageReached: 'momentum',
        finalPreMomentumRejectReason: 'momentum.momentumFailed',
        momentumCounterIncremented: false,
        confirmCounterIncremented: false,
        extra: {
          freshnessGate: {
            ok: !!microFreshGate.ok,
            reason: String(microFreshGate.reason || 'unknown'),
            source: freshnessSourceForMicroGate,
            freshnessMs: Number.isFinite(freshnessForMicroGate) ? Number(freshnessForMicroGate) : null,
            wsFreshnessMs: Number.isFinite(wsFreshnessMsForMicro) ? Number(wsFreshnessMsForMicro) : null,
            snapshotFreshnessMs: Number.isFinite(snapshotFreshnessMs) ? Number(snapshotFreshnessMs) : null,
            snapshotLagOverWsMs: Number.isFinite(Number(snapshotLagOverWsMs)) ? Number(snapshotLagOverWsMs) : null,
            maxAgeMs: Number(effectiveMicroMaxAgeMs || 0),
          },
          hysteresis: {
            required: Number(hysteresis.required || 1),
            streak: Number(hysteresis.streak || 0),
            warmup: !!hysteresis.warmup,
          },
          failedChecks: combinedFailed,
          thresholdValues: {
            dex: sig.thresholds || null,
            paper: paperThresholds,
          },
          observedMetrics: {
            dex: sig.reasons || null,
            paper: paperWin,
          },
          momentumRawAvailable: momentumRawAvail,
          momentumNormalizedUsed: {
            priceUsd: momentumInput?.priceUsd ?? null,
            liqUsd: momentumInput?.liquidity?.usd ?? null,
            mcapUsd: momentumInput?.marketCap ?? null,
            volume5m: momentumInput?.birdeye?.volume_5m ?? null,
            volume30mAvg: momentumInput?.birdeye?.volume_30m_avg ?? null,
            buySellRatio: momentumInput?.birdeye?.buySellRatio ?? null,
            tx1m: momentumInput?.birdeye?.tx_1m ?? null,
            tx5mAvg: momentumInput?.birdeye?.tx_5m_avg ?? null,
            rollingHigh5m: momentumInput?.birdeye?.rolling_high_5m ?? null,
          },
          repeatFailSuppressed: repeatSuppressed,
          repeatFailReason: repeatReason,
          repeatFailWindowSec: ctx.repeatFailWindowSec,
          repeatFailCooldownSecApplied: appliedCooldownSec,
          repeatFailEscalationHits: ctx.repeatEscalationHits,
          repeatFailEscalationWindowSec: ctx.repeatEscalationWindowSec,
          tokenAgeMinutes: Number.isFinite(tokenAgeMinutes) ? Number(tokenAgeMinutes.toFixed(2)) : null,
          earlyTokenMode,
          breakoutBranchUsed,
          ageSource: agePicked.source,
        },
      });
      if (fail('momentumFailed', { stage: 'momentum', meta }) === 'break') return 'break';
      return 'continue';
    }
  }

  runtimeDeps.bumpWatchlistFunnel(counters, 'momentumPassed', { nowMs });
  pushCompactWindowEvent('momentumPassed');

  try {
    state.runtime ||= {};
    state.runtime.requalifyAfterStopByMint ||= {};
    const requalifyBlock = state.runtime.requalifyAfterStopByMint[mint] || null;
    if (requalifyBlock) {
      const nowMsLocal = Date.now();
      const fastStopActive = !!requalifyBlock.fastStopActive;
      const holdUntilMs = Number(requalifyBlock.holdUntilMs || 0);
      const holdExpired = !fastStopActive || !Number.isFinite(holdUntilMs) || holdUntilMs <= 0 || nowMsLocal >= holdUntilMs;
      if (holdExpired) {
        delete state.runtime.requalifyAfterStopByMint[mint];
        counters.watchlist.requalifyClearedOnMomentumPass = Number(counters.watchlist.requalifyClearedOnMomentumPass || 0) + 1;
      }
    }
  } catch {}
  pushCompactWindowEvent('momentumAgeSample', null, {
    mint,
    ageMin: tokenAgeMinutes,
    early: earlyTokenMode,
    source: agePicked.source,
    branch: breakoutBranchUsed,
    fail: 'none',
  });
  const momentumUsedTx1m = Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0) || 0;
  const momentumUsedTx5mAvg = Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0) || 0;
  const momentumUsedTx30mAvg = Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0) || 0;
  const momentumUsedBuySellRatio = Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0) || 0;
  row.meta ||= {};
  row.meta.confirmTxCarry = {
    tx1m: momentumUsedTx1m,
    tx5mAvg: momentumUsedTx5mAvg,
    tx30mAvg: momentumUsedTx30mAvg,
    buySellRatio: momentumUsedBuySellRatio,
    atMs: nowMs,
    source: 'momentum.signal',
  };
  state.runtime ||= {};
  state.runtime.confirmTxCarryByMint ||= {};
  state.runtime.confirmTxCarryByMint[mint] = { ...row.meta.confirmTxCarry };
  ctx.deps.recordConfirmCarryTrace(state, mint, 'momentumPass', {
    carryPresent: true,
    carryTx1m: Number(row.meta.confirmTxCarry?.tx1m || 0) || null,
    carryTx5mAvg: Number(row.meta.confirmTxCarry?.tx5mAvg || 0) || null,
    carryTx30mAvg: Number(row.meta.confirmTxCarry?.tx30mAvg || 0) || null,
    carryBuySellRatio: Number(row.meta.confirmTxCarry?.buySellRatio || 0) || null,
    momentumSigTx1m: Number(sig?.reasons?.tx_1m || 0) || null,
    momentumSigTx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
    momentumSigTx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
    momentumSigBuySellRatio: Number(sig?.reasons?.buySellRatio || 0) || null,
    momentumInputTx1m: Number(momentumInput?.birdeye?.tx_1m || 0) || null,
    momentumInputTx5mAvg: Number(momentumInput?.birdeye?.tx_5m_avg || 0) || null,
    momentumInputTx30mAvg: Number(momentumInput?.birdeye?.tx_30m_avg || 0) || null,
    momentumInputBuySellRatio: Number(momentumInput?.birdeye?.buySellRatio || 0) || null,
    rowPath: `watchlist.mints.${mint}.meta.confirmTxCarry`,
    carryWriteBranchRan: true,
  });
  pushCompactWindowEvent('momentumInputSample', null, {
    mint,
    liq: Number(momentumInput?.liquidity?.usd || 0),
    v5: Number(sig?.reasons?.volume_5m ?? momentumInput?.birdeye?.volume_5m ?? 0),
    v30: Number(sig?.reasons?.volume_30m_avg ?? momentumInput?.birdeye?.volume_30m_avg ?? 0),
    volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
    volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
    volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
    bsr: Number(sig?.reasons?.buySellRatio ?? momentumInput?.birdeye?.buySellRatio ?? 0),
    walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
    buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
    buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
    tx1m: Number(sig?.reasons?.tx_1m ?? momentumInput?.birdeye?.tx_1m ?? 0),
    tx5mAvg: Number(sig?.reasons?.tx_5m_avg ?? momentumInput?.birdeye?.tx_5m_avg ?? 0),
    tx30mAvg: Number(sig?.reasons?.tx_30m_avg ?? momentumInput?.birdeye?.tx_30m_avg ?? 0),
    txThreshold: Number(cfg.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0),
    volThreshold: Number(cfg.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0),
    walletThreshold: Number(cfg.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25),
    hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
    fail: 'none',
  });
  pushCompactWindowEvent('momentumRecent', null, {
    mint,
    liq: Number(liqUsd || 0),
    mcap: Number(ctx.mcapHot || 0),
    ageMin: tokenAgeMinutes,
    agePresent,
    freshnessMs: Number.isFinite(snapshotFreshnessMs) ? Number(snapshotFreshnessMs) : null,
    wsFreshnessMs: Number.isFinite(wsFreshnessMsForMicro) ? Number(wsFreshnessMsForMicro) : null,
    freshnessForMicroGateMs: Number.isFinite(freshnessForMicroGate) ? Number(freshnessForMicroGate) : null,
    freshnessSourceForMicroGate,
    snapshotLagOverWsMs: Number.isFinite(Number(snapshotLagOverWsMs)) ? Number(snapshotLagOverWsMs) : null,
    effectiveMicroMaxAgeMs,
    early: earlyTokenMode,
    branch: breakoutBranchUsed,
    v5: Number(sig?.reasons?.volume_5m || 0) || null,
    v30: Number(sig?.reasons?.volume_30m_avg || 0) || null,
    volStrength: (Number(sig?.reasons?.volume_30m_avg || 0) > 0) ? (Number(sig?.reasons?.volume_5m || 0) / Number(sig?.reasons?.volume_30m_avg || 1)) : null,
    volumeSource: String(sig?.reasons?.fallbackMeta?.volumeSource || 'unknown'),
    volumeFallback: !!sig?.reasons?.fallbackMeta?.volume,
    walletExpansion: Number.isFinite(Number(sig?.reasons?.walletExpansion)) ? Number(sig.reasons.walletExpansion) : null,
    buyers1m: Number.isFinite(Number(sig?.reasons?.uniqueBuyers1m)) ? Number(sig.reasons.uniqueBuyers1m) : null,
    buyers5mAvg: Number.isFinite(Number(sig?.reasons?.uniqueBuyers5mAvg)) ? Number(sig.reasons.uniqueBuyers5mAvg) : null,
    hardRejects: Array.isArray(sig?.reasons?.hardRejects) ? sig.reasons.hardRejects.slice(0, 6) : [],
    tx1m: Number(sig?.reasons?.tx_1m || 0) || null,
    tx5mAvg: Number(sig?.reasons?.tx_5m_avg || 0) || null,
    tx30mAvg: Number(sig?.reasons?.tx_30m_avg || 0) || null,
    momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
    momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
    momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
    topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 3) : [],
    topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 3) : [],
    final: 'momentum.passed',
  });
  pushCompactWindowEvent('momentumScoreSample', null, {
    mint,
    momentumScore: Number(sig?.reasons?.momentumScore ?? sig?.reasons?.momentumDiagnostics?.finalScore ?? 0) || 0,
    momentumScoreThreshold: Number(sig?.reasons?.momentumScoreThreshold ?? cfg.MOMENTUM_SCORE_PASS_THRESHOLD ?? 60),
    momentumScoreBand: String(sig?.reasons?.momentumScoreBand || 'pass'),
    topScoreContributors: Array.isArray(sig?.reasons?.topScoreContributors) ? sig.reasons.topScoreContributors.slice(0, 5) : [],
    topPenaltyContributors: Array.isArray(sig?.reasons?.topPenaltyContributors) ? sig.reasons.topPenaltyContributors.slice(0, 5) : [],
    final: 'momentum.passed',
  });
  if (row?.meta?.hotMomentumOnlyLiquidityBypass) {
    counters.watchlist.hotLiqBypassReachedMomentum = Number(counters.watchlist.hotLiqBypassReachedMomentum || 0) + 1;
    counters.watchlist.hotPostBypassReachedMomentum = Number(counters.watchlist.hotPostBypassReachedMomentum || 0) + 1;
    if (ctx.hotBypassTraceCtx) ctx.hotBypassTraceCtx._momentumPassed = true;
  }
  if (ctx.enrichedRefreshUsed && ctx.wasRouteAvailableOnly) {
    counters.watchlist.hotEnrichedRouteOnlyReachedMomentum = Number(counters.watchlist.hotEnrichedRouteOnlyReachedMomentum || 0) + 1;
  }
  ctx.momentumPassedThisEval = true;
  if (row?.meta?.preRunner?.taggedAtMs) {
    counters.watchlist.preRunnerReachedMomentum = Number(counters.watchlist.preRunnerReachedMomentum || 0) + 1;
    counters.watchlist.preRunnerLast10 ||= [];
    for (let i = counters.watchlist.preRunnerLast10.length - 1; i >= 0; i -= 1) {
      if (counters.watchlist.preRunnerLast10[i]?.mint === mint) {
        counters.watchlist.preRunnerLast10[i].finalStageReached = 'momentum';
        break;
      }
    }
  }
  if (row?.meta?.burst?.taggedAtMs) {
    counters.watchlist.burstReachedMomentum = Number(counters.watchlist.burstReachedMomentum || 0) + 1;
    counters.watchlist.burstLast10 ||= [];
    for (let i = counters.watchlist.burstLast10.length - 1; i >= 0; i -= 1) {
      if (counters.watchlist.burstLast10[i]?.mint === mint) {
        counters.watchlist.burstLast10[i].finalStageReached = 'momentum';
        break;
      }
    }
  }
  canaryLog('momentum', 'passed');
  counters.watchlist.triggerHits += 1;
  row.lastTriggerHitAtMs = nowMs;
  row.staleCycles = 0;

  return 'next';
}
