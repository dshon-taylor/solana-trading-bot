import { confirmContinuationGate as runConfirmContinuationGate } from '../../signals/confirm_continuation.mjs';

export function confirmQualityGate({ cfg, sigReasons, snapshot }) {
  if (!cfg.CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM) return { ok: true };
  const buySellRatio = Number(sigReasons?.buySellRatio || 0);
  const tx1m = Number(sigReasons?.tx_1m || 0);
  const tx5mAvg = Number(sigReasons?.tx_5m_avg || 0);
  const txMetricsMissing = !(Number.isFinite(tx1m) && Number.isFinite(tx5mAvg) && tx1m > 0 && tx5mAvg > 0);
  if (txMetricsMissing) return { ok: false, reason: 'txMetricMissing' };
  const confirmBuySellMin = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
  if (!(buySellRatio > confirmBuySellMin)) return { ok: false, reason: 'confirmWeakBuyDominance' };
  const txAccelMin = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
  if (!((tx1m / Math.max(1, tx5mAvg)) > txAccelMin)) return { ok: false, reason: 'confirmNoTxAcceleration' };

  const freshnessMs = Number(snapshot?.freshnessMs ?? Infinity);
  if (!Number.isFinite(freshnessMs) || freshnessMs > Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)) {
    return { ok: false, reason: 'confirmStaleSnapshot' };
  }
  return { ok: true };
}

export function createConfirmContinuationGate({ cacheImpl }) {
  return async function confirmContinuationGate({ cfg, mint, row, snapshot, pair, confirmMinLiqUsd, confirmPriceImpactPct, confirmStartLiqUsd = null }) {
    return runConfirmContinuationGate({
      cfg,
      mint,
      row,
      snapshot,
      pair,
      confirmMinLiqUsd,
      confirmPriceImpactPct,
      confirmStartLiqUsd,
      cacheImpl,
    });
  };
}

export function recordConfirmCarryTrace(state, mint, stage, payload = {}) {
  state.runtime ||= {};
  state.runtime.confirmCarryTrace ||= [];
  const ev = { tMs: Date.now(), mint: String(mint || 'unknown'), stage, ...payload };
  state.runtime.confirmCarryTrace.push(ev);
  if (state.runtime.confirmCarryTrace.length > 100) state.runtime.confirmCarryTrace = state.runtime.confirmCarryTrace.slice(-100);
}

