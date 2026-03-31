export function runFinalizeCandidatesStage({
  scanPhase,
  boostedRaw,
}) {
  const _tCandidateFinalizing = Date.now();
  const _tCandidateDedupe = Date.now();
  const seen = new Set();
  const candidates = [];
  for (const c of boostedRaw) {
    const mint = String(c?.tokenAddress || c?.mint || '').trim();
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    candidates.push({ ...c, tokenAddress: mint });
  }
  scanPhase.candidateDedupeMs += Math.max(0, Date.now() - _tCandidateDedupe);

  const _tCandidatePreview = Date.now();
  const previewMints = candidates.slice(0, 20).map((c) => String(c?.tokenAddress || '').trim()).filter(Boolean);
  scanPhase.candidatePreviewMs += Math.max(0, Date.now() - _tCandidatePreview);
  scanPhase.candidateFinalizingMs += Math.max(0, Date.now() - _tCandidateFinalizing);

  return { candidates, previewMints };
}
