export async function runMaintenanceChores({
  t,
  cfg,
  state,
  conn,
  pub,
  counters,
  lastLedgerPruneAt,
  lastReconcileAt,
  lastAutoTune,
  lastHourlyDiag,
  nowIso,
  saveState,
  tgSend,
  positionCount,
  getTokenHoldingsByMint,
  getSplBalance,
  applyOnchainBalanceToPosition,
  maybeRotateBySize,
  maybePruneJsonlByAge,
  getDiagEventsPath,
  autoTuneFilters,
  snapshotAndReset,
  formatThroughputSummary,
  formatMarketDataProviderSummary,
}) {
  let nextLastLedgerPruneAt = lastLedgerPruneAt;
  let nextLastReconcileAt = lastReconcileAt;
  let nextLastAutoTune = lastAutoTune;
  let nextLastHourlyDiag = lastHourlyDiag;
  let nextCounters = counters;

  if (t - nextLastLedgerPruneAt > 6 * 60 * 60_000) {
    nextLastLedgerPruneAt = t;
    try {
      const files = [
        cfg.LEDGER_PATH,
        cfg.TRADES_LEDGER_PATH,
        './state/candidates.jsonl',
        './state/paper_trades.jsonl',
        './state/paper_live_attempts.jsonl',
      ];
      for (const fp of files) {
        try {
          maybeRotateBySize({ filePath: fp, maxBytes: cfg.JSONL_ROTATE_MAX_BYTES, nowMs: t });
          maybePruneJsonlByAge({ filePath: fp, maxAgeDays: cfg.JSONL_RETENTION_DAYS, nowMs: t });
        } catch {}
      }
      try {
        const diagEventsPath = getDiagEventsPath(cfg.STATE_PATH);
        maybeRotateBySize({ filePath: diagEventsPath, maxBytes: cfg.JSONL_ROTATE_MAX_BYTES, nowMs: t });
        maybePruneJsonlByAge({ filePath: diagEventsPath, maxAgeDays: cfg.DIAG_RETENTION_DAYS, nowMs: t });
      } catch {}
    } catch {}
  }

  if (t - nextLastReconcileAt >= 60_000) {
    nextLastReconcileAt = t;

    let holdings = null;
    try {
      holdings = await getTokenHoldingsByMint(conn, pub);
    } catch {
      holdings = null;
    }

    for (const [mint, pos] of Object.entries(state.positions || {})) {
      if (!pos) continue;
      if (pos.status !== 'open' && pos.status !== 'closed') continue;

      let bal = null;
      if (holdings) {
        const amt = holdings.get(mint) || 0;
        bal = { amount: amt, ata: null, source: 'holdings_map', fetchOk: true };
      } else {
        try {
          bal = await getSplBalance(conn, pub, mint);
        } catch {
          continue;
        }
      }

      applyOnchainBalanceToPosition({
        pos,
        bal,
        nowMs: Date.now(),
        nowIso: nowIso(),
      });
    }

    saveState(cfg.STATE_PATH, state);
  }

  const anyTradesYet = Object.values(state.positions || {}).some((p) => p.entryTx);

  if (cfg.AUTO_TUNE_ENABLED && t - nextLastAutoTune >= cfg.AUTO_TUNE_EVERY_MS) {
    nextLastAutoTune = t;
    if (!anyTradesYet) {
      const changes = autoTuneFilters({ state, cfg, nowIso });
      if (changes.length) {
        saveState(cfg.STATE_PATH, state);
        await tgSend(cfg, `🧠 Auto-tune adjusted filters: ${changes.join(', ')}`);
      }
    }
  }

  const hourlyDiagEnabled = (state?.flags?.hourlyDiagEnabled ?? cfg.HOURLY_DIAG_ENABLED);
  if (hourlyDiagEnabled && t - nextLastHourlyDiag >= cfg.HOURLY_DIAG_EVERY_MS) {
    nextLastHourlyDiag = t;
    if (!anyTradesYet) {
      const { snap, next } = snapshotAndReset(nextCounters);
      nextCounters = next;
      state.runtime.diagCounters = nextCounters;
      const fo = state.filterOverrides || {};
      const msg = [
        formatThroughputSummary({
          counters: snap,
          title: '📈 *Throughput check* (last window)',
        }),
        '',
        '🎛️ current filters',
        `• liq >= ${fo.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD}`,
        `• age >= ${fo.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS}h`,
        `• mcap >= ${fo.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD}`,
        `• liqratio >= ${fo.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO}`,
        '',
        formatMarketDataProviderSummary(state),
        `🕒 ${nowIso()}`,
      ].join('\n');
      await tgSend(cfg, msg);
    }
  }

  return {
    lastLedgerPruneAt: nextLastLedgerPruneAt,
    lastReconcileAt: nextLastReconcileAt,
    lastAutoTune: nextLastAutoTune,
    lastHourlyDiag: nextLastHourlyDiag,
    counters: nextCounters,
  };
}
