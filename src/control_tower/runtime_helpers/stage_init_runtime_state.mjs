export function initializeRuntimeState({
  cfg,
  state,
  ensureDexState,
  ensureMarketDataState,
  ensureCircuitState,
  ensureCapitalGuardrailsState,
  ensurePlaybookState,
  ensureForceAttemptPolicyState,
  recordPlaybookRestart,
  getDexCooldownUntilMs,
}) {
  ensureDexState(state);
  ensureMarketDataState(state);
  ensureCircuitState(state);
  ensureCapitalGuardrailsState(state);
  ensurePlaybookState(state);
  ensureForceAttemptPolicyState(state);

  const bootNowMs = Date.now();
  if (cfg.PLAYBOOK_ENABLED) {
    recordPlaybookRestart({ state, nowMs: bootNowMs });
  }

  state.tradingEnabled = state.tradingEnabled ?? (cfg.EXECUTION_ENABLED && cfg.FORCE_TRADING_ENABLED);
  state.debug ||= {};
  state.debug.last ||= [];
  state.flags ||= {};
  state.filterOverrides ||= state.filterOverrides || null;
  state.modelOverrides ||= state.modelOverrides || null;

  return {
    dexCooldownUntil: getDexCooldownUntilMs(state),
  };
}
