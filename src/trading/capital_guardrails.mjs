export function ensureCapitalGuardrailsState(state) {
  state.capitalGuardrails ||= {};
  state.capitalGuardrails.entryOpenedAtMs ||= [];
}

function oneHourAgo(nowMs) {
  return nowMs - (60 * 60_000);
}

export function canOpenNewEntry({ state, nowMs, maxNewEntriesPerHour }) {
  ensureCapitalGuardrailsState(state);
  const maxN = Number(maxNewEntriesPerHour || 0);
  const keepFrom = oneHourAgo(nowMs);
  state.capitalGuardrails.entryOpenedAtMs = state.capitalGuardrails.entryOpenedAtMs
    .filter((x) => Number(x) >= keepFrom)
    .slice(-500);

  if (maxN <= 0) {
    return { ok: true, used: state.capitalGuardrails.entryOpenedAtMs.length, limit: 0 };
  }

  const used = state.capitalGuardrails.entryOpenedAtMs.length;
  if (used >= maxN) {
    return { ok: false, used, limit: maxN, reason: `throttle(max ${maxN}/hour)` };
  }

  return { ok: true, used, limit: maxN };
}

export function recordEntryOpened({ state, nowMs }) {
  ensureCapitalGuardrailsState(state);
  state.capitalGuardrails.entryOpenedAtMs.push(nowMs);
}

export function applySoftReserveToUsdTarget({
  solBalance,
  solUsd,
  usdTarget,
  minSolForFees,
  softReserveSol,
  retryBufferPct,
}) {
  const targetUsd = Number(usdTarget || 0);
  const balSol = Number(solBalance || 0);
  const px = Number(solUsd || 0);
  if (targetUsd <= 0 || balSol <= 0 || px <= 0) {
    return { ok: false, reason: 'invalid_inputs', adjustedUsdTarget: 0, adjustedSolTarget: 0 };
  }

  const plannedSol = targetUsd / px;
  const reserveSol = Number(minSolForFees || 0) + Number(softReserveSol || 0) + (plannedSol * Number(retryBufferPct || 0));
  const spendableSol = Math.max(0, balSol - reserveSol);
  const adjustedSolTarget = Math.max(0, Math.min(plannedSol, spendableSol));
  const adjustedUsdTarget = adjustedSolTarget * px;

  if (adjustedSolTarget <= 0) {
    return { ok: false, reason: 'reserve_exhausted', adjustedUsdTarget: 0, adjustedSolTarget: 0, reserveSol, spendableSol };
  }

  return {
    ok: true,
    reason: adjustedSolTarget < plannedSol ? 'soft_reserve_capped' : 'ok',
    adjustedUsdTarget,
    adjustedSolTarget,
    reserveSol,
    spendableSol,
    plannedSol,
  };
}
