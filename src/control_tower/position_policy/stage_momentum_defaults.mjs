import { computePreTrailStopPrice } from '../../signals/stop_policy.mjs';

export function applyMomentumDefaultsToPosition(cfg, pos) {
  if (!pos || pos.status !== 'open') return;
  const entry = Number(pos.entryPriceUsd || 0);
  if (!entry) return;

  pos.stopAtEntry = cfg.LIVE_MOMO_STOP_AT_ENTRY === true;
  pos.trailActivatePct = cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT;
  pos.trailDistancePct = cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT;

  const nowMs = Date.now();
  const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMs;
  const baseline = computePreTrailStopPrice({
    entryPriceUsd: entry,
    entryAtMs,
    nowMs,
    armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
    prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
    stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
  });
  if (Number.isFinite(Number(baseline)) && baseline > 0) {
    pos.stopPriceUsd = Math.max(Number(pos.stopPriceUsd || 0), Number(baseline));
  }
}
