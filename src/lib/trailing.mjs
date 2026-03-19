export function computeTrailPct(pnl) {
  // pnl as fraction (e.g., 0.4 for 40%)
  if (pnl < 0.30) return null; // stop-at-entry
  if (pnl >= 1.50) return 0.18;
  if (pnl >= 0.80) return 0.22;
  if (pnl >= 0.30) return 0.30;
  return null;
}

export function computeStopFromAnchor(anchorPrice, trailPct, slippagePct = 0) {
  // anchorPrice: price to anchor the trail
  // trailPct: e.g., 0.30 => keep 30% below anchor
  // slippagePct: execution slippage fraction to be conservative (e.g., 0.02 for 2%)
  if (!anchorPrice || trailPct == null) return null;
  const rawStop = anchorPrice * (1 - trailPct);
  // Use execution-safe price: add slippage buffer (i.e., raise stop so slippage doesn't push executed price below stop)
  const safeStop = rawStop * (1 + slippagePct);
  return safeStop;
}

export function updateTrailingAnchor(currentPeak, storedAnchor) {
  // Only update anchor when currentPeak is a new local high after entry.
  // Never decrease anchor; only raise it.
  if (!storedAnchor) return currentPeak;
  if (!currentPeak) return storedAnchor;
  if (currentPeak > storedAnchor) return currentPeak;
  return storedAnchor;
}
