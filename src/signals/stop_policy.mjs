export function computePreTrailStopPrice({
  entryPriceUsd,
  entryAtMs,
  nowMs,
  armDelayMs = 0,
  prearmCatastrophicStopPct = 0.07,
  stopAtEntryBufferPct = 0.02,
} = {}) {
  const entry = Number(entryPriceUsd);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const tNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const tEntry = Number.isFinite(Number(entryAtMs)) ? Number(entryAtMs) : tNow;
  const ageMs = Math.max(0, tNow - tEntry);

  const armMs = Math.max(0, Number(armDelayMs || 0));
  const prearmPct = Math.max(0, Number(prearmCatastrophicStopPct || 0));
  const postArmPct = Math.max(0, Number(stopAtEntryBufferPct || 0));

  const appliedPct = ageMs < armMs ? prearmPct : postArmPct;
  const stop = entry * (1 - appliedPct);
  return Number.isFinite(stop) && stop > 0 ? stop : null;
}
