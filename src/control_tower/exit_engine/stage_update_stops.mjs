import { nowIso } from '../../observability/logger.mjs';
import { computeTrailPct, computeStopFromAnchor, updateTrailingAnchor } from '../../signals/trailing.mjs';
import { computePreTrailStopPrice } from '../../signals/stop_policy.mjs';

export async function updateStops({ cfg, state, mint, priceUsd }) {
  const pos = state.positions[mint];
  if (!pos || pos.status !== 'open') return { changed: false };

  pos.lastSeenPriceUsd = priceUsd;
  pos.trailingAnchor = pos.trailingAnchor ?? pos.peakPriceUsd ?? pos.entryPriceUsd;
  pos.activeTrailPct = pos.activeTrailPct ?? null;
  pos.lastStopPrice = pos.lastStopPrice ?? pos.stopPriceUsd ?? null;
  pos.lastPeakPrice = pos.lastPeakPrice ?? pos.peakPriceUsd ?? pos.entryPriceUsd;

  if (priceUsd > (pos.lastPeakPrice || 0)) {
    pos.lastPeakPrice = priceUsd;
    pos.lastPeakAtMs = Date.now();
  }

  const entry = Number(pos.entryPriceUsd);
  const profitPct = (priceUsd - entry) / entry;
  const trailActivatePct = Number.isFinite(Number(pos.trailActivatePct))
    ? Number(pos.trailActivatePct)
    : Number(cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT || 0.10);

  let changed = false;
  const desiredTrailPct = computeTrailPct(profitPct);

  if (desiredTrailPct == null || profitPct < trailActivatePct) {
    if (pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct))) {
      return { changed, stopPriceUsd: pos.stopPriceUsd };
    }

    const nowMs = Date.now();
    const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMs;
    const stopPrice = computePreTrailStopPrice({
      entryPriceUsd: entry,
      entryAtMs,
      nowMs,
      armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
      prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
      stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    });

    if (!Number.isFinite(Number(pos.stopPriceUsd)) || pos.stopPriceUsd < stopPrice) {
      pos.stopPriceUsd = stopPrice;
      pos.lastStopUpdateAt = nowIso();
      pos.trailingActive = false;
      pos.activeTrailPct = null;
      pos.trailingAnchor = pos.trailingAnchor ?? pos.lastPeakPrice;
      pos.lastStopPrice = pos.stopPriceUsd;
      changed = true;
    }
    return { changed, stopPriceUsd: pos.stopPriceUsd };
  }

  const newAnchor = updateTrailingAnchor(pos.lastPeakPrice, pos.trailingAnchor);
  if (newAnchor !== pos.trailingAnchor) {
    pos.trailingAnchor = newAnchor;
  }

  const slippageBps = Number(pos.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS ?? 0);
  const slippagePct = slippageBps / 10_000;
  const candidateStop = computeStopFromAnchor(pos.trailingAnchor, desiredTrailPct, slippagePct);

  if (!Number.isFinite(Number(pos.stopPriceUsd)) || candidateStop > pos.stopPriceUsd) {
    pos.stopPriceUsd = candidateStop;
    pos.lastStopUpdateAt = nowIso();
    pos.trailingActive = true;
    pos.activeTrailPct = desiredTrailPct;
    pos.lastStopPrice = pos.stopPriceUsd;
    changed = true;
  }

  return { changed, stopPriceUsd: pos.stopPriceUsd };
}
