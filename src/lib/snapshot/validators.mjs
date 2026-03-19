export function computeConfidence({ source, liquidityUsd, txns, freshnessMs }) {
  let score = 0.25;
  if (source === 'birdeye') score += 0.6;
  if (source === 'dexscreener') score += 0.55;
  if (source === 'jupiter') score += 0.25;
  if (source === 'cache') score += 0.15;
  if (Number(liquidityUsd || 0) > 0) score += 0.1;
  const txCount = Number(txns?.h1?.buys || 0) + Number(txns?.h1?.sells || 0) + Number(txns?.h24?.buys || 0) + Number(txns?.h24?.sells || 0);
  if (txCount > 0) score += 0.1;
  if (Number.isFinite(Number(freshnessMs)) && freshnessMs <= 60_000) score += 0.1;
  if (Number.isFinite(Number(freshnessMs)) && freshnessMs > 5 * 60_000) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

export function validateSnapshot(snapshot, { minLiquidityUsd = 50000, maxFreshnessMs = 20000 } = {}) {
  const unsafe = [];
  if (!snapshot) unsafe.push('missingSnapshot');
  if (!snapshot?.priceUsd) unsafe.push('missingPrice');
  if (snapshot?.liquidityUsd == null) unsafe.push('missingLiquidity');
  else if (Number(snapshot.liquidityUsd) < minLiquidityUsd) unsafe.push('liquidityBelowThreshold');
  if (Number(snapshot.snapshotAgeMs ?? Number.MAX_SAFE_INTEGER) > maxFreshnessMs) unsafe.push('staleTimestamp');
  // routeAvailable is enforced later in quote/confirm flow; do not fail snapshot quality on route flag alone.
  return unsafe;
}
