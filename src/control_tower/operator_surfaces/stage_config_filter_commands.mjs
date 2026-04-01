import { getModels } from '../../analytics/ai_pipeline.mjs';
import { nowIso } from '../../observability/logger.mjs';

export async function handleConfigFilterCommands(ctx) {
  const {
    cfg,
    state,
    tgSend,
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
    SPEND_CACHE_TTL_MS,
  } = ctx;

  if (state.flags?.sendConfig) {
    state.flags.sendConfig = false;
    const models = getModels(cfg, state);
    const cfgSnap = {
      executionEnabled: cfg.EXECUTION_ENABLED,
      forceTradingEnabled: cfg.FORCE_TRADING_ENABLED,
      scannerEntriesEnabled: cfg.SCANNER_ENTRIES_ENABLED,
      usdPerTrade: cfg.USD_PER_TRADE,
      slippageBps: cfg.SLIPPAGE_BPS,
      maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
      scanEveryMs: cfg.SCAN_EVERY_MS,
      positionsEveryMs: cfg.POSITIONS_EVERY_MS,
      watchlistTriggerMode: cfg.WATCHLIST_TRIGGER_MODE,
      watchlistMaxSize: cfg.WATCHLIST_MAX_SIZE,
      watchlistEvalEveryMs: cfg.WATCHLIST_EVAL_EVERY_MS,
      watchlistMintTtlMs: cfg.WATCHLIST_MINT_TTL_MS,
      watchlistEvictMaxAgeHours: cfg.WATCHLIST_EVICT_MAX_AGE_HOURS,
      watchlistEvictStaleCycles: cfg.WATCHLIST_EVICT_STALE_CYCLES,
      minLiqUsd: state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD,
      minMcapUsd: state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD,
      minAgeHours: state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS,
      liqToMcapRatio: state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO,
      models,
    };
    await tgSend(cfg, `⚙️ Config (safe):\n\n${JSON.stringify(cfgSnap, null, 2)}`);
  }

  if (state.flags?.sendWhy) {
    const target = String(state.flags.sendWhy || '').toLowerCase();
    delete state.flags.sendWhy;
    const rows = Array.isArray(state?.debug?.last) ? state.debug.last : [];
    const hit = [...rows].reverse().find((it) => {
      const sym = String(it?.symbol || '').toLowerCase();
      const mint = String(it?.mint || '').toLowerCase();
      return sym === target || mint === target;
    });
    if (!hit) {
      await tgSend(cfg, `No recent debug entry for ${target}. Try /last 50 or enable /debug on 5.`);
    } else {
      await tgSend(cfg, `🤔 Why ${hit.symbol || target} (${String(hit.mint || '').slice(0, 6)}…): ${hit.reason || 'unknown'} @ ${hit.t || 'n/a'}`);
    }
  }

  if (state.flags?.sendSpend) {
    const arg = String(state.flags.sendSpend || '24h');
    delete state.flags.sendSpend;

    const nowMs = Date.now();
    const cached = spendSummaryCache.summaries.get(arg);
    const cacheAgeSec = spendSummaryCache.loadedAtMs ? Math.max(0, Math.round((nowMs - spendSummaryCache.loadedAtMs) / 1000)) : null;
    if (cached) {
      const lines = [
        `💸 Spend (${arg}): $${cached.cost.toFixed(4)} across ${cached.events} calls`,
        `snapshotAt=${new Date(spendSummaryCache.loadedAtMs).toISOString()} staleness=${cacheAgeSec}s`,
        '',
        'By model:',
        ...Object.entries(cached.byModel).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `- ${k}: $${v.toFixed(4)}`),
        '',
        'By operation:',
        ...Object.entries(cached.byOp).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `- ${k}: $${v.toFixed(4)}`),
      ];
      await tgSend(cfg, lines.join('\n'));
    } else {
      await tgSend(cfg, '⏳ Spend snapshot warming; using cached observability path (no hot-loop ledger scan). Retry in ~10s.');
    }

    if (!spendSummaryCache.inFlight && (cacheAgeSec == null || cacheAgeSec * 1000 >= SPEND_CACHE_TTL_MS)) {
      refreshSpendSummaryCacheAsync();
    }
  }

  if (state.flags?.sendFilters) {
    state.flags.sendFilters = false;
    const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
    const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
    const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
    const over = state.filterOverrides ? `overrides active` : `defaults`;
    await tgSend(cfg, [
      `⚙️ *Filters* (${over})`,
      `🕒 ${nowIso()}`,
      '',
      `• Liquidity: >= max(${effLiqFloor}, ${(state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO)} * mcap)`,
      `• Mcap: >= ${effMinMcap}`,
      `• Age: >= ${effMinAge}h`,
      '',
      '✏️ Examples:',
      '• /setfilter liq 60000',
      '• /setfilter liqratio 0.28',
      '• /setfilter mcap 300000',
      '• /setfilter age 24',
      '• /resetfilters',
    ].join('\n'));
  }

  if (state.flags?.sendHardrejects) {
    state.flags.sendHardrejects = false;
    const effMinMcap = Number(state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD);
    const effLiqFloor = Number(state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD);
    await tgSend(cfg, [
      '🧱 *Core Hard Rejects*',
      `🕒 ${nowIso()}`,
      '',
      `• mcap < ${effMinMcap}`,
      `• liquidity < 120000 (base floor now ${effLiqFloor})`,
      '• volume_5m < 20000',
      '• tx1h < 80',
      '• spread > 3% (when available)',
      '• pool age < 180s',
      '• mcap/liquidity > 4.5',
      '• liquidity drop > 10% in last 60s',
      '• ret1 > 12%',
      '• ret1 < 2%',
      '• ret5 < 5%',
      '• buy dominance < 68%',
      '• tx slope not positive',
      '• 1m volatility extreme',
      '• topHolder > 3.5%',
      '• top10 > 38%',
      '• bundleCluster > 15%',
      '• creatorCluster > 2% (if available)',
      '• LP unlocked or LP lock < 90% (if available)',
      `• holders gate: age<=${cfg.HOLDER_TIER_NEW_MAX_AGE_SEC}s => >=${cfg.HOLDER_TIER_MIN_NEW}, else >=${cfg.HOLDER_TIER_MIN_MATURE}`,
      '• low SOL fee reserve → pause new entries',
      '• unsafe/stale entry snapshot or confirm-stage route/liquidity failure',
      '',
      '⚠️ Sizing modifier: top10 in [30%,38%] => size reduced 50% (not full reject).',
    ].join('\n'));
  }
}
