import path from 'node:path';

import cache from '../global_cache.mjs';
import { getRugcheckReport, isTokenSafe } from '../rugcheck.mjs';
import { getSolBalanceLamports } from '../portfolio.mjs';
import { passesBaseFilters, evaluateMomentumSignal } from '../strategy.mjs';
import { paperComputeMomentumWindows } from '../paper_momentum.mjs';
import { toBaseUnits, DECIMALS } from '../trader.mjs';
import { nowIso } from '../logger.mjs';
import { bump, bumpWatchlistFunnel } from '../metrics.mjs';
import { pushDebug } from '../debug_buffer.mjs';
import { safeMsg } from '../ai.mjs';
import { appendJsonl } from '../candidates_ledger.mjs';
import { jupQuote } from '../jupiter.mjs';
import { saveState } from '../state.mjs';
import { getSnapshotStatus, isEntrySnapshotSafe, getWatchlistEntrySnapshotUnsafeReason, snapshotFromBirdseye } from '../market_data_router.mjs';
import { canOpenNewEntry, recordEntryOpened, applySoftReserveToUsdTarget } from '../capital_guardrails.mjs';
import { promoteRouteAvailableCandidateToImmediate } from '../route_available_watchlist.mjs';
import { isMicroFreshEnough, applyMomentumPassHysteresis, getCachedMintCreatedAt, scheduleMintCreatedAtLookup } from '../lib/momentum_gate_controls.mjs';
import {
  CORE_MOMO_CHECKS,
  canaryMomoShouldSample,
  recordCanaryMomoFailChecks,
  coreMomentumProgress,
  decideMomentumBranch,
  normalizeEpochMs,
  applySnapshotToLatest,
  buildNormalizedMomentumInput,
  pruneMomentumRepeatFailMap,
} from '../watchlist_eval_helpers.mjs';
import {
  ensureWatchlistState,
  readPct,
  queueHotWatchlistMint,
  resolvePairCreatedAtGlobal,
  resolveWatchlistRouteMeta,
  cacheRouteReadyMint,
  bumpImmediateBlockedReason,
} from './watchlist_control.mjs';
import {
  holdersGateCheck,
  isPaperModeActive,
  ensureForceAttemptPolicyState,
  pruneForceAttemptPolicyWindows,
  evaluateForceAttemptPolicyGuards,
  recordForceAttemptPolicyAttempt,
} from './route_control.mjs';
import { entryCapacityAvailable, enforceEntryCapacityGate } from './position_policy.mjs';

