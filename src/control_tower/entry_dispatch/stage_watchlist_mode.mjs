export async function handleWatchlistTriggerMode({
  deps,
  cfg,
  state,
  t,
  counters,
  scanPhase,
  solUsdNow,
  routeAvailableImmediateRows,
  probeShortlist,
  executionAllowed,
  executionAllowedReason,
}) {
  const {
    upsertWatchlistMint,
    evictWatchlist,
    evaluateWatchlistRows,
    emitCanaryCycleEvent,
    pushDebug,
    nowIso,
    saveState,
    conn,
    pub,
    wallet,
    birdseye,
  } = deps;
  const emitCanary = typeof emitCanaryCycleEvent === 'function' ? emitCanaryCycleEvent : () => {};

  const _tWatchlistWrite = Date.now();
  if (!cfg.WATCHLIST_TRIGGER_MODE) {
    scanPhase.watchlistWriteMs += Math.max(0, Date.now() - _tWatchlistWrite);
    return { handled: false };
  }

  const immediateRows = [...routeAvailableImmediateRows];
  const immediateRowMints = new Set(routeAvailableImmediateRows.map(([mint]) => mint));
  for (const { tok, mint, pair, snapshot, routeHint } of probeShortlist) {
    const _tRowBuild = Date.now();
    await upsertWatchlistMint({ state, cfg, nowMs: t, tok, mint, pair, snapshot, counters, routeHint, birdseye });
    scanPhase.snapshotWatchlistRowConstructionMs += Math.max(0, Date.now() - _tRowBuild);
    if (routeHint === true) {
      const row = state.watchlist?.mints?.[mint] || null;
      const dedupMs = Number(cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS || 0);
      const lastImmediateAtMs = Number(row?.lastImmediateEvalAtMs || 0);
      const dedupPass = cfg.CONVERSION_CANARY_MODE ? true : (dedupMs <= 0 || (t - lastImmediateAtMs) >= dedupMs);
      if (row && dedupPass && !immediateRowMints.has(mint)) {
        immediateRows.push([mint, row, true]);
        immediateRowMints.add(mint);
        row.lastImmediateEvalAtMs = t;
        counters.watchlist.immediateRoutePromoted += 1;
      }
    }
  }

  evictWatchlist({ state, cfg, nowMs: t, counters });
  const immediateCap = Math.max(0, Math.min(cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE, cfg.LIVE_CANDIDATE_SHORTLIST_N));
  if (immediateCap > 0 && immediateRows.length > 0) {
    const selectedRows = immediateRows.slice(0, immediateCap);
    let canary = null;
    let rowsForEval = selectedRows;
    const canaryEnabled = cfg.CONVERSION_CANARY_MODE || cfg.DEBUG_CANARY_ENABLED;
    if (canaryEnabled) {
      state.debug ||= {};
      state.debug.canary ||= { mint: null, lastRunAtMs: 0, latest: null };
      const canaryState = state.debug.canary;
      const canaryCooldownMs = cfg.CONVERSION_CANARY_MODE ? cfg.CONVERSION_CANARY_COOLDOWN_MS : cfg.DEBUG_CANARY_COOLDOWN_MS;
      const canaryEligible = [...selectedRows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (canaryEligible.length > 0 && (t - Number(canaryState.lastRunAtMs || 0)) >= canaryCooldownMs) {
        const chosen = canaryEligible[0][0];
        canaryState.mint = chosen;
        canaryState.lastRunAtMs = t;
        let emitted = false;
        const recordOnce = (stage, reason, mint, meta = null) => {
          if (emitted) return;
          emitted = true;
          emitCanary({ cfg, state, mint, stage, reason, nowMs: t, meta });
        };
        const record = (stage, reason, mint, meta = null) => {
          emitCanary({ cfg, state, mint, stage, reason, nowMs: t, meta });
        };
        canary = { enabled: true, verbose: cfg.DEBUG_CANARY_VERBOSE, mint: chosen, recordOnce, record };
        pushDebug(state, { t: nowIso(), mint: chosen, symbol: state.watchlist?.mints?.[chosen]?.pair?.baseToken?.symbol || null, reason: `canary:selected(executionAllowed=${executionAllowed ? 1 : 0})` });
        if (cfg.CONVERSION_CANARY_MODE) {
          rowsForEval = canaryEligible.filter(([mint]) => mint === chosen);
        }
      } else if (cfg.CONVERSION_CANARY_MODE) {
        emitCanary({ cfg, state, mint: null, stage: 'select', reason: 'cooldownOrNoEligible', nowMs: t });
      }
    }
    await evaluateWatchlistRows({
      rows: rowsForEval,
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
      immediateMode: true,
      canary,
    });
  } else if (cfg.CONVERSION_CANARY_MODE) {
    emitCanary({ cfg, state, mint: null, stage: 'select', reason: immediateCap <= 0 ? 'immediateDisabled' : 'noRouteAvailableCandidates', nowMs: t });
  }

  saveState(cfg.STATE_PATH, state);
  scanPhase.watchlistWriteMs += Math.max(0, Date.now() - _tWatchlistWrite);
  return { handled: true };
}
