export function promoteRouteAvailableCandidateToImmediate({
  mint,
  row,
  nowMs,
  dedupMs,
  immediateRows,
  immediateRowMints,
} = {}) {
  if (!mint || !row) return { promoted: false, reason: 'watchlistUpsertFailed' };
  if (!Array.isArray(immediateRows) || !(immediateRowMints instanceof Set)) {
    throw new Error('promoteRouteAvailableCandidateToImmediate requires immediateRows[] and immediateRowMints Set');
  }

  const lastImmediateAtMs = Number(row?.lastImmediateEvalAtMs || 0);
  const dedupWindowMs = Math.max(0, Number(dedupMs || 0));
  if (dedupWindowMs > 0 && (nowMs - lastImmediateAtMs) < dedupWindowMs) {
    return { promoted: false, reason: 'immediateDedup' };
  }
  if (immediateRowMints.has(mint)) {
    return { promoted: false, reason: 'cycleDedup' };
  }

  immediateRows.push([mint, row, true]);
  immediateRowMints.add(mint);
  row.lastImmediateEvalAtMs = nowMs;
  return { promoted: true, reason: null };
}
