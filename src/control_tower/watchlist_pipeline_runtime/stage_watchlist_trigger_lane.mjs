import { PLAYBOOK_MODE_DEGRADED } from '../../observability/incident_playbook.mjs';

export async function runWatchlistTriggerLane({
  t,
  cfg,
  state,
  counters,
  conn,
  pub,
  wallet,
  birdseye,
  lastWatchlistEval,
  lastSolUsd,
  lastSolUsdAt,
  solUsdFallback,
  ensureWatchlistState,
  evictWatchlist,
  pruneRouteCache,
  circuitOkForEntries,
  entryCapacityAvailable,
  isPaperModeActive,
  watchlistEntriesPrioritized,
  getSolUsdPrice,
  evaluateWatchlistRows,
}) {
  if (!cfg.WATCHLIST_TRIGGER_MODE || (t - lastWatchlistEval) < cfg.WATCHLIST_EVAL_EVERY_MS) {
    return { lastWatchlistEval, lastSolUsd, lastSolUsdAt };
  }

  const nextLastWatchlistEval = t;
  const wl = ensureWatchlistState(state);
  wl.stats.lastEvalAtMs = t;
  evictWatchlist({ state, cfg, nowMs: t, counters });
  pruneRouteCache({ state, cfg, nowMs: t });

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
  const watchlistRows = watchlistEntriesPrioritized({ state, cfg, limit: cfg.LIVE_CANDIDATE_SHORTLIST_N, nowMs: t });

  let solUsdNow = lastSolUsd || solUsdFallback || null;
  let nextLastSolUsd = lastSolUsd;
  let nextLastSolUsdAt = lastSolUsdAt;
  if (!solUsdNow || (t - lastSolUsdAt) > 5 * 60_000) {
    try {
      solUsdNow = (await getSolUsdPrice()).solUsd;
      nextLastSolUsd = solUsdNow;
      nextLastSolUsdAt = t;
    } catch {}
  }

  await evaluateWatchlistRows({
    rows: watchlistRows,
    cfg,
    state,
    counters,
    nowMs: t,
    executionAllowed,
    executionAllowedReason,
    solUsdNow,
    conn,
    pub,
    wallet,
    birdseye,
  });

  return {
    lastWatchlistEval: nextLastWatchlistEval,
    lastSolUsd: nextLastSolUsd,
    lastSolUsdAt: nextLastSolUsdAt,
  };
}
