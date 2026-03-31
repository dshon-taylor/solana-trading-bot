export async function processProbeShortlistEntries({
  deps,
  cfg,
  state,
  t,
  solUsdNow,
  sol,
  counters,
  probeShortlist,
  probeEnabled,
  executionAllowed,
}) {
  const {
    nowIso,
    normalizeCandidateSource,
    bumpSourceCounter,
    entryCapacityAvailable,
    bump,
    logCandidateDaily,
    getEntrySnapshotUnsafeReason,
    markMarketDataRejectImpact,
    pushDebug,
    holdersGateCheck,
    passesBaseFilters,
    getRugcheckReport,
    isTokenSafe,
    computeMcapUsd,
    evaluateMomentumSignal,
    canUseMomentumFallback,
    toBaseUnits,
    DECIMALS,
    getRouteQuoteWithFallback,
    getModels,
    preprocessCandidate,
    appendCost,
    estimateCostUsd,
    analyzeTrade,
    jupQuote,
    gatekeep,
    canOpenNewEntry,
    applySoftReserveToUsdTarget,
    confirmQualityGate,
    ensureWatchlistState,
    bumpWatchlistFunnel,
    enforceEntryCapacityGate,
    openPosition,
    didEntryFill,
    recordEntryOpened,
    saveState,
    birdseye,
    conn,
    wallet,
    safeMsg,
    recordPlaybookError,
    isPaperModeActive,
  } = deps;

  const paperModeActive = isPaperModeActive({ state, cfg, nowMs: t });

  for (const { tok, mint, pair, snapshot } of probeShortlist) {
    counters.scanned++;
    const candidateSource = normalizeCandidateSource(tok?._source || 'dex');
    bumpSourceCounter(counters, candidateSource, 'considered');
    if (executionAllowed && cfg.SCANNER_ENTRIES_ENABLED && !entryCapacityAvailable(state, cfg)) break;

    if (state.positions[mint]?.status === 'open') {
      bump(counters, 'reject.alreadyOpen');
      continue;
    }

    counters.consideredPairs++;
    counters.funnel.signals += 1;
    if (probeEnabled) counters.funnel.probeShortlist += 1;

    // Candidate ledger baseline (log once per candidate with final outcome)
    const createdAt = Number(pair?.pairCreatedAt || 0);
    const ageHours = createdAt ? (Date.now() - createdAt) / 1000 / 3600 : null;
    const liqUsd0 = Number(pair?.liquidity?.usd || 0);
    const v1h0 = Number(pair?.volume?.h1 || 0);
    const v4h0 = Number(pair?.volume?.h4 || 0);
    const buys1h0 = Number(pair?.txns?.h1?.buys || 0);
    const sells1h0 = Number(pair?.txns?.h1?.sells || 0);
    const tx1h0 = buys1h0 + sells1h0;
    const pc1h0 = Number(pair?.priceChange?.h1 || 0);
    const pc4h0 = Number(pair?.priceChange?.h4 || 0);

    const baseEvent = {
      t: nowIso(),
      bot: 'candle-carl',
      mint,
      symbol: pair?.baseToken?.symbol || tok?.tokenSymbol || null,
      source: tok?._source || 'dex',
      marketDataSource: snapshot?.source || null,
      marketDataFreshnessMs: snapshot?.freshnessMs ?? null,
      marketDataConfidence: snapshot?.confidence || null,
      priceUsd: Number(snapshot?.priceUsd || pair?.priceUsd || 0) || null,
      liqUsd: liqUsd0,
      ageHours,
      mcapUsd: null,
      rugScore: null,
      v1h: v1h0,
      v4h: v4h0,
      buys1h: buys1h0,
      sells1h: sells1h0,
      tx1h: tx1h0,
      pc1h: pc1h0,
      pc4h: pc4h0,
      outcome: null,
      reason: null,
    };

    const entryUnsafeReason = getEntrySnapshotUnsafeReason(snapshot);
    if (entryUnsafeReason) {
      bump(counters, 'reject.baseFilters');
      markMarketDataRejectImpact(state, snapshot?.source);
      pushDebug(state, {
        t: nowIso(),
        mint,
        symbol: pair?.baseToken?.symbol,
        reason: `marketData(${entryUnsafeReason} src=${snapshot?.source} conf=${snapshot?.confidence} freshMs=${snapshot?.freshnessMs})`,
      });
      logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: `marketData(${entryUnsafeReason})` } });
      continue;
    }

    const holders = Number(snapshot?.entryHints?.participation?.holders ?? pair?.participation?.holders ?? tok?.holders ?? 0) || null;
    const pairCreatedAtForHolders = Number(pair?.pairCreatedAt || 0) || null;
    const poolAgeSecForHolders = pairCreatedAtForHolders ? Math.max(0, (Date.now() - pairCreatedAtForHolders) / 1000) : null;
    const holdersGate = holdersGateCheck({ cfg, holders, poolAgeSec: poolAgeSecForHolders });
    if (!holdersGate.ok) {
      bump(counters, 'reject.baseFilters');
      pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: holdersGate.reason, holders, poolAgeSec: poolAgeSecForHolders, requiredHolders: holdersGate.required });
      logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: holdersGate.reason } });
      continue;
    }

    // Pass 1: always persist candidate capture once it reaches evaluation,
    // regardless of execution gate state.
    logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'seen', reason: 'evaluated' } });

    if (state.positions[mint]?.status === 'open') {
      bump(counters, 'reject.alreadyOpen');
      logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: 'alreadyOpen' } });
      continue;
    }

    const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
    const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;

    const base = passesBaseFilters({
      pair,
      // Only enforce absolute floor here; ratio check happens after mcap is known.
      minLiquidityUsd: effLiqFloor,
      minAgeHours: effMinAge,
    });
    if (cfg.BASE_FILTERS_ENABLED && !base.ok) {
      bump(counters, 'reject.baseFilters');
      pushDebug(state, {
        t: nowIso(),
        mint,
        symbol: pair?.baseToken?.symbol,
        reason: `baseFilters(${base.reason})`,
        liqUsd: pair?.liquidity?.usd,
        createdAt: pair?.pairCreatedAt,
      });
      logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: `baseFilters(${base.reason})` } });
      continue;
    }

    let report = null;
    if (cfg.RUGCHECK_ENABLED) {
      try {
        report = await getRugcheckReport(mint);
      } catch {
        bump(counters, 'reject.rugcheckFetch');
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'rugcheckFetch(failed)' });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, outcome: 'reject', reason: 'rugcheckFetch(failed)' } });
        continue;
      }
      const safe = isTokenSafe(report);
      if (!safe.ok) {
        bump(counters, 'reject.rugUnsafe');
        pushDebug(state, {
          t: nowIso(),
          mint,
          symbol: pair?.baseToken?.symbol,
          reason: `rugUnsafe(${safe.reason})`,
          rugScore: report?.score_normalised,
          mintAuthority: !!report?.mintAuthority,
          freezeAuthority: !!report?.freezeAuthority,
        });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, outcome: 'reject', reason: `rugUnsafe(${safe.reason})` } });
        continue;
      }
    }

    // Market cap gate (optional)
    let mcap = { ok: true, reason: 'skipped', mcapUsd: null, decimals: null };
    if (cfg.MCAP_FILTER_ENABLED || cfg.LIQ_RATIO_FILTER_ENABLED) {
      try {
        mcap = await computeMcapUsd(cfg, pair, cfg.SOLANA_RPC_URL);
      } catch {
        bump(counters, 'reject.mcapFetch');
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'mcapFetch(failed)' });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, outcome: 'reject', reason: 'mcapFetch(failed)' } });
        continue;
      }
    }

    const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
    if (cfg.MCAP_FILTER_ENABLED) {
      if (!mcap.ok || !mcap.mcapUsd || mcap.mcapUsd < effMinMcap) {
        bump(counters, 'reject.mcapLowOrMissing');
        pushDebug(state, {
          t: nowIso(),
          mint,
          symbol: pair?.baseToken?.symbol,
          reason: `mcap(${mcap.reason})`,
          mcapUsd: mcap.mcapUsd,
          minMcapUsd: effMinMcap,
        });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `mcap(<${effMinMcap})` } });
        continue;
      }
    }

    // Dynamic liquidity requirement: liq >= max(floor, ratio * mcap)
    const liqUsd = Number(pair?.liquidity?.usd || 0);
    const effRatio = state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO;
    const reqLiq = Math.max(effLiqFloor, effRatio * (mcap?.mcapUsd || 0));
    if (cfg.LIQ_RATIO_FILTER_ENABLED && liqUsd < reqLiq) {
      bump(counters, 'reject.baseFilters');
      pushDebug(state, {
        t: nowIso(),
        mint,
        symbol: pair?.baseToken?.symbol,
        reason: `liq<req (liq=${Math.round(liqUsd)} req=${Math.round(reqLiq)} ratio=${effRatio})`,
        liqUsd,
        mcapUsd: mcap.mcapUsd,
      });
      logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `liq<req (liq=${Math.round(liqUsd)} req=${Math.round(reqLiq)} ratio=${effRatio})` } });
      continue;
    }

    // Two-tier momentum: thinner liquidity requires stricter confirmation.
    const useStrict = !cfg.AGGRESSIVE_MODE && liqUsd > 0 && liqUsd < cfg.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD;
    const sig = evaluateMomentumSignal(pair, { profile: cfg.MOMENTUM_PROFILE, strict: useStrict });
    const momentumLiqGuardrail = Number(sig?.reasons?.momentumLiqGuardrailUsd || 60000);
    counters.watchlist.momentumLiqGuardrail = momentumLiqGuardrail;
    if (liqUsd >= momentumLiqGuardrail) counters.watchlist.momentumLiqCandidatesAboveGuardrail = Number(counters.watchlist.momentumLiqCandidatesAboveGuardrail || 0) + 1;
    else counters.watchlist.momentumLiqCandidatesBelowGuardrail = Number(counters.watchlist.momentumLiqCandidatesBelowGuardrail || 0) + 1;
    let signalTrigger = 'standard';
    if (cfg.MOMENTUM_FILTER_ENABLED && !sig.ok) {
      let fallbackUsed = false;
      if (cfg.MOMENTUM_FALLBACK_ENABLED && canUseMomentumFallback(sig, { tolerance: cfg.MOMENTUM_FALLBACK_TOLERANCE })) {
        const tx1hFallback = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
        const strongLiq = liqUsd >= cfg.MOMENTUM_FALLBACK_MIN_LIQ_USD;
        const strongTx = tx1hFallback >= cfg.MOMENTUM_FALLBACK_MIN_TX1H;
        if (strongLiq && strongTx) {
          try {
            const probeLamports = toBaseUnits((Math.max(1, cfg.JUP_PREFILTER_AMOUNT_USD) / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
            const fallbackRoute = await getRouteQuoteWithFallback({
              cfg,
              mint,
              amountLamports: probeLamports,
              slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
              solUsdNow,
              source: 'momentum-fallback',
            });
            const routeableFallback = !!fallbackRoute.routeAvailable;
            if (routeableFallback) {
              fallbackUsed = true;
              signalTrigger = 'fallback';
              counters.funnel.signalFallbackPass += 1;
            }
          } catch {
            // keep hard reject path below
          }
        }
      }

      if (!fallbackUsed) {
        bump(counters, 'reject.momentum');
        pushDebug(state, {
          t: nowIso(),
          mint,
          symbol: pair?.baseToken?.symbol,
          reason: 'momentum(false)',
          v1h: sig.reasons?.v1h,
          v4h: sig.reasons?.v4h,
          buys1h: sig.reasons?.buys1h,
          sells1h: sig.reasons?.sells1h,
          pc1h: sig.reasons?.pc1h,
          pc4h: sig.reasons?.pc4h,
          tx1h: sig.reasons?.tx1h,
        });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: `momentum(false)${useStrict ? '[strict]' : ''}` } });
        continue;
      }
    }

    // Optional Social proxy: require some metadata link/desc
    if (cfg.REQUIRE_SOCIAL_META) {
      if (!tok.description && !tok.links && !tok.url) {
        bump(counters, 'reject.noSocialMeta');
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'noSocialMeta' });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: 'noSocialMeta' } });
        continue;
      }
    }

    try {
      const candidate = {
        mint,
        symbol: pair?.baseToken?.symbol,
        priceUsd: Number(pair?.priceUsd || 0),
        liqUsd,
        mcapUsd: mcap.mcapUsd,
        ageHours: (Date.now() - Number(pair?.pairCreatedAt || Date.now())) / 1000 / 3600,
        rugScore: report?.score_normalised,
        momentum: sig.reasons,
        signalTrigger,
        filters: {
          liqFloor: effLiqFloor,
          liqRatio: effRatio,
          minMcap: effMinMcap,
          minAge: effMinAge,
        },
      };

      // If AI pipeline is disabled, trade purely on deterministic filters + momentum.
      let sizeMultiplier = 1;
      let slippageBps = cfg.DEFAULT_SLIPPAGE_BPS;
      let pre = null;
      let analysis = null;

      if (cfg.AI_PIPELINE_ENABLED) {
        const models = getModels(cfg, state);

        const preRes = await preprocessCandidate({ model: models.preprocess, candidate });
        appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
          t: nowIso(), bot: 'candle-carl', op: 'preprocess', model: models.preprocess,
          inputTokens: preRes.usage?.input_tokens ?? null,
          outputTokens: preRes.usage?.output_tokens ?? null,
          costUsd: estimateCostUsd({ model: models.preprocess, inputTokens: preRes.usage?.input_tokens || 0, outputTokens: preRes.usage?.output_tokens || 0 }),
        }});
        pre = preRes.json;

        const analysisRes = await analyzeTrade({
          model: models.analyze,
          context: {
            candidate,
            preprocess: pre,
            openPositions: Object.values(state.positions || {}).filter(p => p.status === 'open').length,
            equityHintUsd: state.portfolio?.maxEquityUsd,
          },
        });
        appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
          t: nowIso(), bot: 'candle-carl', op: 'analyze', model: models.analyze,
          inputTokens: analysisRes.usage?.input_tokens ?? null,
          outputTokens: analysisRes.usage?.output_tokens ?? null,
          costUsd: estimateCostUsd({ model: models.analyze, inputTokens: analysisRes.usage?.input_tokens || 0, outputTokens: analysisRes.usage?.output_tokens || 0 }),
        }});
        analysis = analysisRes.json;

        if (String(analysis.decision).toUpperCase() !== 'TRADE') {
          const why = `ai(NO_TRADE:${analysis.note || ''})`;
          pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
          logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
          continue;
        }

        sizeMultiplier = analysis.sizeMultiplier;
        slippageBps = analysis.slippageBps;
      }

      const usdTarget = cfg.MAX_POSITION_USDC * sizeMultiplier;
      const usdTargetCapped = Math.min(cfg.MAX_POSITION_USDC * 1.1, Math.max(cfg.MAX_POSITION_USDC * 0.1, usdTarget));

      // Gatekeeper (AI) gets the quote before signing.
      // NOTE: Intentionally Jupiter-only — this is an execution quote for priceImpact/outAmount display,
      // not a routeability check. The alt-route fallback (getRouteQuoteWithFallback) is used upstream
      // in the scanner pipeline; swap execution always uses Jupiter directly.
      const solLamports = toBaseUnits((usdTargetCapped / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
      const quote = await jupQuote({
        inputMint: cfg.SOL_MINT,
        outputMint: mint,
        amount: solLamports,
        slippageBps,
      });

      // Execution sanity checks (don’t enter if quote is awful)
      const route0 = quote;
      const pi = Number(route0?.priceImpactPct || 0);
      if (pi && pi > cfg.MAX_PRICE_IMPACT_PCT) {
        const why = `quote(priceImpact>${cfg.MAX_PRICE_IMPACT_PCT}%)`;
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
        logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
        continue;
      }

      // If AI pipeline is enabled, run final gatekeeper before signing.
      let finalUsdTarget = usdTargetCapped;
      let finalSlip = slippageBps;

      if (cfg.AI_PIPELINE_ENABLED) {
        const models = getModels(cfg, state);

        const gkRes = await gatekeep({
          model: models.gatekeeper,
          context: {
            candidate,
            preprocess: pre,
            analysis,
            quoteSummary: {
              inAmount: solLamports,
              outAmount: quote?.outAmount,
              priceImpactPct: quote?.priceImpactPct,
              routeLabel: quote?.routePlan?.[0]?.swapInfo?.label || null,
            },
          },
        });
        appendCost({ ledgerPath: cfg.LEDGER_PATH, event: {
          t: nowIso(), bot: 'candle-carl', op: 'gatekeeper', model: models.gatekeeper,
          inputTokens: gkRes.usage?.input_tokens ?? null,
          outputTokens: gkRes.usage?.output_tokens ?? null,
          costUsd: estimateCostUsd({ model: models.gatekeeper, inputTokens: gkRes.usage?.input_tokens || 0, outputTokens: gkRes.usage?.output_tokens || 0 }),
        }});
        const gk = gkRes.json;

        if (String(gk.decision).toUpperCase() !== 'APPROVE') {
          const why = `gatekeeper(REJECT:${gk.note || ''})`;
          pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: why });
          logCandidateDaily({ dir: cfg.CANDIDATE_LEDGER_DIR, retentionDays: cfg.CANDIDATE_LEDGER_RETENTION_DAYS, event: { ...baseEvent, rugScore: report?.score_normalised ?? null, mcapUsd: mcap?.mcapUsd ?? null, outcome: 'reject', reason: why } });
          continue;
        }

        finalUsdTarget = Math.min(cfg.MAX_POSITION_USDC * 1.1, cfg.MAX_POSITION_USDC * gk.sizeMultiplier);
        finalSlip = gk.slippageBps;
      }

      // Capital guardrail #1: max new entries/hour throttle.
      const throttle = canOpenNewEntry({
        state,
        nowMs: t,
        maxNewEntriesPerHour: cfg.MAX_NEW_ENTRIES_PER_HOUR,
      });
      if (!throttle.ok) {
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: throttle.reason });
        continue;
      }

      // Capital guardrail #2: soft reserve (fees + reserve + retry buffer).
      const softReserve = applySoftReserveToUsdTarget({
        solBalance: sol,
        solUsd: solUsdNow,
        usdTarget: finalUsdTarget,
        minSolForFees: cfg.MIN_SOL_FOR_FEES,
        softReserveSol: cfg.CAPITAL_SOFT_RESERVE_SOL,
        retryBufferPct: cfg.CAPITAL_RETRY_BUFFER_PCT,
      });
      if (!softReserve.ok || softReserve.adjustedUsdTarget < 1) {
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `capitalGuardrail(${softReserve.reason})` });
        continue;
      }

      finalUsdTarget = softReserve.adjustedUsdTarget;

      // Re-quote with final sizing right before execution.
      // NOTE: Intentionally Jupiter-only — must use a live Jupiter quote for the actual swap transaction.
      const solLamportsFinal = toBaseUnits((finalUsdTarget / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
      const quoteFinal = await jupQuote({
        inputMint: cfg.SOL_MINT,
        outputMint: mint,
        amount: solLamportsFinal,
        slippageBps: finalSlip,
      });
      const pi2 = Number(quoteFinal?.priceImpactPct || 0);
      const confirmMaxPi = probeEnabled ? cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT : cfg.MAX_PRICE_IMPACT_PCT;
      if (pi2 && pi2 > confirmMaxPi) {
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `quoteFinal(priceImpact>${confirmMaxPi}%)` });
        continue;
      }
      if (probeEnabled) {
        const liqConfirm = Number(pair?.liquidity?.usd || 0);
        if (!quoteFinal?.routePlan?.length || liqConfirm < cfg.LIVE_CONFIRM_MIN_LIQ_USD) {
          pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: 'confirmGate(route/liquidity)' });
          continue;
        }
      }
      const confirmGate = confirmQualityGate({ cfg, sigReasons: sig?.reasons || {}, snapshot });
      if (!confirmGate.ok) {
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: confirmGate.reason });
        continue;
      }
      counters.funnel.confirmPassed += 1;

      // Aggressive-only: if confirm gate passes, optionally force an immediate attempt (bounded + anti-thrash).
      let forcedAttempted = false;
      if (cfg.FORCE_ATTEMPT_POLICY_ACTIVE && executionAllowed) {
        counters.guardrails.forceAttempt.considered += 1;

        // State-backed rate limits (persist across restarts).
        state.forceAttemptPolicy ||= { mints: {}, global: { attempts1m: [] } };
        state.forceAttemptPolicy.mints ||= {};
        state.forceAttemptPolicy.global ||= { attempts1m: [] };
        state.forceAttemptPolicy.global.attempts1m ||= [];

        const wl = ensureWatchlistState(state);
        const wlRow = wl.mints?.[mint] || null;

        const nowMs = t;
        const pruneWindow = (arr, windowMs) => (Array.isArray(arr) ? arr.filter(x => Number(x || 0) > (nowMs - windowMs)) : []);

        const mintPolicy = state.forceAttemptPolicy.mints[mint] || { attempts1h: [], cooldownUntilMs: 0 };
        mintPolicy.attempts1h = pruneWindow(mintPolicy.attempts1h, 60 * 60_000);
        state.forceAttemptPolicy.global.attempts1m = pruneWindow(state.forceAttemptPolicy.global.attempts1m, 60_000);

        const effectiveCooldownUntil = Math.max(
          Number(wlRow?.cooldownUntilMs || 0),
          Number(mintPolicy.cooldownUntilMs || 0)
        );

        let blockReason = null;
        if (effectiveCooldownUntil > nowMs) {
          blockReason = 'mintCooldown';
        } else if (mintPolicy.attempts1h.length >= cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR) {
          blockReason = 'mintHourlyCap';
        } else if (state.forceAttemptPolicy.global.attempts1m.length >= cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE) {
          blockReason = 'globalMinuteCap';
        }

        if (blockReason) {
          if (blockReason === 'mintCooldown') {
            counters.guardrails.forceAttempt.blockedMintCooldown += 1;
            bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardMintCooldown' });
          } else if (blockReason === 'mintHourlyCap') {
            counters.guardrails.forceAttempt.blockedMintHourlyCap += 1;
            bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardMintHourlyCap' });
          } else if (blockReason === 'globalMinuteCap') {
            counters.guardrails.forceAttempt.blockedGlobalMinuteCap += 1;
            bumpWatchlistFunnel(counters, 'blockedByReason', { nowMs, blockedReason: 'forceGuardGlobalMinuteCap' });
          }
        } else {
          // Execute forced attempt.
          counters.guardrails.forceAttempt.executed += 1;
          counters.entryAttempts += 1;
          counters.funnel.attempts += 1;
          if (signalTrigger === 'fallback') counters.funnel.attemptsFromFallback += 1;
          else counters.funnel.attemptsFromStandard += 1;

          // Record policy accounting before signing to prevent loops on slow swaps.
          mintPolicy.attempts1h.push(nowMs);
          mintPolicy.cooldownUntilMs = nowMs + cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS;
          state.forceAttemptPolicy.mints[mint] = mintPolicy;
          state.forceAttemptPolicy.global.attempts1m.push(nowMs);

          if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: pair?.baseToken?.symbol, tag: 'scanner_forced' })) continue;
          const decimalsHintForAttempt = [
            mcap?.decimals,
            pair?.baseToken?.decimals,
            pair?.birdeye?.raw?.decimals,
          ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
          const entryRes = await openPosition(cfg, conn, wallet, state, solUsdNow, pair, mcap.mcapUsd, decimalsHintForAttempt, report, sig.reasons, {
            mint,
            tokenName: pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
            symbol: pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
            entrySnapshot: null,
            birdeyeEnabled: birdseye?.enabled,
            getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
            usdTarget: finalUsdTarget,
            slippageBps: finalSlip,
            expectedOutAmount: Number(quoteFinal?.outAmount || 0),
            expectedInAmount: Number(quoteFinal?.inAmount || 0),
            paperOnly: paperModeActive,
            // Apply the same stop/trailing rules as LIVE momo
            stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
            stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
            trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
            trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
          });

          if (entryRes?.blocked) {
            counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
            counters.guardrails.entryBlockedReasons ||= {};
            counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
            counters.guardrails.entryBlockedLast10 ||= [];
            counters.guardrails.entryBlockedLast10.push({
              t: nowIso(), mint, reason: String(entryRes?.reason || 'unknown'),
              pairBaseTokenAddress: String(entryRes?.meta?.pairBaseTokenAddress || pair?.baseToken?.address || ''),
              mintResolvedForDecimals: String(entryRes?.meta?.mintResolvedForDecimals || mint || ''),
              decimalsSource: String(entryRes?.meta?.decimalsSource || 'none'),
              decimalsSourcesTried: Array.isArray(entryRes?.meta?.decimalsSourcesTried) ? entryRes.meta.decimalsSourcesTried : [],
              missingLookup: Array.isArray(entryRes?.meta?.decimalsSourcesTried)
                ? (entryRes.meta.decimalsSourcesTried.filter((x) => !x?.ok).map((x) => String(x?.source || 'unknown')).join('>') || 'none')
                : 'none',
              finalMissingDecimalsReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`,
            });
            if (counters.guardrails.entryBlockedLast10.length > 10) counters.guardrails.entryBlockedLast10 = counters.guardrails.entryBlockedLast10.slice(-10);
            pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(blocked reason=${entryRes.reason}) forced=1` });
            saveState(cfg.STATE_PATH, state);
            continue;
          }

          counters.entrySuccesses += 1;
          counters.funnel.fills += 1;
          if (signalTrigger === 'fallback') counters.funnel.entriesFromFallback += 1;
          else counters.funnel.entriesFromStandard += 1;
          if (entryRes?.swapMeta?.attempted) {
            counters.retry.slippageRetryAttempted += 1;
            if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
            else counters.retry.slippageRetryFailed += 1;
          }
          recordEntryOpened({ state, nowMs: t });

          // Mirror watchlist-style cooldown tracking if the mint is present there.
          if (wlRow) {
            wlRow.lastAttemptAtMs = nowMs;
            wlRow.attempts = Number(wlRow.attempts || 0) + 1;
            wlRow.totalAttempts = Number(wlRow.totalAttempts || 0) + 1;
            wlRow.cooldownUntilMs = Math.max(Number(wlRow.cooldownUntilMs || 0), mintPolicy.cooldownUntilMs);
            if (didEntryFill(entryRes)) {
              wlRow.lastFillAtMs = nowMs;
              wlRow.totalFills = Number(wlRow.totalFills || 0) + 1;
            }
          }

          saveState(cfg.STATE_PATH, state);
          pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(opened${entryRes?.swapMeta?.attempted ? ` retry=${entryRes.swapMeta.reason}` : ''}) forced=1` });
          forcedAttempted = true;
        }
      }

      // Default behavior: attempt only when scanner entries are enabled.
      if (!forcedAttempted && cfg.SCANNER_ENTRIES_ENABLED && executionAllowed) {
        counters.entryAttempts += 1;
        counters.funnel.attempts += 1;
        if (signalTrigger === 'fallback') counters.funnel.attemptsFromFallback += 1;
        else counters.funnel.attemptsFromStandard += 1;
        if (!enforceEntryCapacityGate({ state, cfg, mint, symbol: pair?.baseToken?.symbol, tag: 'scanner_standard' })) continue;
        const decimalsHintForAttempt = [
          mcap?.decimals,
          pair?.baseToken?.decimals,
          pair?.birdeye?.raw?.decimals,
        ].map((x) => Number(x)).find((x) => Number.isInteger(x) && x >= 0) ?? null;
        const entryRes = await openPosition(cfg, conn, wallet, state, solUsdNow, pair, mcap.mcapUsd, decimalsHintForAttempt, report, sig.reasons, {
          mint,
          tokenName: pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
          symbol: pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
          entrySnapshot: null,
          birdeyeEnabled: birdseye?.enabled,
          getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
          usdTarget: finalUsdTarget,
          slippageBps: finalSlip,
          expectedOutAmount: Number(quoteFinal?.outAmount || 0),
          expectedInAmount: Number(quoteFinal?.inAmount || 0),
          paperOnly: paperModeActive,
          // Apply the same stop/trailing rules as LIVE momo
          stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
          stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
          trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
          trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
        });

        if (entryRes?.blocked) {
          counters.guardrails.entryBlocked = Number(counters.guardrails.entryBlocked || 0) + 1;
          counters.guardrails.entryBlockedReasons ||= {};
          counters.guardrails.entryBlockedReasons[entryRes.reason] = Number(counters.guardrails.entryBlockedReasons[entryRes.reason] || 0) + 1;
          counters.guardrails.entryBlockedLast10 ||= [];
          counters.guardrails.entryBlockedLast10.push({
            t: nowIso(), mint, reason: String(entryRes?.reason || 'unknown'),
            pairBaseTokenAddress: String(entryRes?.meta?.pairBaseTokenAddress || pair?.baseToken?.address || ''),
            mintResolvedForDecimals: String(entryRes?.meta?.mintResolvedForDecimals || mint || ''),
            decimalsSource: String(entryRes?.meta?.decimalsSource || 'none'),
            decimalsSourcesTried: Array.isArray(entryRes?.meta?.decimalsSourcesTried) ? entryRes.meta.decimalsSourcesTried : [],
            missingLookup: Array.isArray(entryRes?.meta?.decimalsSourcesTried)
              ? (entryRes.meta.decimalsSourcesTried.filter((x) => !x?.ok).map((x) => String(x?.source || 'unknown')).join('>') || 'none')
              : 'none',
            finalMissingDecimalsReason: `swap.entryBlocked_${String(entryRes?.reason || 'unknown')}`,
          });
          if (counters.guardrails.entryBlockedLast10.length > 10) counters.guardrails.entryBlockedLast10 = counters.guardrails.entryBlockedLast10.slice(-10);
          pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(blocked reason=${entryRes.reason})` });
          saveState(cfg.STATE_PATH, state);
          continue;
        }

        counters.entrySuccesses += 1;
        counters.funnel.fills += 1;
        if (signalTrigger === 'fallback') counters.funnel.entriesFromFallback += 1;
        else counters.funnel.entriesFromStandard += 1;
        if (entryRes?.swapMeta?.attempted) {
          counters.retry.slippageRetryAttempted += 1;
          if (entryRes.swapMeta.succeeded) counters.retry.slippageRetrySucceeded += 1;
          else counters.retry.slippageRetryFailed += 1;
        }
        recordEntryOpened({ state, nowMs: t });
        saveState(cfg.STATE_PATH, state);
        pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `ENTRY(opened${entryRes?.swapMeta?.attempted ? ` retry=${entryRes.swapMeta.reason}` : ''})` });
      }
      // If scanner entries or execution are disabled, we still captured/logged/tracked candidates above.
    } catch (e) {
      bump(counters, 'reject.swapError');
      if (cfg.PLAYBOOK_ENABLED) {
        recordPlaybookError({ state, nowMs: t, kind: 'swap_error', note: safeMsg(e) });
      }
      pushDebug(state, { t: nowIso(), mint, symbol: pair?.baseToken?.symbol, reason: `swapError(${safeMsg(e)})` });
    }
  }
}