export async function resolveConfirmTxMetrics({ state, row, snapshot, pair, mint, birdseye = null, snapshotFromBirdseye }) {
  const stateRowCarry = state?.watchlist?.mints?.[mint]?.meta?.confirmTxCarry || null;
  const carryByMint = state?.runtime?.confirmTxCarryByMint?.[mint] || null;
  const carryTx1m = Number(carryByMint?.tx1m ?? row?.meta?.confirmTxCarry?.tx1m ?? stateRowCarry?.tx1m ?? 0);
  const carryTx5mAvg = Number(carryByMint?.tx5mAvg ?? row?.meta?.confirmTxCarry?.tx5mAvg ?? stateRowCarry?.tx5mAvg ?? 0);
  const carryTx30mAvg = Number(carryByMint?.tx30mAvg ?? row?.meta?.confirmTxCarry?.tx30mAvg ?? stateRowCarry?.tx30mAvg ?? 0);
  const carryBsr = Number(carryByMint?.buySellRatio ?? row?.meta?.confirmTxCarry?.buySellRatio ?? stateRowCarry?.buySellRatio ?? 0);
  if (carryTx1m > 0 || carryTx5mAvg > 0 || carryTx30mAvg > 0 || carryBsr > 0) {
    return { tx1m: carryTx1m, tx5mAvg: carryTx5mAvg, tx30mAvg: carryTx30mAvg, buySellRatio: carryBsr, source: 'momentum.carried' };
  }

  const latestTx1m = Number(row?.latest?.tx1m || 0);
  const latestTx5mAvg = Number(row?.latest?.tx5mAvg || 0);
  const latestTx30mAvg = Number(row?.latest?.tx30mAvg || 0);
  const latestBsr = Number(row?.latest?.buySellRatio || 0);
  if (latestTx1m > 0 || latestTx5mAvg > 0 || latestTx30mAvg > 0 || latestBsr > 0) {
    return { tx1m: latestTx1m, tx5mAvg: latestTx5mAvg, tx30mAvg: latestTx30mAvg, buySellRatio: latestBsr, source: 'row.latest' };
  }

  const snapTx1m = Number(snapshot?.tx_1m ?? snapshot?.pair?.birdeye?.tx_1m ?? 0);
  const snapTx5mAvg = Number(snapshot?.tx_5m_avg ?? snapshot?.pair?.birdeye?.tx_5m_avg ?? 0);
  const snapTx30mAvg = Number(snapshot?.tx_30m_avg ?? snapshot?.pair?.birdeye?.tx_30m_avg ?? 0);
  const snapBsr = Number(snapshot?.buySellRatio ?? snapshot?.pair?.birdeye?.buySellRatio ?? 0);
  if (snapTx1m > 0 || snapTx5mAvg > 0 || snapTx30mAvg > 0 || snapBsr > 0) {
    return { tx1m: snapTx1m, tx5mAvg: snapTx5mAvg, tx30mAvg: snapTx30mAvg, buySellRatio: snapBsr, source: 'snapshot' };
  }

  const pairTx1m = Number(pair?.wsCache?.birdeye?.tx_1m ?? pair?.birdeye?.tx_1m ?? 0);
  const pairTx5mAvg = Number(pair?.wsCache?.birdeye?.tx_5m_avg ?? pair?.birdeye?.tx_5m_avg ?? 0);
  const pairTx30mAvg = Number(pair?.wsCache?.birdeye?.tx_30m_avg ?? pair?.birdeye?.tx_30m_avg ?? 0);
  const pairBsr = Number(pair?.wsCache?.birdeye?.buySellRatio ?? pair?.birdeye?.buySellRatio ?? 0);
  if (pairTx1m > 0 || pairTx5mAvg > 0 || pairTx30mAvg > 0 || pairBsr > 0) {
    return { tx1m: pairTx1m, tx5mAvg: pairTx5mAvg, tx30mAvg: pairTx30mAvg, buySellRatio: pairBsr, source: 'pair.ws' };
  }

  if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function' && mint) {
    try {
      const lite = await birdseye.getTokenSnapshot(mint);
      const liteSnapshot = snapshotFromBirdseye(lite, Date.now());
      const beTx1m = Number(liteSnapshot?.tx_1m ?? lite?.tx_1m ?? lite?.pair?.birdeye?.tx_1m ?? 0);
      const beTx5mAvg = Number(liteSnapshot?.tx_5m_avg ?? lite?.tx_5m_avg ?? lite?.pair?.birdeye?.tx_5m_avg ?? 0);
      const beTx30mAvg = Number(liteSnapshot?.tx_30m_avg ?? lite?.tx_30m_avg ?? lite?.pair?.birdeye?.tx_30m_avg ?? 0);
      const beBsr = Number(liteSnapshot?.buySellRatio ?? lite?.buySellRatio ?? lite?.pair?.birdeye?.buySellRatio ?? 0);
      if (beTx1m > 0 || beTx5mAvg > 0 || beTx30mAvg > 0 || beBsr > 0) {
        return { tx1m: beTx1m, tx5mAvg: beTx5mAvg, tx30mAvg: beTx30mAvg, buySellRatio: beBsr, source: 'birdeyeFallback.normalized' };
      }
    } catch {}
  }

  return { tx1m: 0, tx5mAvg: 0, tx30mAvg: 0, buySellRatio: 0, source: 'unknown' };
}
