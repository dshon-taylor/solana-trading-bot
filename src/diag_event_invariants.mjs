function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function nonNegative(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

export function resolveConfirmTxMetricsFromDiagEvent(ev = null) {
  const tx1m = finiteOrNull(ev?.tx1m);
  const tx5mAvg = finiteOrNull(ev?.tx5mAvg);
  const tx30mAvg = finiteOrNull(ev?.tx30mAvg);
  const explicitAccel = finiteOrNull(ev?.txAccelObserved);
  const derivedAccel = (tx1m != null && tx5mAvg != null && tx5mAvg > 0)
    ? (tx1m / Math.max(1, tx5mAvg))
    : null;

  return {
    tx1m,
    tx5mAvg,
    tx30mAvg,
    txAccelObserved: explicitAccel ?? derivedAccel,
    txMetricSource: String(ev?.txMetricSource || 'unknown'),
  };
}

function requiredPositiveFieldsForKind(ev = {}) {
  const kind = String(ev?.kind || '');
  if (kind === 'candidateLiquiditySeen') return ['liqUsd'];
  if (kind === 'momentumLiq') return ['liqUsd'];
  if (kind === 'momentumRecent') return ['liq', 'mcap'];

  if (kind === 'postMomentumFlow') {
    const stage = String(ev?.stage || 'unknown');
    const outcome = String(ev?.outcome || 'unknown');
    const req = [];
    if (['preConfirm', 'confirm', 'attempt', 'fill'].includes(stage) && outcome !== 'unknown') {
      req.push('liq', 'mcap');
    }
    if (stage === 'confirm' && outcome !== 'unknown' && ev?.txMetricMissing !== true) {
      req.push('tx1m', 'tx5mAvg');
    }
    return req;
  }

  return [];
}

function requiredNonNegativeFieldsForKind(ev = {}) {
  const kind = String(ev?.kind || '');
  if (kind === 'scanCycle') {
    return ['durationMs', 'totalCycleMs', 'scanWallClockMs'];
  }
  return [];
}

export function validateDiagEventNumericIntegrity(ev = {}) {
  const issues = [];
  const tMs = Number(ev?.tMs || 0);
  if (!Number.isFinite(tMs) || tMs <= 0) {
    issues.push({ field: 'tMs', reason: 'must be finite and > 0' });
  }

  for (const field of requiredPositiveFieldsForKind(ev)) {
    if (!positive(ev?.[field])) {
      issues.push({ field, reason: 'must be finite and > 0' });
    }
  }

  for (const field of requiredNonNegativeFieldsForKind(ev)) {
    if (!nonNegative(ev?.[field])) {
      issues.push({ field, reason: 'must be finite and >= 0' });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateDiagEventBatch(events = []) {
  const out = [];
  for (const ev of (Array.isArray(events) ? events : [])) {
    const v = validateDiagEventNumericIntegrity(ev);
    if (!v.ok) out.push({ event: ev, issues: v.issues });
  }
  return { ok: out.length === 0, failures: out };
}
