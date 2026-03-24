import { computeTrailPct } from './lib/trailing.mjs';
import { computePreTrailStopPrice } from './lib/stop_policy.mjs';

export function simulateStops({
  entryPrice,
  series, // [{t, price}]
  stopAtEntryBufferPct = 0.02,
  stopArmDelayMs = 75_000,
  prearmCatastrophicStopPct = 0.07,
}) {
  const out = {
    entryPrice,
    exitPrice: null,
    exitT: null,
    exitReason: null,
    maxRunupPct: null,
    maxDrawdownPct: null,
    trailActivated: false,
    trailHigh: null,
    trailStop: null,
  };

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Array.isArray(series) || series.length === 0) {
    return out;
  }

  const firstTs = Date.parse(String(series?.[0]?.t || ''));
  const entryAtMs = Number.isFinite(firstTs) ? firstTs : Date.now();
  let stopPx = Number(computePreTrailStopPrice({
    entryPriceUsd: entryPrice,
    entryAtMs,
    nowMs: entryAtMs,
    armDelayMs: stopArmDelayMs,
    prearmCatastrophicStopPct,
    stopAtEntryBufferPct,
  }) || (entryPrice * (1 - stopAtEntryBufferPct)));
  let maxP = entryPrice;
  let minP = entryPrice;

  let trailHigh = null;
  let trailStop = null;
  let activeTrailPct = null;

  for (const pt of series) {
    const p = Number(pt?.price);
    if (!Number.isFinite(p) || p <= 0) continue;

    const tMsParsed = Date.parse(String(pt?.t || ''));
    const tMs = Number.isFinite(tMsParsed) ? tMsParsed : Date.now();

    if (p > maxP) maxP = p;
    if (p < minP) minP = p;

    const profitPct = (p - entryPrice) / entryPrice;
    const desiredTrailPct = computeTrailPct(profitPct);

    if (!out.trailActivated && desiredTrailPct == null) {
      const preTrailStop = computePreTrailStopPrice({
        entryPriceUsd: entryPrice,
        entryAtMs,
        nowMs: tMs,
        armDelayMs: stopArmDelayMs,
        prearmCatastrophicStopPct,
        stopAtEntryBufferPct,
      });
      if (Number.isFinite(Number(preTrailStop)) && preTrailStop > 0) {
        stopPx = Math.max(stopPx, Number(preTrailStop));
      }
    }

    // baseline stop
    if (p <= stopPx) {
      out.exitPrice = stopPx;
      out.exitT = pt?.t || null;
      out.exitReason = 'stopLoss';
      break;
    }

    // trailing
    if (!out.trailActivated) {
      if (desiredTrailPct != null) {
        out.trailActivated = true;
        activeTrailPct = desiredTrailPct;
        trailHigh = p;
        trailStop = trailHigh * (1 - activeTrailPct);
      }
    } else {
      if (desiredTrailPct != null && Number.isFinite(Number(activeTrailPct))) {
        activeTrailPct = Math.min(Number(activeTrailPct), Number(desiredTrailPct));
      }
      if (p > trailHigh) {
        trailHigh = p;
        trailStop = trailHigh * (1 - Number(activeTrailPct || 0));
      }
      if (p <= trailStop) {
        out.exitPrice = trailStop;
        out.exitT = pt?.t || null;
        out.exitReason = 'trailingStop';
        break;
      }
    }
  }

  out.trailHigh = trailHigh;
  out.trailStop = trailStop;

  out.maxRunupPct = (maxP - entryPrice) / entryPrice;
  out.maxDrawdownPct = (minP - entryPrice) / entryPrice;

  if (out.exitPrice == null) {
    const last = [...series].reverse().find(x => Number.isFinite(Number(x?.price)) && Number(x?.price) > 0);
    if (last) {
      out.exitPrice = Number(last.price);
      out.exitT = last.t || null;
      out.exitReason = 'horizon';
    }
  }

  return out;
}
