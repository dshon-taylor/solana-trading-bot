import { estimateEquityUsd } from './portfolio_control.mjs';
import { getTokenHoldingsByMint } from '../portfolio.mjs';
import { positionCount } from './position_policy.mjs';
import { isPaperModeActive } from './route_control.mjs';
import { jupCooldownRemainingMs } from '../jup_cooldown.mjs';
import { formatTrackerIngestionSummary } from '../tracker.mjs';
import { getLastDebug } from '../observability/debug_buffer.mjs';
import { getModels } from '../ai_pipeline.mjs';
import { fmtUsd } from './ops_reporting.mjs';
import { saveState } from '../state.mjs';
import { nowIso, safeErr } from '../logger.mjs';

/**
 * createOperatorSurfaces – Telegram operator command handlers.
 *
 * Factory deps from main():
 *   cfg, state, conn, pub
 *   tgSend, tgSendChunked
 *   getDiagSnapshotMessage
 *   spendSummaryCache, refreshSpendSummaryCacheAsync, SPEND_CACHE_TTL_MS
 *   runNodeScriptJson
 *   appendLearningNote  (optional – may be undefined in current deploy)
 *   getSolUsdPrice      (optional – may be undefined in current deploy)
 *   sendPositionsReport
 *   getLoopState        () => { dexCooldownUntil, lastScan, lastSolUsdAt }
 */
