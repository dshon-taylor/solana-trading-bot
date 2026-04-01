import cache from '../../global_cache.mjs';
import { getConcentrationMetrics } from '../../providers/rugcheck.mjs';
import { getTokenSupply } from '../../providers/helius.mjs';
import { executeSwap, toBaseUnits, DECIMALS } from '../../trader.mjs';
import { appendTradingLog, nowIso } from '../../core/logger.mjs';
import { tgSend } from '../../telegram/index.mjs';
import { appendJsonl } from '../../candidates_ledger.mjs';
import { resolveEntryAndStopForOpenPosition } from '../../entry_guard.mjs';
import { computePreTrailStopPrice } from '../../lib/stop_policy.mjs';
import { pushDebug } from '../../observability/debug_buffer.mjs';
import { tokenDisplayName, tokenDisplayWithSymbol } from '../position_policy.mjs';

function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export async function openPosition(cfg, conn, wallet, state, solUsd, pair, mcapUsd, decimals, rugReport, signal, tradeCfg) {
  const mint = tradeCfg?.mint || pair?.baseToken?.address || null;
  const tokenName = tradeCfg?.tokenName || pair?.baseToken?.name || null;
  const symbol = tradeCfg?.symbol || pair?.baseToken?.symbol || null;
  const display = tokenDisplayName({ name: tokenName, symbol, mint });

  const confidenceScore = Number(tradeCfg?.entrySnapshot?.confidenceScore ?? tradeCfg?.confidenceScore ?? NaN);
  const c = Number.isFinite(confidenceScore) ? Math.max(0, Math.min(1, confidenceScore)) : 0.5;
  const entrySnapshot = tradeCfg?.entrySnapshot || null;
  const liqUsdAtEntry = Number(entrySnapshot?.liquidityUsd ?? pair?.liquidity?.usd ?? pair?.birdeye?.raw?.liquidity ?? 0) || 0;
  const mcapUsdAtEntry = Number.isFinite(Number(mcapUsd)) ? Number(mcapUsd) : Number(entrySnapshot?.marketCapUsd ?? pair?.marketCap ?? pair?.fdv ?? 0) || 0;
  const snapHolders = Number(entrySnapshot?.entryHints?.participation?.holders ?? entrySnapshot?.pair?.participation?.holders ?? 0) || null;
  const snapUniqueBuyers = Number(entrySnapshot?.entryHints?.participation?.uniqueBuyers ?? entrySnapshot?.pair?.participation?.uniqueBuyers ?? 0) || null;
  const dynamicUsdTarget = Number(cfg.LIVE_MOMO_USD_MIN || 2) + ((Number(cfg.LIVE_MOMO_USD_MAX || 7) - Number(cfg.LIVE_MOMO_USD_MIN || 2)) * c);
  const usdTargetBase = tradeCfg?.usdTarget ?? dynamicUsdTarget;
  const conc = getConcentrationMetrics(rugReport);
  const sizeCutForTop10 = (conc.top10Pct != null && conc.top10Pct >= 30 && conc.top10Pct <= 38) ? 0.5 : 1;
  const signalBuyDominance = Number(signal?.buyDominance ?? ((Number(signal?.buys1h || 0) + Number(signal?.sells1h || 0)) > 0
    ? (Number(signal?.buys1h || 0) / (Number(signal?.buys1h || 0) + Number(signal?.sells1h || 0)))
    : NaN));
  const usdTarget = usdTargetBase * sizeCutForTop10;
  const slippageBps = tradeCfg?.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS;

  const entryMinMcapUsd = Number(cfg.ENTRY_MIN_MCAP_USD ?? 120000);
  if (!(mcapUsdAtEntry >= entryMinMcapUsd)) {
    return {
      blocked: true,
      reason: 'entryMcapTooLow',
      mint,
      symbol,
      meta: { mcapUsdAtEntry, required: entryMinMcapUsd },
    };
  }
  const entryMinLiquidityUsd = Number(cfg.ENTRY_MIN_LIQUIDITY_USD ?? 30000);
  if (!(liqUsdAtEntry >= entryMinLiquidityUsd)) {
    return {
      blocked: true,
      reason: 'entryLiquidityMissingOrLow',
      mint,
      symbol,
      meta: { liqUsdAtEntry, required: entryMinLiquidityUsd },
    };
  }

  const stopAtEntry = cfg.LIVE_MOMO_STOP_AT_ENTRY === true;
  const stopAtEntryBufferPct = cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT;
  const trailActivatePct = cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT;
  const trailDistancePct = cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT;

  const resolved = await resolveEntryAndStopForOpenPosition({
    mint,
    pair,
    snapshot: tradeCfg?.entrySnapshot || null,
    decimalsHint: decimals,
    stopAtEntryBufferPct,
    birdeyeEnabled: !!tradeCfg?.birdeyeEnabled,
    getBirdseyeSnapshot: tradeCfg?.getBirdseyeSnapshot || null,
    birdeyeFetchTimeoutMs: cfg.BIRDEYE_ENTRY_FETCH_TIMEOUT_MS,
    rpcUrl: cfg.SOLANA_RPC_URL,
    getTokenSupply,
  });

  if (!resolved.ok) {
    return {
      blocked: true,
      reason: resolved.reason,
      mint,
      symbol,
      meta: {
        priceSource: resolved.priceSource,
        pairPriceUsd: Number(pair?.priceUsd || 0) || null,
        snapPriceUsd: Number(tradeCfg?.entrySnapshot?.priceUsd || 0) || null,
        decimalsHint: (typeof decimals === 'number') ? decimals : null,
        decimalsSource: resolved?.decimalsSource || null,
        decimalsSourcesTried: Array.isArray(resolved?.decimalsSourcesTried) ? resolved.decimalsSourcesTried : [],
        mintResolvedForDecimals: resolved?.mintResolvedForDecimals || mint || null,
        pairBaseTokenAddress: resolved?.pairBaseTokenAddress || pair?.baseToken?.address || null,
      },
    };
  }

  let entryPriceUsd = Number(resolved.entryPriceUsd);
  let stopPriceUsd = Number(resolved.stopPriceUsd);
  stopPriceUsd = Number(computePreTrailStopPrice({
    entryPriceUsd,
    entryAtMs: Date.now(),
    nowMs: Date.now(),
    armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
    prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
    stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
  }) || stopPriceUsd);
  const decimalsResolved = resolved.decimals;

  const maxSol = usdTarget / solUsd;
  const inAmountLamports = toBaseUnits(maxSol, DECIMALS[cfg.SOL_MINT] ?? 9);

  const paperOnly = tradeCfg?.paperOnly === true;
  if (paperOnly) {
    const now = Date.now();
    state.paper ||= { enabledUntilMs: 0, positions: {}, lastEntryAtMs: {}, series: {} };
    state.paper.positions ||= {};
    state.paper.lastEntryAtMs ||= {};
    state.paper.lastEntryAtMs[mint] = now;
    state.paper.positions[mint] = {
      status: 'open',
      mint,
      symbol: symbol || null,
      entryT: new Date(now).toISOString(),
      entryPrice: Number(entryPriceUsd || 0),
      stopPx: Number(stopPriceUsd || 0),
      trailActivated: false,
      activeTrailPct: Number(trailDistancePct || 0),
      trailHigh: null,
      trailStop: null,
      source: 'scanner_live_process',
      note: 'paperOnlyEntry',
    };

    try {
      appendJsonl('./state/paper_trades.jsonl', {
        t: nowIso(),
        mode: 'paper',
        type: 'entry',
        source: 'scanner_live_process',
        mint,
        symbol,
        entryPrice: Number(entryPriceUsd || 0),
        stopPrice: Number(stopPriceUsd || 0),
        usdTarget,
        slippageBps,
        mcapUsd: Number(mcapUsdAtEntry || 0) || null,
        liquidityUsd: Number(liqUsdAtEntry || 0) || null,
      });
    } catch {}

    pushDebug(state, {
      t: nowIso(),
      mint,
      symbol,
      reason: `PAPER(opened via live process, usdTarget=${Number(usdTarget || 0).toFixed(2)})`,
    });

    return {
      signature: `paper:${mint}:${now}`,
      mode: 'paper',
      paperOnly: true,
      swapMeta: { attempted: false, succeeded: false, reason: 'paperOnly' },
    };
  }

  const res = await executeSwap({
    conn,
    wallet,
    inputMint: cfg.SOL_MINT,
    outputMint: mint,
    inAmountBaseUnits: inAmountLamports,
    slippageBps,
    maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
    expectedOutAmount: tradeCfg?.expectedOutAmount,
    expectedInAmount: tradeCfg?.expectedInAmount,
    maxQuoteDegradePct: cfg.MAX_QUOTE_DEGRADE_PCT,
    twoStageSlippageRetryEnabled: !!(cfg.LIVE_CONVERSION_PROFILE_ENABLED && cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED),
    twoStageSlippageRetryBps: cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS,
    twoStageSlippageMaxBps: cfg.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS,
  });

  const fillIn = Number(res?.fill?.inAmountRaw || 0);
  const fillOut = Number(res?.fill?.outAmountRaw || 0);
  const fillOutDecimals = Number(res?.fill?.outDecimals || decimalsResolved || 0);
  const fillInSol = fillIn > 0 ? (fillIn / 1e9) : null;
  const fillOutTokens = (fillOut > 0 && fillOutDecimals >= 0) ? (fillOut / (10 ** fillOutDecimals)) : null;
  const liveEntryPriceUsd = (fillInSol && fillOutTokens && solUsd > 0)
    ? ((fillInSol * solUsd) / fillOutTokens)
    : null;

  if (Number.isFinite(Number(liveEntryPriceUsd)) && Number(liveEntryPriceUsd) > 0) {
    entryPriceUsd = Number(liveEntryPriceUsd);
    stopPriceUsd = Number(computePreTrailStopPrice({
      entryPriceUsd,
      entryAtMs: Date.now(),
      nowMs: Date.now(),
      armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
      prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
      stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    }) || stopPriceUsd);
  }

  const now = Date.now();

  state.positions[mint] = {
    status: 'open',
    mint,
    symbol: symbol || null,
    tokenName: tokenName || null,
    decimals: decimalsResolved,
    pairUrl: pair?.url || null,
    entryAt: new Date(now).toISOString(),
    entryPriceUsd,
    peakPriceUsd: entryPriceUsd,
    trailingActive: false,
    stopAtEntry,
    stopEvalMode: 'conservative_exec_mark',
    stopPriceUsd,
    mcapUsdAtEntry: Number.isFinite(Number(mcapUsdAtEntry)) ? Number(mcapUsdAtEntry) : null,
    liquidityUsdAtEntry: Number(liqUsdAtEntry || 0) || null,
    trailActivatePct,
    trailDistancePct,
    lastStopUpdateAt: new Date(now).toISOString(),
    lastSeenPriceUsd: entryPriceUsd,
    mcapUsd,
    liquidityUsd: liqUsdAtEntry || 0,
    txns1h: (pair?.txns?.h1?.buys || 0) + (pair?.txns?.h1?.sells || 0),
    signal,
    signalBuyDominance: Number.isFinite(signalBuyDominance) ? signalBuyDominance : null,
    signalTx1h: Number(signal?.tx1h || ((pair?.txns?.h1?.buys || 0) + (pair?.txns?.h1?.sells || 0))) || null,
    holdersAtEntry: snapHolders,
    uniqueBuyersAtEntry: snapUniqueBuyers,
    topHolderPctAtEntry: conc?.topHolderPct ?? null,
    top10PctAtEntry: conc?.top10Pct ?? null,
    bundleClusterPctAtEntry: conc?.bundleClusterPct ?? null,
    creatorClusterPctAtEntry: conc?.creatorClusterPct ?? null,
    lpLockPctAtEntry: conc?.lpLockPct ?? null,
    lpUnlockedAtEntry: conc?.lpUnlocked ?? null,
    spreadPctAtEntry: Number(entrySnapshot?.spreadPct ?? pair?.spreadPct ?? pair?.market?.spreadPct ?? NaN) || null,
    marketDataSourceAtEntry: entrySnapshot?.source || null,
    marketDataConfidenceAtEntry: entrySnapshot?.confidence || null,
    marketDataFreshnessMsAtEntry: Number(entrySnapshot?.freshnessMs || 0) || null,
    quotePriceImpactPctAtEntry: Number(entrySnapshot?.entryHints?.priceImpactPct || 0) || null,
    requestedSlippageBpsAtEntry: Number(slippageBps || 0) || null,
    maxPriceImpactPctAtEntry: Number(cfg.MAX_PRICE_IMPACT_PCT || 0) || null,
    rugScore: rugReport?.score_normalised,
    entryTx: res.signature,
    spentSolApprox: (fillInSol && fillInSol > 0) ? fillInSol : maxSol,
    spentSolTarget: maxSol,
    receivedTokensRaw: fillOut || null,
    entryFeeLamports: Number(res?.fill?.feeLamports || 0) || null,
    entryFeeUsd: Number(res?.fill?.feeLamports || 0) ? ((Number(res.fill.feeLamports) / 1e9) * solUsd) : null,
    solUsdAtEntry: solUsd,
    entryPriceSource: Number.isFinite(Number(liveEntryPriceUsd)) && Number(liveEntryPriceUsd) > 0 ? 'jupiter_fill' : (resolved.priceSource || null),
  };

  if (process.env.TIMESCALE_ENABLED === 'true') {
    import('../../timeseries_db.mjs').then(({ insertTradeEntry }) => {
      insertTradeEntry({
        timestamp: now,
        mint,
        entryPriceUsd,
        sizeUsd: usdTarget,
        signature: res?.signature || null,
        momentumScore: signal?.score || null,
        liquidityUsd: liqUsdAtEntry || null,
        source: 'live',
        metadata: { symbol, mcapUsdAtEntry, signalBuyDominance },
      }).catch(() => {});
    }).catch(() => {});
  }

  try {
    cache.set(`birdeye:sub:${mint}`, true, Math.ceil((cfg.BIRDEYE_LITE_CACHE_TTL_MS || 45000) / 1000));
  } catch {}

  const entryRow = {
    time: nowIso(),
    kind: 'entry',
    mint,
    symbol: display || null,
    entryAt: state.positions[mint].entryAt || null,
    entryTx: res.signature || null,
    spentSolApprox: (fillInSol && fillInSol > 0) ? fillInSol : maxSol,
    spentUsdTarget: Number(cfg.MAX_POSITION_USDC || usdTarget) || null,
    solUsdAtEntry: solUsd,
    entryPriceUsd: entryPriceUsd || null,
    entryPriceSource: state.positions[mint].entryPriceSource || null,
    entryFeeLamports: Number(res?.fill?.feeLamports || 0) || null,
    entryFeeUsd: Number(state.positions[mint].entryFeeUsd || 0) || null,
    liquidityUsdAtEntry: Number(liqUsdAtEntry || 0) || null,
    mcapUsdAtEntry: Number.isFinite(Number(mcapUsdAtEntry)) ? Number(mcapUsdAtEntry) : null,
    holdersAtEntry: Number(state.positions[mint].holdersAtEntry || 0) || null,
    uniqueBuyersAtEntry: Number(state.positions[mint].uniqueBuyersAtEntry || 0) || null,
    topHolderPctAtEntry: Number(state.positions[mint].topHolderPctAtEntry || 0) || null,
    top10PctAtEntry: Number(state.positions[mint].top10PctAtEntry || 0) || null,
    bundleClusterPctAtEntry: Number(state.positions[mint].bundleClusterPctAtEntry || 0) || null,
    creatorClusterPctAtEntry: Number(state.positions[mint].creatorClusterPctAtEntry || 0) || null,
    lpLockPctAtEntry: Number(state.positions[mint].lpLockPctAtEntry || 0) || null,
    lpUnlockedAtEntry: state.positions[mint].lpUnlockedAtEntry ?? null,
    signalBuyDominance: Number(state.positions[mint].signalBuyDominance || 0) || null,
    signalTx1h: Number(state.positions[mint].signalTx1h || 0) || null,
    spreadPctAtEntry: Number(state.positions[mint].spreadPctAtEntry || 0) || null,
    marketDataSourceAtEntry: state.positions[mint].marketDataSourceAtEntry || null,
    marketDataConfidenceAtEntry: state.positions[mint].marketDataConfidenceAtEntry || null,
    marketDataFreshnessMsAtEntry: Number(state.positions[mint].marketDataFreshnessMsAtEntry || 0) || null,
    quotePriceImpactPctAtEntry: Number(state.positions[mint].quotePriceImpactPctAtEntry || 0) || null,
    requestedSlippageBpsAtEntry: Number(state.positions[mint].requestedSlippageBpsAtEntry || 0) || null,
    maxPriceImpactPctAtEntry: Number(state.positions[mint].maxPriceImpactPctAtEntry || 0) || null,
    trailActivatePct: Number(state.positions[mint].trailActivatePct || cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT) || null,
    trailDistancePct: Number(state.positions[mint].trailDistancePct || cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT) || null,
    stopPriceUsdAtEntry: Number(state.positions[mint].stopPriceUsd || 0) || null,
    stopEvalMode: state.positions[mint].stopEvalMode || null,
  };
  try {
    appendJsonl(cfg.TRADES_LEDGER_PATH, entryRow);
  } catch (e) {
    try { await tgSend(cfg, `⚠️ ENTRY executed but failed to append entry ledger row for ${display} (${mint}): ${e.message || e}`); } catch {}
  }

  const entryHeader = tokenDisplayWithSymbol({
    name: tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
    symbol: symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
    mint,
  });
  const entryBasisSource = state.positions[mint].entryPriceSource || 'snapshot';
  const snapshotMarketPx = Number(entrySnapshot?.priceUsd || pair?.priceUsd || 0);
  const routePlan = Array.isArray(res?.route?.routePlan) ? res.route.routePlan : [];
  const routeHopCount = routePlan.length;
  const routeDexLabels = Array.from(new Set(routePlan.map((hop) => String(hop?.swapInfo?.label || '').trim()).filter(Boolean)));
  const routePoolKeys = Array.from(new Set(routePlan.map((hop) => String(hop?.swapInfo?.ammKey || '').trim()).filter(Boolean)));
  const executionDex = routeDexLabels.length ? routeDexLabels.join(' → ') : 'unknown';
  const executionPool = routePoolKeys.length ? routePoolKeys.join(' | ') : 'unknown';
  const executionRoute = routeHopCount <= 0
    ? 'Jupiter (no route metadata)'
    : (routeHopCount === 1 ? 'Jupiter single-hop' : `Jupiter multi-hop (${routeHopCount} hops)`);
  const tokensReceivedLine = (fillOutTokens && Number.isFinite(Number(fillOutTokens)) && Number(fillOutTokens) > 0)
    ? Number(fillOutTokens).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    : 'n/a';

  const msg = [
    `🟢 *ENTRY* — ${entryHeader}`,
    '',
    `🧾 Mint: \`${mint}\``,
    `💸 Spent: ~${((fillInSol && fillInSol > 0) ? fillInSol : maxSol).toFixed(4)} SOL (target≈ ${fmtUsd(usdTarget)})`,
    `🏷️ Entry basis (executed): $${entryPriceUsd} (${entryBasisSource})`,
    Number.isFinite(snapshotMarketPx) && snapshotMarketPx > 0
      ? `📊 Market snapshot: $${snapshotMarketPx.toFixed(10)} (${entrySnapshot?.source || 'snapshot'})`
      : `📊 Market snapshot: n/a (${entrySnapshot?.source || 'snapshot'})`,
    `🧩 Execution DEX: ${executionDex}`,
    `🏊 Pool: \`${executionPool}\``,
    `🛣️ Route: ${executionRoute}`,
    `🪙 Tokens received: ${tokensReceivedLine}`,
    `🟠 Stop: $${state.positions[mint].stopPriceUsd.toFixed(6)}  (entry hard stop)`,
    `🟣 Trail: adaptive tiers (<10%=no trail, ≥10%=12%, ≥25%=18%, ≥60%=22%, ≥120%=18%)`,
    '',
    `💧 Liq: ${fmtUsd(liqUsdAtEntry)}   🧢 Mcap: ${fmtUsd(mcapUsdAtEntry)}`,
    `🌞 SOLUSD: $${solUsd.toFixed(2)}`,
    '',
    `🧾 Tx: https://solscan.io/tx/${res.signature}`,
  ].join('\n');

  await tgSend(cfg, msg);
  appendTradingLog(cfg.TRADING_LOG_PATH,
    `\n## ENTRY ${display} (${mint})\n- time: ${nowIso()}\n- spentSolApprox: ${((fillInSol && fillInSol > 0) ? fillInSol : maxSol)}\n- spentUsdTarget: ${cfg.MAX_POSITION_USDC}\n- tokenPriceUsd: ${entryPriceUsd}\n- entryPriceSource: ${state.positions[mint].entryPriceSource || 'snapshot'}\n- solUsd: ${solUsd}\n- entryFeeLamports: ${Number(res?.fill?.feeLamports || 0) || 0}\n- tokensReceived: ${fillOutTokens || 'n/a'}\n- executionDex: ${executionDex}\n- executionPool: ${executionPool}\n- executionRoute: ${executionRoute}\n- mcapUsd: ${mcapUsd}\n- liquidityUsd: ${Number(liqUsdAtEntry || pair?.liquidity?.usd || pair?.birdeye?.raw?.liquidity || 0)}\n- signal: ${JSON.stringify(signal)}\n- rugScore: ${rugReport?.score_normalised}\n- tx: ${res.signature}\n`);

  return res;
}
