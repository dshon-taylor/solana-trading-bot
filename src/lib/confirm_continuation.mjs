import sharedCache from '../global_cache.mjs';

const DEFAULT_SLEEP_MS = 120;
const DEFAULT_WS_FRESH_MS = 15_000;
const DEFAULT_SUB_REFRESH_MS = 3_000;

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function readRuntimeTuning() {
  return {
    active: (process.env.CONFIRM_CONTINUATION_ACTIVE ?? 'false') === 'true',
    windowMs: Math.max(250, toNum(process.env.CONFIRM_CONTINUATION_WINDOW_MS, 15_000)),
    passPct: Math.max(0, toNum(process.env.CONFIRM_CONTINUATION_PASS_PCT, 0.015)),
    hardFailDipPct: Math.max(0, toNum(process.env.CONFIRM_CONTINUATION_HARD_FAIL_DIP_PCT, 0.015)),
    wsFreshMs: Math.max(500, toNum(process.env.CONFIRM_CONTINUATION_WS_FRESH_MS, DEFAULT_WS_FRESH_MS)),
    sleepMs: Math.max(25, toNum(process.env.CONFIRM_CONTINUATION_SLEEP_MS, DEFAULT_SLEEP_MS)),
    subRefreshMs: Math.max(500, toNum(process.env.CONFIRM_CONTINUATION_SUB_REFRESH_MS, DEFAULT_SUB_REFRESH_MS)),
    requireTradeUpticks: (process.env.CONFIRM_CONTINUATION_REQUIRE_TRADE_UPTICKS ?? 'false') === 'true',
    minConsecutiveTradeUpticks: Math.max(1, Math.floor(toNum(process.env.CONFIRM_CONTINUATION_MIN_CONSECUTIVE_TRADE_UPTICKS, 2))),
  };
}

function mkDiagBase({ startPrice, highPrice, lowPrice, finalPrice, passReason, failReason, priceSource, timeToRunupPassMs, timeoutWasFlatOrNegative, wsReads, wsFreshReads, wsObservedTicks, snapshotReads, confirmStartedAtMs, wsUpdateTimestamps, wsUpdatePrices, tradeUpdateTimestamps, tradeUpdatePrices, selectedTradeReads, selectedOhlcvReads, consecutiveTradeUpticks, maxConsecutiveTradeUpticks, requireTradeUpticks, minConsecutiveTradeUpticks }) {
  return {
    startPrice,
    highPrice,
    lowPrice,
    finalPrice,
    maxRunupPctWithinConfirm: startPrice > 0 ? ((highPrice / startPrice) - 1) : null,
    maxDipPctWithinConfirm: startPrice > 0 ? ((startPrice - lowPrice) / startPrice) : null,
    passReason,
    failReason,
    priceSource,
    timeToRunupPassMs,
    timeoutWasFlatOrNegative,
    wsReads,
    wsFreshReads,
    wsObservedTicks,
    snapshotReads,
    confirmStartedAtMs,
    wsUpdateCountWithinWindow: Array.isArray(wsUpdateTimestamps) ? wsUpdateTimestamps.length : 0,
    uniqueOhlcvTicksWithinWindow: Array.isArray(wsUpdateTimestamps) ? wsUpdateTimestamps.length : 0,
    wsUpdateTimestamps: Array.isArray(wsUpdateTimestamps) ? wsUpdateTimestamps : [],
    wsUpdatePrices: Array.isArray(wsUpdatePrices) ? wsUpdatePrices : [],
    tradeUpdateCountWithinWindow: Array.isArray(tradeUpdateTimestamps) ? tradeUpdateTimestamps.length : 0,
    uniqueTradeTicksWithinWindow: Array.isArray(tradeUpdateTimestamps) ? tradeUpdateTimestamps.length : 0,
    tradeUpdateTimestamps: Array.isArray(tradeUpdateTimestamps) ? tradeUpdateTimestamps : [],
    tradeUpdatePrices: Array.isArray(tradeUpdatePrices) ? tradeUpdatePrices : [],
    selectedTradeReads: Number(selectedTradeReads || 0),
    selectedOhlcvReads: Number(selectedOhlcvReads || 0),
    consecutiveTradeUpticks: Number(consecutiveTradeUpticks || 0),
    maxConsecutiveTradeUpticks: Number(maxConsecutiveTradeUpticks || 0),
    requireTradeUpticks: !!requireTradeUpticks,
    minConsecutiveTradeUpticks: Number(minConsecutiveTradeUpticks || 0),
  };
}

