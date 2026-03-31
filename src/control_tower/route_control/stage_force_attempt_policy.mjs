export function ensureForceAttemptPolicyState(state) {
  state.guardrails ||= {};
  state.guardrails.forceAttempt ||= {
    globalAttemptTimestampsMs: [],
    perMintAttemptTimestampsMs: {},
  };
  state.guardrails.forceAttempt.globalAttemptTimestampsMs ||= [];
  state.guardrails.forceAttempt.perMintAttemptTimestampsMs ||= {};
  return state.guardrails.forceAttempt;
}

export function pruneForceAttemptPolicyWindows(policyState, nowMs) {
  const minCutoff = nowMs - 60_000;
  const hourCutoff = nowMs - 60 * 60_000;
  policyState.globalAttemptTimestampsMs = (policyState.globalAttemptTimestampsMs || [])
    .filter(ts => Number(ts || 0) > minCutoff)
    .slice(-500);
  for (const mint of Object.keys(policyState.perMintAttemptTimestampsMs || {})) {
    const next = (policyState.perMintAttemptTimestampsMs[mint] || []).filter(ts => Number(ts || 0) > hourCutoff);
    if (next.length) policyState.perMintAttemptTimestampsMs[mint] = next.slice(-500);
    else delete policyState.perMintAttemptTimestampsMs[mint];
  }
}

export function evaluateForceAttemptPolicyGuards({ cfg, policyState, row, mint, nowMs }) {
  if (Number(row?.cooldownUntilMs || 0) > nowMs) return { ok: false, reason: 'forcePolicyMintCooldown' };
  const mintAttempts = policyState.perMintAttemptTimestampsMs?.[mint] || [];
  if (mintAttempts.length >= Number(cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR || 0)) {
    return { ok: false, reason: 'forcePolicyMintHourlyCap' };
  }
  const globalAttempts = policyState.globalAttemptTimestampsMs || [];
  if (globalAttempts.length >= Number(cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE || 0)) {
    return { ok: false, reason: 'forcePolicyGlobalRateCap' };
  }
  return { ok: true };
}

export function recordForceAttemptPolicyAttempt({ policyState, mint, nowMs }) {
  policyState.globalAttemptTimestampsMs ||= [];
  policyState.perMintAttemptTimestampsMs ||= {};
  policyState.globalAttemptTimestampsMs.push(nowMs);
  policyState.perMintAttemptTimestampsMs[mint] ||= [];
  policyState.perMintAttemptTimestampsMs[mint].push(nowMs);
}
