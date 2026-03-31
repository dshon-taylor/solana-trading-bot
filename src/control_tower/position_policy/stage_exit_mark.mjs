export function conservativeExitMark(priceUsd, pos = null, snapshot = null, cfg = null) {
  const px = Number(priceUsd || 0);
  if (!(px > 0)) return px;
  const spreadPct = Number(snapshot?.spreadPct ?? snapshot?.pair?.spreadPct ?? snapshot?.pair?.market?.spreadPct ?? snapshot?.pair?.raw?.spreadPct);
  const spread = Number.isFinite(spreadPct) && spreadPct > 0 ? (spreadPct / 100) : 0;
  const slip = Math.max(0, Number(cfg?.DEFAULT_SLIPPAGE_BPS || 0) / 10_000);
  const baseHaircut = Math.max(0.01, Math.min(0.04, slip * 0.6));
  const spreadHaircut = Math.max(0, Math.min(0.04, spread * 0.5));
  const totalHaircut = Math.max(0.01, Math.min(0.08, baseHaircut + spreadHaircut));
  return px * (1 - totalHaircut);
}
