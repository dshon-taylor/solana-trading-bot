import { confirmContinuationGate as runConfirmContinuationGate } from '../../signals/confirm_continuation.mjs';

export function confirmQualityGate({ cfg, sigReasons, snapshot }) {
  if (!cfg.CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM) return { ok: true };
  const buySellRatio = Number(sigReasons?.buySellRatio || 0);
  const tx1m = Number(sigReasons?.tx_1m || 0);
  const tx5mAvg = Number(sigReasons?.tx_5m_avg || 0);
  const txMetricsMissing = !(Number.isFinite(tx1m) && Number.isFinite(tx5mAvg) && tx1m > 0 && tx5mAvg > 0);
  if (txMetricsMissing) return { ok: false, reason: 'txMetricMissing' };
  const confirmBuySellMin = Number(cfg?.CONFIRM_BUY_SELL_MIN || 1.2);
  if (!(buySellRatio >= confirmBuySellMin)) return { ok: false, reason: 'confirmWeakBuyDominance' };
  const txAccelMin = Number(cfg?.CONFIRM_TX_ACCEL_MIN || 1.0);
  if (!((tx1m / Math.max(1, tx5mAvg)) >= txAccelMin)) return { ok: false, reason: 'confirmNoTxAcceleration' };

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
  const readMetric = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  const buildCandidate = (source, values = {}) => ({
    source,
    tx1m: readMetric(values.tx1m),
    tx5mAvg: readMetric(values.tx5mAvg),
    tx30mAvg: readMetric(values.tx30mAvg),
    buySellRatio: readMetric(values.buySellRatio),
  });

  const hasTxCore = (m) => Number(m?.tx1m || 0) > 0 && Number(m?.tx5mAvg || 0) > 0;

  const mergeMissing = (base, incoming) => ({
    ...base,
    tx1m: Number(base.tx1m || 0) > 0 ? Number(base.tx1m || 0) : Number(incoming.tx1m || 0),
    tx5mAvg: Number(base.tx5mAvg || 0) > 0 ? Number(base.tx5mAvg || 0) : Number(incoming.tx5mAvg || 0),
    tx30mAvg: Number(base.tx30mAvg || 0) > 0 ? Number(base.tx30mAvg || 0) : Number(incoming.tx30mAvg || 0),
    buySellRatio: Number(base.buySellRatio || 0) > 0 ? Number(base.buySellRatio || 0) : Number(incoming.buySellRatio || 0),
  });

  const stateRowCarry = state?.watchlist?.mints?.[mint]?.meta?.confirmTxCarry || null;
  const carryByMint = state?.runtime?.confirmTxCarryByMint?.[mint] || null;
  const candidates = [
    buildCandidate('momentum.carried', {
      tx1m: carryByMint?.tx1m ?? row?.meta?.confirmTxCarry?.tx1m ?? stateRowCarry?.tx1m,
      tx5mAvg: carryByMint?.tx5mAvg ?? row?.meta?.confirmTxCarry?.tx5mAvg ?? stateRowCarry?.tx5mAvg,
      tx30mAvg: carryByMint?.tx30mAvg ?? row?.meta?.confirmTxCarry?.tx30mAvg ?? stateRowCarry?.tx30mAvg,
      buySellRatio: carryByMint?.buySellRatio ?? row?.meta?.confirmTxCarry?.buySellRatio ?? stateRowCarry?.buySellRatio,
    }),
    buildCandidate('row.latest', {
      tx1m: row?.latest?.tx1m,
      tx5mAvg: row?.latest?.tx5mAvg,
      tx30mAvg: row?.latest?.tx30mAvg,
      buySellRatio: row?.latest?.buySellRatio,
    }),
    buildCandidate('snapshot', {
      tx1m: snapshot?.tx_1m ?? snapshot?.pair?.birdeye?.tx_1m,
      tx5mAvg: snapshot?.tx_5m_avg ?? snapshot?.pair?.birdeye?.tx_5m_avg,
      tx30mAvg: snapshot?.tx_30m_avg ?? snapshot?.pair?.birdeye?.tx_30m_avg,
      buySellRatio: snapshot?.buySellRatio ?? snapshot?.pair?.birdeye?.buySellRatio,
    }),
    buildCandidate('pair.ws', {
      tx1m: pair?.wsCache?.birdeye?.tx_1m ?? pair?.birdeye?.tx_1m,
      tx5mAvg: pair?.wsCache?.birdeye?.tx_5m_avg ?? pair?.birdeye?.tx_5m_avg,
      tx30mAvg: pair?.wsCache?.birdeye?.tx_30m_avg ?? pair?.birdeye?.tx_30m_avg,
      buySellRatio: pair?.wsCache?.birdeye?.buySellRatio ?? pair?.birdeye?.buySellRatio,
    }),
  ];

  let merged = { tx1m: 0, tx5mAvg: 0, tx30mAvg: 0, buySellRatio: 0 };
  const sourceUsed = [];
  for (const c of candidates) {
    const before = { ...merged };
    merged = mergeMissing(merged, c);
    if (
      before.tx1m !== merged.tx1m
      || before.tx5mAvg !== merged.tx5mAvg
      || before.tx30mAvg !== merged.tx30mAvg
      || before.buySellRatio !== merged.buySellRatio
    ) {
      sourceUsed.push(c.source);
    }
    if (hasTxCore(merged) && Number(merged.buySellRatio || 0) > 0) {
      return { ...merged, source: sourceUsed.join('+') || c.source };
    }
  }

  if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function' && mint) {
    try {
      const lite = await birdseye.getTokenSnapshot(mint);
      const liteSnapshot = snapshotFromBirdseye(lite, Date.now());
      const beTx1m = Number(liteSnapshot?.tx_1m ?? lite?.tx_1m ?? lite?.pair?.birdeye?.tx_1m ?? 0);
      const beTx5mAvg = Number(liteSnapshot?.tx_5m_avg ?? lite?.tx_5m_avg ?? lite?.pair?.birdeye?.tx_5m_avg ?? 0);
      const beTx30mAvg = Number(liteSnapshot?.tx_30m_avg ?? lite?.tx_30m_avg ?? lite?.pair?.birdeye?.tx_30m_avg ?? 0);
      const beBsr = Number(liteSnapshot?.buySellRatio ?? lite?.buySellRatio ?? lite?.pair?.birdeye?.buySellRatio ?? 0);
      const withBirdseye = mergeMissing(merged, {
        tx1m: beTx1m,
        tx5mAvg: beTx5mAvg,
        tx30mAvg: beTx30mAvg,
        buySellRatio: beBsr,
      });
      if (hasTxCore(withBirdseye) || Number(withBirdseye.buySellRatio || 0) > 0) {
        const src = sourceUsed.length ? `${sourceUsed.join('+')}+birdeyeFallback.normalized` : 'birdeyeFallback.normalized';
        return { ...withBirdseye, source: src };
      }
    } catch {}
  }

  if (hasTxCore(merged) || Number(merged.buySellRatio || 0) > 0) {
    return { ...merged, source: sourceUsed.join('+') || 'partial' };
  }

  return { tx1m: 0, tx5mAvg: 0, tx30mAvg: 0, buySellRatio: 0, source: 'unknown' };
}
