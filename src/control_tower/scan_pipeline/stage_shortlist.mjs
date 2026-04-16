import { maybeSendSourceMixVisibilityPing } from './stage_visibility.mjs';

export async function buildShortlistAndGates({
  deps,
  cfg,
  state,
  t,
  solUsdNow,
  counters,
  scanPhase,
  preCandidates,
  scanState,
  pushScanCompactEvent,
}) {
  const {
    toBaseUnits,
    DECIMALS,
    getRouteQuoteWithFallback,
    trackerMaybeEnqueue,
    tgSend,
    nowIso,
    circuitOkForEntries,
    entryCapacityAvailable,
    isPaperModeActive,
    PLAYBOOK_MODE_DEGRADED,
  } = deps;

  const _tShortlist = Date.now();
  if (typeof pushScanCompactEvent === 'function') {
    for (const c of preCandidates) {
      pushScanCompactEvent('shortlistPreCandidate', {
        mint: c?.mint,
        liqUsd: Number(c?.snapshot?.liquidityUsd ?? c?.pair?.liquidity?.usd ?? 0),
      });
    }
  }
  preCandidates.sort((a, b) => b.score - a.score);
  scanState.scanCandidatesFound = Number(preCandidates.length || 0);

  if (cfg.AGGRESSIVE_MODE) {
    preCandidates.sort((a, b) => {
      const ar = a.routeHint ? 1 : 0;
      const br = b.routeHint ? 1 : 0;
      return (br - ar) || (b.score - a.score);
    });
  }

  if (cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_PARALLEL_QUOTE_FANOUT_N > 0 && preCandidates.length > 1) {
    const fanoutN = Math.min(cfg.LIVE_PARALLEL_QUOTE_FANOUT_N, preCandidates.length);
    const fanoutSet = preCandidates.slice(0, fanoutN);
    const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
    const fanoutChecks = await Promise.all(fanoutSet.map(async (c) => {
      try {
        const route = await getRouteQuoteWithFallback({
          cfg,
          mint: c.mint,
          amountLamports: lam,
          slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
          solUsdNow,
          source: 'fanout',
        });
        return { mint: c.mint, routeable: !!route.routeAvailable };
      } catch {
        return { mint: c.mint, routeable: false };
      }
    }));
    counters.route.quoteFanoutChecked += fanoutChecks.length;
    const routeableMints = new Set(fanoutChecks.filter(x => x.routeable).map(x => x.mint));
    counters.route.quoteFanoutRouteable += routeableMints.size;
    preCandidates.sort((a, b) => {
      const ar = routeableMints.has(a.mint) ? 1 : 0;
      const br = routeableMints.has(b.mint) ? 1 : 0;
      return (br - ar) || (b.score - a.score);
    });
  }

  try {
    const trackable = preCandidates
      .filter(x => Number(x?.pair?.liquidity?.usd || x?.pair?.liquidityUsd || x?.pair?.liquidityUsd) || true)
      .slice(0, 25)
      .map(x => ({ mint: x.mint, pair: x.pair, tok: x.tok }));
    if (cfg.SCANNER_TRACKING_ENABLED) {
      trackerMaybeEnqueue({ cfg, state, candidates: trackable, nowIso });
    }
  } catch {}

  await maybeSendSourceMixVisibilityPing({ state, cfg, t, tgSend, preCandidates });

  const circuitOk = circuitOkForEntries({ state, nowMs: t });
  const playbookBlocks = cfg.PLAYBOOK_ENABLED && (state.playbook?.mode === PLAYBOOK_MODE_DEGRADED);
  const lowSolPaused = state.flags?.lowSolPauseEntries === true;
  const capOk = entryCapacityAvailable(state, cfg);
  const paperModeActive = isPaperModeActive({ state, cfg, nowMs: t });
  const executionAllowed = (cfg.EXECUTION_ENABLED || paperModeActive) && state.tradingEnabled && !playbookBlocks && circuitOk && !lowSolPaused && capOk;
  const executionAllowedReason = !(cfg.EXECUTION_ENABLED || paperModeActive) ? 'cfgExecutionOff'
    : (!state.tradingEnabled ? 'stateTradingOff'
      : (playbookBlocks ? 'playbookDegraded'
        : (!circuitOk ? 'circuitOpen' : (lowSolPaused ? 'lowSolPause' : (!capOk ? 'maxPositionsHysteresis' : null)))));

  const rawTopCandidates = preCandidates.slice(0, cfg.LIVE_CANDIDATE_SHORTLIST_N);
  const probeEnabled = !!(cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_PROBE_CONFIRM_ENABLED);
  scanPhase.shortlistMs += Math.max(0, Date.now() - _tShortlist);

  if (typeof pushScanCompactEvent === 'function') {
    for (const c of preCandidates.slice(cfg.LIVE_CANDIDATE_SHORTLIST_N)) {
      pushScanCompactEvent('shortlistDropped', {
        mint: c?.mint,
        liqUsd: Number(c?.snapshot?.liquidityUsd ?? c?.pair?.liquidity?.usd ?? 0),
        reason: 'shortlistCap',
      });
    }
  }

  const probeEligible = probeEnabled
    ? rawTopCandidates.filter(({ pair }) => {
      const liq = Number(pair?.liquidity?.usd || 0);
      const tx1h = Number(pair?.txns?.h1?.buys || 0) + Number(pair?.txns?.h1?.sells || 0);
      return liq >= cfg.LIVE_PROBE_MIN_LIQ_USD && tx1h >= cfg.LIVE_PROBE_MIN_TX1H;
    })
    : rawTopCandidates;

  if (probeEnabled && typeof pushScanCompactEvent === 'function') {
    for (const c of rawTopCandidates) {
      const liq = Number(c?.pair?.liquidity?.usd || c?.snapshot?.liquidityUsd || 0);
      const tx1h = Number(c?.pair?.txns?.h1?.buys || 0) + Number(c?.pair?.txns?.h1?.sells || 0);
      if (liq < cfg.LIVE_PROBE_MIN_LIQ_USD) {
        pushScanCompactEvent('shortlistDropped', { mint: c?.mint, liqUsd: liq, reason: 'probeMinLiq' });
      } else if (tx1h < cfg.LIVE_PROBE_MIN_TX1H) {
        pushScanCompactEvent('shortlistDropped', { mint: c?.mint, liqUsd: liq, reason: 'probeMinTx1h' });
      }
    }
  }

  const probeShortlist = probeEnabled
    ? probeEligible.slice(0, cfg.LIVE_PROBE_MAX_CANDIDATES)
    : rawTopCandidates;

  if (probeEnabled && typeof pushScanCompactEvent === 'function') {
    for (const c of probeEligible.slice(cfg.LIVE_PROBE_MAX_CANDIDATES)) {
      pushScanCompactEvent('shortlistDropped', {
        mint: c?.mint,
        liqUsd: Number(c?.snapshot?.liquidityUsd ?? c?.pair?.liquidity?.usd ?? 0),
        reason: 'probeCap',
      });
    }
  }

  if (typeof pushScanCompactEvent === 'function') {
    for (const c of probeShortlist) {
      pushScanCompactEvent('shortlistSelected', {
        mint: c?.mint,
        liqUsd: Number(c?.snapshot?.liquidityUsd ?? c?.pair?.liquidity?.usd ?? 0),
      });
    }
  }

  return {
    preCandidates,
    probeEnabled,
    probeShortlist,
    executionAllowed,
    executionAllowedReason,
    scanState,
  };
}
