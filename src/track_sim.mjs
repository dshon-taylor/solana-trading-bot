export function simulateStops({
  entryPrice,
  series, // [{t, price}]
  stopLossPct = 0.18,
  trailActivatePct = 0.10,
  trailDistancePct = 0.12,
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

  const stopPx = entryPrice * (1 - stopLossPct);
  let maxP = entryPrice;
  let minP = entryPrice;

  let trailHigh = null;
  let trailStop = null;

  for (const pt of series) {
    const p = Number(pt?.price);
    if (!Number.isFinite(p) || p <= 0) continue;

    if (p > maxP) maxP = p;
    if (p < minP) minP = p;

    // hard stop loss
    if (p <= stopPx) {
      out.exitPrice = stopPx;
      out.exitT = pt?.t || null;
      out.exitReason = 'stopLoss';
      break;
    }

    // trailing
    if (!out.trailActivated) {
      if (p >= entryPrice * (1 + trailActivatePct)) {
        out.trailActivated = true;
        trailHigh = p;
        trailStop = trailHigh * (1 - trailDistancePct);
      }
    } else {
      if (p > trailHigh) {
        trailHigh = p;
        trailStop = trailHigh * (1 - trailDistancePct);
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