function createOperatorSurfaces({
  cfg,
  state,
  conn,
  pub,
  tgSend,
  tgSendChunked,
  getDiagSnapshotMessage,
  spendSummaryCache,
  refreshSpendSummaryCacheAsync,
  SPEND_CACHE_TTL_MS,
  runNodeScriptJson,
  appendLearningNote,
  getSolUsdPrice,
  sendPositionsReport,
  getLoopState,
}) {
  async function processOperatorCommands(t) {
    const { dexCooldownUntil, lastScan, lastSolUsdAt } = getLoopState();
    // Persist state immediately if requested by control commands
    if (state.flags?.saveStateNow) {
      state.flags.saveStateNow = false;
      saveState(cfg.STATE_PATH, state);
    }

    // force-close hook handled near top of loop to avoid starvation by scan-lane continues.

    // Respond to /positions and /status flags
    if (state.flags?.sendPositions) {
      state.flags.sendPositions = false;
      await sendPositionsReport();
    }

    if (state.flags?.sendOpencheck) {
      state.flags.sendOpencheck = false;
      try {
        const openRows = Object.entries(state.positions || {}).filter(([, p]) => p?.status === 'open');
        const stateOpen = openRows.length;
        const onchain = await getTokenHoldingsByMint(conn, pub);
        const onchainOpen = Array.from(onchain.values()).filter((amt) => Number(amt || 0) > 0).length;
        const exitPending = openRows.filter(([, p]) => !!p?.exitPending).length;
        const hotQueuePending = Array.isArray(state?.watchlist?.hotQueue) ? state.watchlist.hotQueue.length : 0;
        const mintBacklog = state?.watchlist?.mints && typeof state.watchlist.mints === 'object'
          ? Object.keys(state.watchlist.mints).length
          : 0;

        await tgSend(cfg, [
          '🔎 *Open Check*',
          `🕒 ${nowIso()}`,
          `• state open positions: ${stateOpen}`,
          `• on-chain token holdings (>0): ${onchainOpen}`,
          `• delta (state - onchain): ${stateOpen - onchainOpen}`,
          `• exitPending: ${exitPending}`,
          `• watchlist hot queue: ${hotQueuePending}`,
          `• watchlist tracked mints: ${mintBacklog}`,
        ].join('\n'));
      } catch (e) {
        await tgSend(cfg, `Opencheck error: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.sendStatus) {
      state.flags.sendStatus = false;
      try {
        const { solUsd } = await getSolUsdPrice();
        const { equityUsd, solLamports } = await estimateEquityUsd(cfg, conn, pub, state, solUsd);
        const openCount = positionCount(state);
        const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
        const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
        const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
        await tgSend(cfg, [
          '🧾 *Status*',
          `🕒 ${nowIso()}`,
          '',
          `👛 Wallet: ${pub}`,
          `• SOL: ${(solLamports/1e9).toFixed(4)}  |  SOLUSD: $${solUsd.toFixed(2)}`,
          `• Equity≈: ${fmtUsd(equityUsd)}`,
          `• Open positions: ${openCount}`,
          `• Execution config: ${cfg.EXECUTION_ENABLED ? '✅ enabled' : '🛑 disabled'}`,
          `• Runtime gate: ${state.tradingEnabled ? '✅ open' : '🛑 halted'}`,
          '',
          `⚙️ Filters: liq>=max(${effLiqFloor}, ${(state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO)}*mcap), mcap>=${effMinMcap}, age>=${effMinAge}h`,
        ].join('\n'));
      } catch (e) {
        await tgSend(cfg, `Status error: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.sendModels) {
      state.flags.sendModels = false;
      const models = getModels(cfg, state);
      await tgSend(cfg, [
        `🤖 Models @ ${nowIso()}`,
        `• preprocess: ${models.preprocess}`,
        `• analyze: ${models.analyze}`,
        `• gatekeeper: ${models.gatekeeper}`,
        `Update: /setmodel preprocess gpt-5-mini | /setmodel analyze gpt-5.2 | /setmodel gatekeeper gpt-5.2`,
      ].join('\n'));
    }

    if (state.flags?.sendHealth) {
      state.flags.sendHealth = false;
      const nowMs = Date.now();
      const loopFreshSec = lastScan ? Math.round((nowMs - lastScan) / 1000) : null;
      const solFreshSec = lastSolUsdAt ? Math.round((nowMs - lastSolUsdAt) / 1000) : null;
      const dexCdSec = Math.max(0, Math.round((dexCooldownUntil - nowMs) / 1000));
      const jupCdSec = Math.max(0, Math.round(jupCooldownRemainingMs(state, nowMs) / 1000));
      const circuitState = state?.circuit?.open ? 'open' : 'closed';
      const trackerSummary = formatTrackerIngestionSummary({ cfg, state });
      await tgSend(
        cfg,
        `❤️ Health: loop=${loopFreshSec == null ? 'n/a' : `${loopFreshSec}s`} circuit=${circuitState} dexCd=${dexCdSec}s jupCd=${jupCdSec}s solData=${solFreshSec == null ? 'n/a' : `${solFreshSec}s`}\n${trackerSummary}`
      );
    }

    if (state.flags?.sendDiag) {
      const rawMode = String(state.flags?.sendDiagMode || 'compact').toLowerCase();
      const mode = (rawMode === 'full' || rawMode === 'momentum' || rawMode === 'confirm' || rawMode === 'execution' || rawMode === 'scanner') ? rawMode : 'compact';
      const windowHours = Number(state.flags?.sendDiagWindowHours);
      const useHours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : null;
      state.flags.sendDiag = false;
      delete state.flags.sendDiagMode;
      delete state.flags.sendDiagWindowHours;
      await tgSendChunked(getDiagSnapshotMessage(Date.now(), mode, useHours));
    }

    if (state.flags?.sendMode) {
      state.flags.sendMode = false;
      const nowMs = Date.now();
      const paperOn = isPaperModeActive({ state, cfg, nowMs });
      const mode = !state.tradingEnabled ? 'halted' : paperOn ? 'paper' : cfg.EXECUTION_ENABLED ? 'live' : 'monitoring';
      const gates = [
        `executionCfg=${cfg.EXECUTION_ENABLED ? 'on' : 'off'}`,
        `runtimeGate=${state.tradingEnabled ? 'open' : 'halted'}`,
        `paper=${paperOn ? 'on' : 'off'}`,
        `force=${cfg.FORCE_TRADING_ENABLED ? 'on' : 'off'}`,
        `playbook=${state?.playbook?.mode || 'normal'}`,
        `circuit=${state?.circuit?.open ? 'open' : 'closed'}`,
      ];
      await tgSend(cfg, `🎚️ Mode: *${mode}* (${gates.join(', ')})`);
    }

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

    if (state.flags?.runReplay) {
      const req = state.flags.runReplay;
      delete state.flags.runReplay;
      try { await saveState(cfg.STATE_PATH, state); } catch {}
      try {
        const args = ['scripts/replay_historical.mjs', '--json', '--days', String(req.days)];
        if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));
        if (req.trailActivatePct != null) args.push('--trail-activate-pct', String(req.trailActivatePct));
        if (req.trailDistancePct != null) args.push('--trail-distance-pct', String(req.trailDistancePct));
        if (req.stopEntryBufferPct != null) args.push('--stop-entry-buffer-pct', String(req.stopEntryBufferPct));

        const out = await runNodeScriptJson(args[0], args.slice(1), 90_000);
        await tgSend(
          cfg,
          [
            '🧪 *Historical Replay*',
            `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0}`,
            `rules: activate=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)}% distance=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)}% stopBuf=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}%`,
            `trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}%`,
            `exits=${JSON.stringify(out?.metrics?.exits || {})}`,
          ].join('\n')
        );
        appendLearningNote(`Replay run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} trades=${out?.metrics?.trades ?? 0} pnlSum=${(Number(out?.metrics?.pnlSumPct || 0) * 100).toFixed(2)}% hitRate=${(Number(out?.metrics?.hitRate || 0) * 100).toFixed(1)}% ddProxy=${(Number(out?.metrics?.drawdownProxyPct || 0) * 100).toFixed(2)}% rules[a=${(Number(out?.config?.rules?.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(out?.config?.rules?.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(out?.config?.rules?.stopEntryBufferPct || 0) * 100).toFixed(4)}].`);
      } catch (e) {
        await tgSend(cfg, `❌ Replay failed: ${safeErr(e).message}`);
      }
    }

    if (state.flags?.runOptimize) {
      const req = state.flags.runOptimize;
      delete state.flags.runOptimize;
      try { await saveState(cfg.STATE_PATH, state); } catch {}
      try {
        const args = [
          'scripts/optimize_replay.mjs',
          '--json',
          '--days',
          String(req.days),
          '--top',
          String(req.top),
          '--trail-activate-range',
          String(req.trailActivateRange),
          '--trail-distance-range',
          String(req.trailDistanceRange),
          '--stop-entry-buffer-range',
          String(req.stopEntryBufferRange),
        ];
        if (req.windowHours != null) args.push('--window-hours', String(req.windowHours));

        const out = await runNodeScriptJson(args[0], args.slice(1), 120_000);
        const ranked = Array.isArray(out?.ranked) ? out.ranked : [];
        const lines = ranked.slice(0, Math.min(5, ranked.length)).map((row, i) => {
          const r = row.rules || {};
          const m = row.metrics || {};
          return `#${i + 1} a=${(Number(r.trailActivatePct || 0) * 100).toFixed(2)}% d=${(Number(r.trailDistancePct || 0) * 100).toFixed(2)}% sb=${(Number(r.stopEntryBufferPct || 0) * 100).toFixed(4)}% | pnl=${(Number(m.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(m.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(m.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(m.trades || 0)}`;
        });

        await tgSend(
          cfg,
          [
            '⚙️ *Replay Optimizer*',
            `days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} series=${out?.dataset?.trackedSeries ?? 0} top=${out?.config?.top}`,
            `preset=${req.preset} grid: activate=${req.trailActivateRange} distance=${req.trailDistanceRange} stopbuf=${req.stopEntryBufferRange}`,
            '',
            ...(lines.length ? lines : ['No optimization rows returned.']),
          ].join('\n')
        );
        const best = ranked[0] || {};
        const br = best.rules || {};
        const bm = best.metrics || {};
        appendLearningNote(`Optimize run: days=${out?.config?.days} windowHours=${out?.config?.windowHours ?? 'full'} top=${out?.config?.top} grid[a=${req.trailActivateRange} d=${req.trailDistanceRange} sb=${req.stopEntryBufferRange}] best[a=${(Number(br.trailActivatePct || 0) * 100).toFixed(2)} d=${(Number(br.trailDistancePct || 0) * 100).toFixed(2)} sb=${(Number(br.stopEntryBufferPct || 0) * 100).toFixed(4)}] pnl=${(Number(bm.pnlSumPct || 0) * 100).toFixed(2)}% hit=${(Number(bm.hitRate || 0) * 100).toFixed(1)}% dd=${(Number(bm.drawdownProxyPct || 0) * 100).toFixed(2)}% trades=${Number(bm.trades || 0)}.`);
      } catch (e) {
        await tgSend(cfg, `❌ Optimizer failed: ${safeErr(e).message}`);
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

    if (state.flags?.sendLast) {
      const n = state.flags.sendLast;
      delete state.flags.sendLast;
      const items = getLastDebug(state, n);
      if (!items.length) {
        await tgSend(cfg, 'Last candidates: none recorded yet');
      } else {
        const lines = items.map((it) => {
          const sym = it.symbol ? String(it.symbol) : '???';
          const mint = it.mint ? String(it.mint) : '';
          const r = it.reason || '';
          const extra = [];
          if (it.liqUsd != null) extra.push(`💧${Math.round(it.liqUsd)}`);
          if (it.mcapUsd != null) extra.push(`🧢${Math.round(it.mcapUsd)}`);
          if (it.rugScore != null) extra.push(`🛡️${it.rugScore}`);
          if (it.tx1h != null) extra.push(`🔁${it.tx1h}`);
          if (it.pc1h != null) extra.push(`📈${it.pc1h}`);
          return `• ${sym} (${mint.slice(0, 6)}…) — ${r}${extra.length ? `  [${extra.join(' ')}]` : ''}`;
        });
        const chunkSize = 25;
        for (let i = 0; i < lines.length; i += chunkSize) {
          await tgSend(cfg, `🧪 *Last candidates* (newest last)\n\n` + lines.slice(i, i + chunkSize).join('\n'));
        }
      }
    }

  }

  return { processOperatorCommands };
}

const __legacyCreateOperatorSurfaces = createOperatorSurfaces;
void __legacyCreateOperatorSurfaces;

export * from './operator_surfaces/index.mjs';