export async function confirmContinuationGate({
  cfg,
  mint,
  row,
  snapshot,
  pair,
  confirmMinLiqUsd,
  confirmPriceImpactPct,
  confirmStartLiqUsd = null,
  cacheImpl = sharedCache,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  tuning = null,
}) {
  const rt = tuning || readRuntimeTuning();
  if (!rt.active) return { ok: true, mode: 'legacy' };

  const ensureSubTtlSec = Math.max(30, Math.ceil((rt.windowMs + 15_000) / 1000));
  const ensureSub = () => {
    try {
      cacheImpl.set(`birdeye:sub:${mint}`, true, ensureSubTtlSec);
      return true;
    } catch {
      return false;
    }
  };
  ensureSub();

  let wsReads = 0;
  let wsFreshReads = 0;
  let wsObservedTicks = 0;
  let snapshotReads = 0;
  let selectedTradeReads = 0;
  let selectedOhlcvReads = 0;
  let lastSubRefreshMs = nowFn();
  let lastWsTsSeen = 0;
  let lastTradeTsSeen = 0;
  const wsUpdateTimestamps = [];
  const wsUpdatePrices = [];
  const tradeUpdateTimestamps = [];
  const tradeUpdatePrices = [];
  let consecutiveTradeUpticks = 0;
  let maxConsecutiveTradeUpticks = 0;
  let prevTradePriceForTrend = null;
  let runupSeenInWindow = false;

  const readWsOrFallbackPrice = (nowMs) => {
    const txArr = cacheImpl.get(`birdeye:ws:tx:${mint}`) || [];
    const latestTrade = Array.isArray(txArr) ? [...txArr].reverse().find((x) => Number.isFinite(Number(x?.priceUsd)) && Number(x?.priceUsd) > 0) : null;
    const tradePrice = toNum(latestTrade?.priceUsd, 0);
    const tradeTsMs = toNum(latestTrade?.t, 0);
    const tradeFreshMs = tradeTsMs > 0 ? (nowMs - tradeTsMs) : null;
    const tradeFreshEnough = tradeFreshMs != null ? tradeFreshMs <= rt.wsFreshMs : false;

    const ws = cacheImpl.get(`birdeye:ws:price:${mint}`) || null;
    wsReads += 1;
    const wsPrice = toNum(ws?.priceUsd ?? ws?.price, 0);
    const wsTsMs = toNum(ws?.tsMs, 0);
    const wsFreshMs = wsTsMs > 0 ? (nowMs - wsTsMs) : null;
    const wsFreshEnough = wsFreshMs != null ? wsFreshMs <= rt.wsFreshMs : false;

    if (tradeFreshEnough && Number.isFinite(tradePrice) && tradePrice > 0) {
      wsFreshReads += 1;
      selectedTradeReads += 1;
      return { price: tradePrice, source: 'ws_trade', wsFreshMs: tradeFreshMs, wsTsMs: tradeTsMs, tradeTsMs };
    }
    if (Number.isFinite(wsPrice) && wsPrice > 0 && wsFreshEnough) {
      wsFreshReads += 1;
      selectedOhlcvReads += 1;
      return { price: wsPrice, source: 'ws_ohlcv', wsFreshMs, wsTsMs };
    }

    snapshotReads += 1;
    const p = toNum(snapshot?.priceUsd ?? row?.latest?.priceUsd ?? pair?.priceUsd, 0);
    return {
      price: Number.isFinite(p) && p > 0 ? p : null,
      source: (tradeTsMs > 0 || wsTsMs > 0) ? 'snapshot_fallback_wsStale' : 'snapshot_fallback',
      wsFreshMs,
      tradeFreshMs,
    };
  };

  const startNow = nowFn();
  const start = readWsOrFallbackPrice(startNow);
  const startPrice = toNum(start?.price, 0);
  if (!(startPrice > 0)) {
    const failReason = 'windowExpiredStall';
    return {
      ok: false,
      failReason,
      mode: 'continuation',
      diag: {
        ...mkDiagBase({
          startPrice: null,
          highPrice: null,
          lowPrice: null,
          finalPrice: null,
          passReason: 'none',
          failReason,
          priceSource: start?.source || 'unknown',
          timeToRunupPassMs: null,
          timeoutWasFlatOrNegative: null,
          wsReads,
          wsFreshReads,
          wsObservedTicks,
          snapshotReads,
          confirmStartedAtMs: startNow,
          wsUpdateTimestamps,
          wsUpdatePrices,
          tradeUpdateTimestamps,
          tradeUpdatePrices,
          selectedTradeReads,
          selectedOhlcvReads,
          consecutiveTradeUpticks,
          maxConsecutiveTradeUpticks,
          requireTradeUpticks: rt.requireTradeUpticks,
          minConsecutiveTradeUpticks: rt.minConsecutiveTradeUpticks,
        }),
      },
    };
  }

  let highPrice = startPrice;
  let lowPrice = startPrice;
  let finalPrice = startPrice;
  let passReason = 'none';
  let failReason = 'none';
  let timeToRunupPassMs = null;

  const startedAt = startNow;
  const deadline = startedAt + rt.windowMs;
  while (nowFn() <= deadline) {
    const nowMs = nowFn();
    if (nowMs - lastSubRefreshMs >= rt.subRefreshMs) {
      ensureSub();
      lastSubRefreshMs = nowMs;
    }

    const tick = readWsOrFallbackPrice(nowMs);
    const p = toNum(tick?.price, 0);
    if (!(p > 0)) {
      await sleepFn(rt.sleepMs);
      continue;
    }
    finalPrice = p;
    if (tick?.source === 'ws_ohlcv') {
      const tickTs = toNum(tick?.wsTsMs, 0);
      if (tickTs > 0 && tickTs !== lastWsTsSeen) {
        lastWsTsSeen = tickTs;
        wsObservedTicks += 1;
        wsUpdateTimestamps.push(tickTs);
        wsUpdatePrices.push(p);
        if (wsUpdateTimestamps.length > 24) wsUpdateTimestamps.shift();
        if (wsUpdatePrices.length > 24) wsUpdatePrices.shift();
      }
    }
    if (tick?.source === 'ws_trade') {
      const tradeTs = toNum(tick?.tradeTsMs ?? tick?.wsTsMs, 0);
      if (tradeTs > 0 && tradeTs !== lastTradeTsSeen) {
        lastTradeTsSeen = tradeTs;
        tradeUpdateTimestamps.push(tradeTs);
        tradeUpdatePrices.push(p);
        if (tradeUpdateTimestamps.length > 24) tradeUpdateTimestamps.shift();
        if (tradeUpdatePrices.length > 24) tradeUpdatePrices.shift();
        if (Number.isFinite(prevTradePriceForTrend) && prevTradePriceForTrend > 0) {
          consecutiveTradeUpticks = p > prevTradePriceForTrend ? (consecutiveTradeUpticks + 1) : 0;
        } else {
          consecutiveTradeUpticks = 0;
        }
        if (consecutiveTradeUpticks > maxConsecutiveTradeUpticks) maxConsecutiveTradeUpticks = consecutiveTradeUpticks;
        prevTradePriceForTrend = p;
      }
    }
    if (p > highPrice) highPrice = p;
    if (p < lowPrice) lowPrice = p;

    const runupPct = (highPrice / startPrice) - 1;
    const dipPct = (startPrice - lowPrice) / startPrice;

    const liqNow = toNum(row?.latest?.liqUsd ?? snapshot?.liquidityUsd ?? pair?.liquidity?.usd, 0);
    const startLiq = toNum(confirmStartLiqUsd, 0);
    const liqChangePct = startLiq > 0 ? ((liqNow - startLiq) / startLiq) : null;
    if (startLiq > 0 && liqNow < (startLiq * 0.85)) {
      failReason = 'liqDegraded';
      return {
        ok: false,
        failReason,
        mode: 'continuation',
        diag: {
          ...mkDiagBase({
            startPrice,
            highPrice,
            lowPrice,
            finalPrice,
            passReason,
            failReason,
            priceSource: tick?.source || 'unknown',
            timeToRunupPassMs,
            timeoutWasFlatOrNegative: null,
            wsReads,
            wsFreshReads,
            wsObservedTicks,
            snapshotReads,
            confirmStartedAtMs: startedAt,
            wsUpdateTimestamps,
            wsUpdatePrices,
            tradeUpdateTimestamps,
            tradeUpdatePrices,
            selectedTradeReads,
            selectedOhlcvReads,
            consecutiveTradeUpticks,
            maxConsecutiveTradeUpticks,
            requireTradeUpticks: rt.requireTradeUpticks,
            minConsecutiveTradeUpticks: rt.minConsecutiveTradeUpticks,
          }),
          confirmStartLiqUsd: startLiq,
          currentLiqUsd: liqNow,
          liqChangePct,
        },
      };
    }

    const maxPi = toNum(cfg?.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT, 0);
    const pi = toNum(confirmPriceImpactPct, NaN);
    if (Number.isFinite(pi) && pi > maxPi) {
      failReason = 'impact';
      return {
        ok: false,
        failReason,
        mode: 'continuation',
        diag: mkDiagBase({
          startPrice,
          highPrice,
          lowPrice,
          finalPrice,
          passReason,
          failReason,
          priceSource: tick?.source || 'unknown',
          timeToRunupPassMs,
          timeoutWasFlatOrNegative: null,
          wsReads,
          wsFreshReads,
          wsObservedTicks,
          snapshotReads,
          confirmStartedAtMs: startedAt,
          wsUpdateTimestamps,
          wsUpdatePrices,
          tradeUpdateTimestamps,
          tradeUpdatePrices,
          selectedTradeReads,
          selectedOhlcvReads,
          consecutiveTradeUpticks,
          maxConsecutiveTradeUpticks,
          requireTradeUpticks: rt.requireTradeUpticks,
          minConsecutiveTradeUpticks: rt.minConsecutiveTradeUpticks,
        }),
      };
    }

    if (dipPct >= rt.hardFailDipPct) {
      failReason = 'hardDip';
      return {
        ok: false,
        failReason,
        mode: 'continuation',
        diag: mkDiagBase({
          startPrice,
          highPrice,
          lowPrice,
          finalPrice,
          passReason,
          failReason,
          priceSource: tick?.source || 'unknown',
          timeToRunupPassMs,
          timeoutWasFlatOrNegative: null,
          wsReads,
          wsFreshReads,
          wsObservedTicks,
          snapshotReads,
          confirmStartedAtMs: startedAt,
          wsUpdateTimestamps,
          wsUpdatePrices,
          tradeUpdateTimestamps,
          tradeUpdatePrices,
          selectedTradeReads,
          selectedOhlcvReads,
          consecutiveTradeUpticks,
          maxConsecutiveTradeUpticks,
          requireTradeUpticks: rt.requireTradeUpticks,
          minConsecutiveTradeUpticks: rt.minConsecutiveTradeUpticks,
        }),
      };
    }

    if (runupPct >= rt.passPct || p >= (startPrice * (1 + rt.passPct))) {
      runupSeenInWindow = true;
      const tradeTrendOk = !rt.requireTradeUpticks || maxConsecutiveTradeUpticks >= rt.minConsecutiveTradeUpticks;
      if (!tradeTrendOk) {
        await sleepFn(rt.sleepMs);
        continue;
      }
      passReason = 'runup';
      timeToRunupPassMs = Math.max(0, nowMs - startedAt);
      return {
        ok: true,
        passReason,
        mode: 'continuation',
        diag: mkDiagBase({
          startPrice,
          highPrice,
          lowPrice,
          finalPrice,
          passReason,
          failReason,
          priceSource: tick?.source || 'unknown',
          timeToRunupPassMs,
          timeoutWasFlatOrNegative: false,
          wsReads,
          wsFreshReads,
          wsObservedTicks,
          snapshotReads,
          confirmStartedAtMs: startedAt,
          wsUpdateTimestamps,
          wsUpdatePrices,
          tradeUpdateTimestamps,
          tradeUpdatePrices,
          selectedTradeReads,
          selectedOhlcvReads,
          consecutiveTradeUpticks,
          maxConsecutiveTradeUpticks,
          requireTradeUpticks: rt.requireTradeUpticks,
          minConsecutiveTradeUpticks: rt.minConsecutiveTradeUpticks,
        }),
      };
    }

    await sleepFn(rt.sleepMs);
  }

  const finalRet = (finalPrice / startPrice) - 1;
  const timeoutWasFlatOrNegative = finalRet <= 0;
  const tradeTrendMissing = rt.requireTradeUpticks && runupSeenInWindow && maxConsecutiveTradeUpticks < rt.minConsecutiveTradeUpticks;
  failReason = tradeTrendMissing ? 'runupNoTradeTrendConfirm' : (timeoutWasFlatOrNegative ? 'windowExpiredStall' : 'windowExpired');
  return {
    ok: false,
    failReason,
    mode: 'continuation',
    diag: mkDiagBase({
      startPrice,
      highPrice,
      lowPrice,
      finalPrice,
      passReason,
      failReason,
      priceSource: start?.source || 'unknown',
      timeToRunupPassMs,
      timeoutWasFlatOrNegative,
      wsReads,
      wsFreshReads,
      wsObservedTicks,
      snapshotReads,
      confirmStartedAtMs: startedAt,
      wsUpdateTimestamps,
      wsUpdatePrices,
      tradeUpdateTimestamps,
      tradeUpdatePrices,
      selectedTradeReads,
      selectedOhlcvReads,
    }),
  };
}