function createWatchlistPipeline({
  confirmQualityGate,
  confirmContinuationGate,
  recordConfirmCarryTrace,
  resolveConfirmTxMetrics,
  resolveMintCreatedAtFromRpc,
  computeMcapUsd,
  openPosition,
  wsmgr,
}) {
  async function upsertWatchlistMint({ state, cfg, nowMs, tok, mint, pair, snapshot, counters, routeHint = false, birdseye = null }) {
    const wl = ensureWatchlistState(state);
    const prev = wl.mints[mint] || null;
    const liqUsd = Number(snapshot?.liquidityUsd || pair?.liquidity?.usd || 0);
    const mcapUsd = Number(snapshot?.marketCapUsd || pair?.marketCap || pair?.fdv || tok?.marketCap || 0);
    const spreadPct = Number(snapshot?.spreadPct ?? pair?.spreadPct ?? pair?.market?.spreadPct ?? pair?.raw?.spreadPct);
    const top10Pct = readPct(snapshot?.top10HoldersPct ?? snapshot?.top10Pct ?? pair?.top10HoldersPct ?? tok?.top10HoldersPct ?? tok?.top10Pct);
    const topHolderPct = readPct(snapshot?.topHolderPct ?? pair?.topHolderPct ?? tok?.topHolderPct);
    const bundleClusterPct = readPct(snapshot?.bundleClusterPct ?? pair?.bundleClusterPct ?? tok?.bundleClusterPct);
    const buys1h = Number(pair?.txns?.h1?.buys || 0);
    const sells1h = Number(pair?.txns?.h1?.sells || 0);
    const holders = Number(snapshot?.entryHints?.participation?.holders ?? snapshot?.pair?.participation?.holders ?? pair?.participation?.holders ?? tok?.holders ?? 0) || null;
    const resolvedPairCreatedAt = resolvePairCreatedAtGlobal(
      pair?.pairCreatedAt,
      snapshot?.pairCreatedAt,
      snapshot?.pair?.pairCreatedAt,
      tok?.pairCreatedAt,
      tok?.pair_created_at,
      tok?.createdAt,
      tok?.created_at,
      tok?.launchTime,
      prev?.latest?.pairCreatedAt,
      prev?.pair?.pairCreatedAt,
    );

    const next = {
      mint,
      symbol: pair?.baseToken?.symbol || tok?.tokenSymbol || prev?.symbol || null,
      source: tok?._source || prev?.source || 'dex',
      firstSeenAtMs: Number(prev?.firstSeenAtMs || nowMs),
      lastSeenAtMs: nowMs,
      lastEvaluatedAtMs: Number(prev?.lastEvaluatedAtMs || 0),
      lastAttemptAtMs: Number(prev?.lastAttemptAtMs || 0),
      lastFillAtMs: Number(prev?.lastFillAtMs || 0),
      lastTriggerHitAtMs: Number(prev?.lastTriggerHitAtMs || 0),
      cooldownUntilMs: Number(prev?.cooldownUntilMs || 0),
      hotPromotionCooldownUntilMs: Number(prev?.hotPromotionCooldownUntilMs || 0),
      attempts: Number(prev?.attempts || 0),
      staleCycles: Number(prev?.staleCycles || 0),
      totalAttempts: Number(prev?.totalAttempts || 0),
      totalFills: Number(prev?.totalFills || 0),
      routeHint: routeHint || prev?.routeHint === true,
      pair,
      snapshot,
      latest: {
        priceUsd: Number(snapshot?.priceUsd || pair?.priceUsd || 0) || null,
        liqUsd,
        v1h: Number(pair?.volume?.h1 || 0),
        v4h: Number(pair?.volume?.h4 || 0),
        buys1h,
        sells1h,
        tx1h: buys1h + sells1h,
        pc1h: Number(pair?.priceChange?.h1 || 0),
        pc4h: Number(pair?.priceChange?.h4 || 0),
        mcapUsd: Number.isFinite(mcapUsd) ? mcapUsd : null,
        spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
        top10Pct,
        topHolderPct,
        bundleClusterPct,
        holders,
        priceImpactPct: Number(snapshot?.entryHints?.priceImpactPct ?? pair?.priceImpactPct ?? prev?.latest?.priceImpactPct ?? 0) || null,
        marketDataSource: snapshot?.source || null,
        marketDataFreshnessMs: snapshot?.freshnessMs ?? null,
        marketDataConfidence: snapshot?.confidence || null,
        pairCreatedAt: resolvedPairCreatedAt,
      },
      evictAtMs: nowMs + cfg.WATCHLIST_MINT_TTL_MS,
    };
    wl.mints[mint] = next;
    recordConfirmCarryTrace(state, mint, 'postUpsert', {
      carryPresent: !!(next?.meta?.confirmTxCarry && Number(next.meta.confirmTxCarry?.atMs || 0) > 0),
      carryTx1m: Number(next?.meta?.confirmTxCarry?.tx1m || 0) || null,
      carryTx5mAvg: Number(next?.meta?.confirmTxCarry?.tx5mAvg || 0) || null,
      carryBuySellRatio: Number(next?.meta?.confirmTxCarry?.buySellRatio || 0) || null,
      rowPath: `watchlist.mints.${mint}.meta.confirmTxCarry`,
    });
    if (prev) {
      wl.stats.refreshed = Number(wl.stats.refreshed || 0) + 1;
      counters.watchlist.refreshed += 1;
    } else {
      wl.stats.ingested = Number(wl.stats.ingested || 0) + 1;
      counters.watchlist.ingested += 1;
    }
    const prevMeta = prev?.meta || {};
    const tx30s = Number(snapshot?.txns?.s30?.buys || 0) + Number(snapshot?.txns?.s30?.sells || 0);
    const tx5m = Number(snapshot?.txns?.m5?.buys || 0) + Number(snapshot?.txns?.m5?.sells || 0);
    const tx5mAvg = tx5m > 0 ? (tx5m / 10) : Number(prevMeta.tx5mAvg || 0);
    const tx30sBuys = Number(snapshot?.txns?.s30?.buys || 0);
    const uniqueBuyers = Number(snapshot?.entryHints?.participation?.uniqueBuyers || snapshot?.pair?.participation?.uniqueBuyers || 0);
    const uniqueBuyersBase = Number(prevMeta.uniqueBuyersBase || uniqueBuyers || 0);
    const uniqueBuyerSpike = uniqueBuyers > 0 && (uniqueBuyersBase <= 0 ? uniqueBuyers >= 3 : uniqueBuyers >= Math.max(3, uniqueBuyersBase * 1.5));
    const txAccelTrigger = tx30s > (1.8 * Math.max(1, tx5mAvg));
    const burstBuysTrigger = tx30sBuys >= 3;
    const priceImpactNow = Number(next?.latest?.priceImpactPct || prev?.latest?.priceImpactPct || 0);
    const priceImpactBase = Number(prevMeta.priceImpactBase || priceImpactNow || 0);
    const priceImpactSpike = priceImpactNow > 0 && priceImpactBase > 0 && priceImpactNow > (2.5 * priceImpactBase);

    const tx1mNow = Number(next?.latest?.tx1m ?? snapshot?.tx_1m ?? 0);
    const tx5mAvgNow = Number(next?.latest?.tx5mAvg ?? snapshot?.tx_5m_avg ?? 0);
    const uniqueBuyers1mNow = Number(next?.latest?.uniqueBuyers1m ?? snapshot?.uniqueBuyers1m ?? 0);
    const uniqueBuyers5mRaw = Number(next?.latest?.uniqueBuyers5m ?? snapshot?.uniqueBuyers5m ?? 0);
    const uniqueBuyers5mAvgNow = uniqueBuyers5mRaw > 0 ? (uniqueBuyers5mRaw / 5) : 0;
    const buySellRatioNow = Number(next?.latest?.buySellRatio ?? snapshot?.buySellRatio ?? 0);
    const txAccelRatio = tx1mNow / Math.max(0.0001, tx5mAvgNow);
    const walletExpansionRatio = uniqueBuyers1mNow / Math.max(0.0001, uniqueBuyers5mAvgNow);
    const priceImpactExpansionRatio = priceImpactNow / Math.max(0.0001, priceImpactBase || priceImpactNow || 0.0001);
    const buySellRatioBase = Number(prevMeta.buySellRatioBase || buySellRatioNow || 0);
    const buyDominanceTrend = (buySellRatioNow - buySellRatioBase);

    next.meta = {
      ...(next.meta || {}),
      tx5mAvg: tx5mAvg || null,
      uniqueBuyersBase: uniqueBuyersBase > 0 ? uniqueBuyersBase : (uniqueBuyers || null),
      priceImpactBase: priceImpactBase > 0 ? priceImpactBase : (priceImpactNow || null),
      buySellRatioBase: buySellRatioBase > 0 ? buySellRatioBase : (buySellRatioNow || null),
      preHotMissingFieldsCooldownUntilMs: Number(prevMeta.preHotMissingFieldsCooldownUntilMs || 0),
      preHotMissingFieldsLast: Array.isArray(prevMeta.preHotMissingFieldsLast) ? prevMeta.preHotMissingFieldsLast : [],
      confirmTxCarry: (prevMeta?.confirmTxCarry && Number(prevMeta.confirmTxCarry?.atMs || 0) > 0)
        ? prevMeta.confirmTxCarry
        : null,
    };

    const requiredMissingNow = [];
    const pairCreatedAt0 = Number(next?.latest?.pairCreatedAt || 0) || null;
    const poolAgeSec0 = pairCreatedAt0 ? Math.max(0, (nowMs - pairCreatedAt0) / 1000) : null;
    if (!(mcapUsd > 0)) requiredMissingNow.push('mcap');
    if (!(liqUsd > 0)) requiredMissingNow.push('liquidity');
    if (!(poolAgeSec0 != null)) requiredMissingNow.push('age');
    if (!(top10Pct != null)) requiredMissingNow.push('top10');

    if (requiredMissingNow.length > 0
      && birdseye?.enabled
      && typeof birdseye?.getTokenSnapshot === 'function'
      && Number(next.meta.preHotMissingFieldsCooldownUntilMs || 0) <= nowMs) {
      counters.watchlist.preHotMissingFetchAttempted = Number(counters.watchlist.preHotMissingFetchAttempted || 0) + 1;
      try {
        const preHotLite = await birdseye.getTokenSnapshot(mint);
        if (preHotLite) {
          counters.watchlist.preHotMissingFetchSucceeded = Number(counters.watchlist.preHotMissingFetchSucceeded || 0) + 1;
          if (Number(preHotLite?.liquidityUsd || 0) > 0) next.latest.liqUsd = Number(preHotLite.liquidityUsd);
          if (Number(preHotLite?.marketCapUsd || 0) > 0) next.latest.mcapUsd = Number(preHotLite.marketCapUsd);
          if (Number(preHotLite?.pairCreatedAt || 0) > 0) next.latest.pairCreatedAt = Number(preHotLite.pairCreatedAt);
          const t10 = readPct(preHotLite?.top10HoldersPct ?? preHotLite?.top10Pct);
          if (t10 != null) next.latest.top10Pct = t10;
          const th = readPct(preHotLite?.topHolderPct);
          if (th != null) next.latest.topHolderPct = th;
          const bc = readPct(preHotLite?.bundleClusterPct);
          if (bc != null) next.latest.bundleClusterPct = bc;
          const sp = Number(preHotLite?.spreadPct);
          if (Number.isFinite(sp)) next.latest.spreadPct = sp;
        }
      } catch {}
    }

    const PRE_RUNNER_ENABLED = !!cfg.PRE_RUNNER_ENABLED;
    const PRE_RUNNER_TX_ACCEL_MIN = Number(cfg.PRE_RUNNER_TX_ACCEL_MIN || 0);
    const PRE_RUNNER_WALLET_EXPANSION_MIN = Number(cfg.PRE_RUNNER_WALLET_EXPANSION_MIN || 0);
    const PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN = Number(cfg.PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN || 0);
    const PRE_RUNNER_FAST_WINDOW_MS = Number(cfg.PRE_RUNNER_FAST_WINDOW_MS || 60_000);
    const HOT_MIN_ABS_TX1H_HEALTHY = Number(cfg.HOT_MIN_ABS_TX1H_HEALTHY || 0);
    const HOT_MIN_ABS_VOLUME_5M_HEALTHY = Number(cfg.HOT_MIN_ABS_VOLUME_5M_HEALTHY || 0);
    const BURST_PROMOTION_ENABLED = !!cfg.BURST_PROMOTION_ENABLED;
    const BURST_TX_ACCEL_MIN = Number(cfg.BURST_TX_ACCEL_MIN || 0);
    const BURST_WALLET_EXPANSION_MIN = Number(cfg.BURST_WALLET_EXPANSION_MIN || 0);
    const BURST_VOLUME_EXPANSION_MIN = Number(cfg.BURST_VOLUME_EXPANSION_MIN || 0);
    const BURST_FAST_WINDOW_MS = Number(cfg.BURST_FAST_WINDOW_MS || 45_000);

    let hotReason = txAccelTrigger ? 'tx30sAccel' : uniqueBuyerSpike ? 'uniqueBuyersSpike' : burstBuysTrigger ? 'burstBuys' : priceImpactSpike ? 'jupPriceImpactSpike' : (next.routeHint ? 'routeHint' : null);
    if (PRE_RUNNER_ENABLED && !hotReason) {
      if (txAccelRatio >= PRE_RUNNER_TX_ACCEL_MIN || walletExpansionRatio >= PRE_RUNNER_WALLET_EXPANSION_MIN || priceImpactExpansionRatio >= PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN) hotReason = 'preRunnerSignal';
    }

    if (hotReason) {
      if (Number(next.hotPromotionCooldownUntilMs || 0) > nowMs) {
        counters.watchlist.preHotFailedByReason ||= {};
        counters.watchlist.preHotFailedByReason.cooldown = Number(counters.watchlist.preHotFailedByReason.cooldown || 0) + 1;
        return;
      }
      counters.watchlist.preHotConsidered = Number(counters.watchlist.preHotConsidered || 0) + 1;
      counters.watchlist.preHotFailedByReason ||= {};

      const liqEff = Number(next?.latest?.liqUsd || 0);
      const mcapEff = Number(next?.latest?.mcapUsd || 0);
      const top10Eff = readPct(next?.latest?.top10Pct);
      const topHolderEff = readPct(next?.latest?.topHolderPct);
      const bundleEff = readPct(next?.latest?.bundleClusterPct);
      const spreadEff = Number(next?.latest?.spreadPct);
      const holdersEff = Number(next?.latest?.holders || 0) || null;
      const pairCreatedAt = Number(next?.latest?.pairCreatedAt || 0) || null;
      const poolAgeSec = pairCreatedAt ? Math.max(0, (nowMs - pairCreatedAt) / 1000) : null;
      const missing = [];
      if (!(liqEff > 0)) missing.push('liquidity');
      if (!(top10Eff != null)) missing.push('top10');
      if (!(holdersEff != null) && !cfg.HOLDER_MISSING_SOFT_ALLOW) missing.push('holders');

      const failReasons = [];
      if (missing.length) {
        failReasons.push(...missing);
        counters.watchlist.preHotMissingStillMissing = Number(counters.watchlist.preHotMissingStillMissing || 0) + 1;
        next.meta.preHotMissingFieldsCooldownUntilMs = nowMs + (10 * 60_000);
        next.meta.preHotMissingFieldsLast = missing;
        pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: `preHot(missing:${missing.join(',')})` });
      }
      const maxTop10Pct = Number(cfg.MAX_TOP10_PCT || 38);
      const maxTopHolderPct = Number(cfg.MAX_TOP_HOLDER_PCT || 3.5);
      const maxBundlePct = Number(cfg.MAX_BUNDLE_CLUSTER_PCT || 15);
      const preHotMinLiqUsd = Number(state?.filterOverrides?.MIN_LIQUIDITY_FLOOR_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 120_000);
      if (liqEff > 0 && liqEff < preHotMinLiqUsd) failReasons.push('liquidity');
      if (top10Eff != null && top10Eff > maxTop10Pct) failReasons.push('top10');
      if (topHolderEff != null && topHolderEff > maxTopHolderPct) failReasons.push('topHolder');
      if (bundleEff != null && bundleEff > maxBundlePct) failReasons.push('bundleCluster');
      if (Number.isFinite(spreadEff) && spreadEff > 3) failReasons.push('spread');

      const holderGate = holdersGateCheck({ cfg, holders: holdersEff, poolAgeSec });
      if (!holderGate.ok) failReasons.push(holderGate.reason);

      const prevTopHolder = Number(next?.meta?.prevTopHolderPct ?? NaN);
      const prevTop10 = Number(next?.meta?.prevTop10Pct ?? NaN);
      if (Number.isFinite(prevTopHolder) && topHolderEff != null && (topHolderEff - prevTopHolder) >= 1.5) failReasons.push('topHolderJump');
      if (Number.isFinite(prevTop10) && top10Eff != null && (top10Eff - prevTop10) >= 4) failReasons.push('top10Jump');
      if (topHolderEff != null) next.meta.prevTopHolderPct = topHolderEff;
      if (top10Eff != null) next.meta.prevTop10Pct = top10Eff;

      counters.watchlist.preRunnerRejectedByReason ||= {};
      counters.watchlist.preRunnerLast10 ||= [];
      const snapshotFreshEnough = Number(next?.latest?.marketDataFreshnessMs ?? snapshot?.freshnessMs ?? Infinity) <= Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 45_000);
      const preRunnerLiquidityPass = liqEff >= preHotMinLiqUsd;
      const txAccelBaseline = Number(prevMeta.txAccelRatioBase || txAccelRatio || 0);
      const walletExpansionBaseline = Number(prevMeta.walletExpansionRatioBase || walletExpansionRatio || 0);
      const priceImpactExpansionBaseline = Number(prevMeta.priceImpactExpansionRatioBase || priceImpactExpansionRatio || 0);
      const txAccelRising = txAccelRatio >= PRE_RUNNER_TX_ACCEL_MIN && txAccelRatio >= txAccelBaseline;
      const walletRising = walletExpansionRatio >= PRE_RUNNER_WALLET_EXPANSION_MIN && walletExpansionRatio >= walletExpansionBaseline;
      const buyDominanceImprovingOrPositive = (buySellRatioNow > 1.0) || (buyDominanceTrend > 0);
      const impactExpanding = priceImpactExpansionRatio >= PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN && priceImpactExpansionRatio >= priceImpactExpansionBaseline;
      const noHardSafetyReject = failReasons.length === 0;

      counters.watchlist.burstRejectedByReason ||= {};
      counters.watchlist.burstLast10 ||= [];
      const burstVolume5m = Number(next?.latest?.volume5m ?? snapshot?.volume_5m ?? snapshot?.pair?.birdeye?.volume_5m ?? 0);
      const burstVolume30mAvg = Number(next?.latest?.volume30mAvg ?? snapshot?.volume_30m_avg ?? snapshot?.pair?.birdeye?.volume_30m_avg ?? 0);
      const volumeExpansionRatio = Number(burstVolume5m || 0) / Math.max(0.0001, Number(burstVolume30mAvg || 0));
      const volumeNeutralOrPositive = volumeExpansionRatio >= BURST_VOLUME_EXPANSION_MIN;
      const burstTxImproving = txAccelRatio >= BURST_TX_ACCEL_MIN && txAccelRatio >= txAccelBaseline;
      const burstWalletImproving = walletExpansionRatio >= BURST_WALLET_EXPANSION_MIN && walletExpansionRatio >= walletExpansionBaseline;
      const burstBuySellImproving = (buyDominanceTrend > 0) || (buySellRatioNow > 1.0);
      const burstSignal = BURST_PROMOTION_ENABLED && snapshotFreshEnough && preRunnerLiquidityPass && burstTxImproving && burstWalletImproving && burstBuySellImproving && volumeNeutralOrPositive && noHardSafetyReject;

      const preRunner = PRE_RUNNER_ENABLED && snapshotFreshEnough && preRunnerLiquidityPass && txAccelRising && walletRising && buyDominanceImprovingOrPositive && impactExpanding && noHardSafetyReject;

      next.meta.txAccelRatioBase = txAccelRatio > 0 ? txAccelRatio : txAccelBaseline;
      next.meta.walletExpansionRatioBase = walletExpansionRatio > 0 ? walletExpansionRatio : walletExpansionBaseline;
      next.meta.priceImpactExpansionRatioBase = priceImpactExpansionRatio > 0 ? priceImpactExpansionRatio : priceImpactExpansionBaseline;

      if (burstSignal) {
        counters.watchlist.burstTagged = Number(counters.watchlist.burstTagged || 0) + 1;
        counters.watchlist.burstTxAccelSum = Number(counters.watchlist.burstTxAccelSum || 0) + Number(txAccelRatio || 0);
        counters.watchlist.burstWalletExpansionSum = Number(counters.watchlist.burstWalletExpansionSum || 0) + Number(walletExpansionRatio || 0);
        counters.watchlist.burstBuySellRatioSum = Number(counters.watchlist.burstBuySellRatioSum || 0) + Number(buySellRatioNow || 0);
        next.meta.burst = {
          active: true,
          taggedAtMs: Number(next?.meta?.burst?.taggedAtMs || nowMs),
          lastSeenAtMs: nowMs,
          fastUntilMs: nowMs + BURST_FAST_WINDOW_MS,
          txAccelRatio,
          walletExpansionRatio,
          buySellRatio: buySellRatioNow,
          volumeExpansionRatio,
        };
        counters.watchlist.burstLast10.push({ tMs: nowMs, mint, liquidity: liqEff, txAccelRatio, walletExpansionRatio, buySellRatio: buySellRatioNow, volumeExpansionRatio, finalStageReached: 'tagged' });
        while (counters.watchlist.burstLast10.length > 10) counters.watchlist.burstLast10.shift();
      } else if (BURST_PROMOTION_ENABLED) {
        if (!snapshotFreshEnough) counters.watchlist.burstRejectedByReason.snapshotFreshness = Number(counters.watchlist.burstRejectedByReason.snapshotFreshness || 0) + 1;
        if (!preRunnerLiquidityPass) counters.watchlist.burstRejectedByReason.liquidity = Number(counters.watchlist.burstRejectedByReason.liquidity || 0) + 1;
        if (!burstTxImproving) counters.watchlist.burstRejectedByReason.txAccel = Number(counters.watchlist.burstRejectedByReason.txAccel || 0) + 1;
        if (!burstWalletImproving) counters.watchlist.burstRejectedByReason.walletExpansion = Number(counters.watchlist.burstRejectedByReason.walletExpansion || 0) + 1;
        if (!burstBuySellImproving) counters.watchlist.burstRejectedByReason.buySellTrend = Number(counters.watchlist.burstRejectedByReason.buySellTrend || 0) + 1;
        if (!volumeNeutralOrPositive) counters.watchlist.burstRejectedByReason.volumeExpansion = Number(counters.watchlist.burstRejectedByReason.volumeExpansion || 0) + 1;
        if (!noHardSafetyReject) counters.watchlist.burstRejectedByReason.hardSafetyReject = Number(counters.watchlist.burstRejectedByReason.hardSafetyReject || 0) + 1;
      }

      if (preRunner) {
        counters.watchlist.preRunnerTagged = Number(counters.watchlist.preRunnerTagged || 0) + 1;
        next.meta.preRunner = { active: true, taggedAtMs: Number(next?.meta?.preRunner?.taggedAtMs || nowMs), lastSeenAtMs: nowMs, fastUntilMs: nowMs + PRE_RUNNER_FAST_WINDOW_MS, txAccelRatio, walletExpansionRatio, priceImpactExpansionRatio, buySellRatio: buySellRatioNow };
        counters.watchlist.preRunnerLast10.push({ tMs: nowMs, mint, liquidity: liqEff, txAccelRatio, walletExpansionRatio, priceImpactExpansionRatio, buySellRatio: buySellRatioNow, finalStageReached: 'tagged' });
        while (counters.watchlist.preRunnerLast10.length > 10) counters.watchlist.preRunnerLast10.shift();
      } else if (PRE_RUNNER_ENABLED) {
        if (!snapshotFreshEnough) counters.watchlist.preRunnerRejectedByReason.snapshotFreshness = Number(counters.watchlist.preRunnerRejectedByReason.snapshotFreshness || 0) + 1;
        if (!preRunnerLiquidityPass) counters.watchlist.preRunnerRejectedByReason.liquidity = Number(counters.watchlist.preRunnerRejectedByReason.liquidity || 0) + 1;
        if (!txAccelRising) counters.watchlist.preRunnerRejectedByReason.txAccel = Number(counters.watchlist.preRunnerRejectedByReason.txAccel || 0) + 1;
        if (!walletRising) counters.watchlist.preRunnerRejectedByReason.walletExpansion = Number(counters.watchlist.preRunnerRejectedByReason.walletExpansion || 0) + 1;
        if (!buyDominanceImprovingOrPositive) counters.watchlist.preRunnerRejectedByReason.buyDominanceTrend = Number(counters.watchlist.preRunnerRejectedByReason.buyDominanceTrend || 0) + 1;
        if (!impactExpanding) counters.watchlist.preRunnerRejectedByReason.priceImpactExpansion = Number(counters.watchlist.preRunnerRejectedByReason.priceImpactExpansion || 0) + 1;
        if (!noHardSafetyReject) counters.watchlist.preRunnerRejectedByReason.hardSafetyReject = Number(counters.watchlist.preRunnerRejectedByReason.hardSafetyReject || 0) + 1;
      }

      if (failReasons.length > 0) {
        counters.watchlist.preHotFailed = Number(counters.watchlist.preHotFailed || 0) + 1;
        for (const r of failReasons) counters.watchlist.preHotFailedByReason[r] = Number(counters.watchlist.preHotFailedByReason[r] || 0) + 1;
        next.hotPromotionCooldownUntilMs = nowMs + (5 * 60_000);
      } else {
        counters.watchlist.preHotPassed = Number(counters.watchlist.preHotPassed || 0) + 1;
        if (bundleClusterPct == null) pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: 'preHot(bundleClusterMissing_nonBlocking)' });
        if (!Number.isFinite(spreadPct)) pushDebug(state, { t: nowIso(), mint, symbol: next?.symbol || null, reason: 'preHot(spreadMissing_nonBlocking)' });

        const absTx1hNow = Number(next?.latest?.tx1h || 0);
        const absVolume5mNow = Number(next?.latest?.volume5m ?? snapshot?.volume_5m ?? snapshot?.pair?.birdeye?.volume_5m ?? 0);
        const absTxHealthy = absTx1hNow >= HOT_MIN_ABS_TX1H_HEALTHY;
        const absVolumeHealthy = absVolume5mNow >= HOT_MIN_ABS_VOLUME_5M_HEALTHY;
        const hotPriority = 10 + Math.min(4, Math.floor(Math.log10(Math.max(1, liqEff)))) + Math.min(4, Math.floor(Number(next?.latest?.tx1h || 0) / 40)) + (txAccelTrigger ? 2 : 0) + (uniqueBuyerSpike ? 2 : 0) + (burstBuysTrigger ? 1 : 0) + (priceImpactSpike ? 1 : 0) + (absTxHealthy ? 2 : 0) + (absVolumeHealthy ? 2 : 0) + ((absTxHealthy && absVolumeHealthy) ? 2 : 0);
        if (Number(next.hotPromotionCooldownUntilMs || 0) <= nowMs) {
          queueHotWatchlistMint({ state, cfg, mint, nowMs, priority: hotPriority, reason: hotReason, counters });
          counters.watchlist.hotEnqueued += 1;
        }
      }
    }
  }

  function bumpRouteAvailableDropped(counters, reason) {
    counters.route.routeAvailableDropped ||= {};
    const key = String(reason || 'unknown');
    counters.route.routeAvailableDropped[key] = Number(counters.route.routeAvailableDropped[key] || 0) + 1;
  }

  async function promoteRouteAvailableCandidate({ state, cfg, counters, nowMs, tok, mint, immediateRows, immediateRowMints, birdseye = null }) {
    counters.route.routeAvailableSeen = Number(counters.route.routeAvailableSeen || 0) + 1;
    if (!cfg.WATCHLIST_TRIGGER_MODE) {
      bumpRouteAvailableDropped(counters, 'watchlistDisabled');
      return false;
    }

    const routePairCreatedAt = resolvePairCreatedAtGlobal(
      tok?.pairCreatedAt,
      tok?.pair_created_at,
      tok?.createdAt,
      tok?.created_at,
      tok?.launchTime,
    );

    const syntheticPair = {
      baseToken: { address: mint, symbol: tok?.tokenSymbol || null },
      liquidity: { usd: 0 },
      volume: { h1: 0, h4: 0 },
      txns: { h1: { buys: 0, sells: 0 } },
      priceChange: { h1: 0, h4: 0 },
      pairCreatedAt: routePairCreatedAt,
      pairAddress: null,
      dexId: tok?._source || 'route',
      priceUsd: null,
    };
    const syntheticSnapshot = {
      priceUsd: null,
      liquidityUsd: 0,
      source: 'routeAvailableOnly',
      freshnessMs: 0,
      confidenceScore: 0,
      confidence: 'low',
    };

    await upsertWatchlistMint({ state, cfg, nowMs, tok, mint, pair: syntheticPair, snapshot: syntheticSnapshot, counters, routeHint: true, birdseye });
    const row = state.watchlist?.mints?.[mint] || null;
    if (!row) {
      bumpRouteAvailableDropped(counters, 'watchlistUpsertFailed');
      return false;
    }

    const promotion = promoteRouteAvailableCandidateToImmediate({ mint, row, nowMs, dedupMs: cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS, immediateRows, immediateRowMints });
    if (!promotion.promoted) {
      bumpRouteAvailableDropped(counters, promotion.reason);
      return false;
    }

    counters.watchlist.immediateRoutePromoted += 1;
    counters.route.routeAvailablePromotedToWatchlist = Number(counters.route.routeAvailablePromotedToWatchlist || 0) + 1;
    return true;
  }

  async function evaluateWatchlistRows(args) {
    /* extracted wholesale from index.mjs to keep the control tower focused on orchestration */
    return (await import('./watchlist_pipeline_runtime.mjs')).evaluateWatchlistRowsRuntime({
      ...args,
      deps: {
        confirmQualityGate,
        confirmContinuationGate,
        recordConfirmCarryTrace,
        resolveConfirmTxMetrics,
        resolveMintCreatedAtFromRpc,
        computeMcapUsd,
        openPosition,
        wsmgr,
      },
      runtimeDeps: {
        path,
        cache,
        getRugcheckReport,
        isTokenSafe,
        getSolBalanceLamports,
        passesBaseFilters,
        evaluateMomentumSignal,
        paperComputeMomentumWindows,
        toBaseUnits,
        DECIMALS,
        nowIso,
        bump,
        bumpWatchlistFunnel,
        pushDebug,
        safeMsg,
        appendJsonl,
        jupQuote,
        saveState,
        getSnapshotStatus,
        isEntrySnapshotSafe,
        getWatchlistEntrySnapshotUnsafeReason,
        snapshotFromBirdseye,
        canOpenNewEntry,
        recordEntryOpened,
        applySoftReserveToUsdTarget,
        isMicroFreshEnough,
        applyMomentumPassHysteresis,
        getCachedMintCreatedAt,
        scheduleMintCreatedAtLookup,
        CORE_MOMO_CHECKS,
        canaryMomoShouldSample,
        recordCanaryMomoFailChecks,
        coreMomentumProgress,
        decideMomentumBranch,
        normalizeEpochMs,
        applySnapshotToLatest,
        buildNormalizedMomentumInput,
        pruneMomentumRepeatFailMap,
        ensureWatchlistState,
        readPct,
        queueHotWatchlistMint,
        resolvePairCreatedAtGlobal,
        resolveWatchlistRouteMeta,
        cacheRouteReadyMint,
        bumpImmediateBlockedReason,
        holdersGateCheck,
        isPaperModeActive,
        ensureForceAttemptPolicyState,
        pruneForceAttemptPolicyWindows,
        evaluateForceAttemptPolicyGuards,
        recordForceAttemptPolicyAttempt,
        entryCapacityAvailable,
        enforceEntryCapacityGate,
      },
    });
  }

  return {
    upsertWatchlistMint,
    promoteRouteAvailableCandidate,
    evaluateWatchlistRows,
  };
}

const __legacyCreateWatchlistPipeline = createWatchlistPipeline;
void __legacyCreateWatchlistPipeline;

export { default } from './watchlist_pipeline/index.mjs';
export * from './watchlist_pipeline/index.mjs';
