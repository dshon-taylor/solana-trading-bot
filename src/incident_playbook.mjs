export const PLAYBOOK_MODE_NORMAL = 'normal';
export const PLAYBOOK_MODE_DEGRADED = 'degraded';

export function ensurePlaybookState(state) {
  state.playbook ||= {};
  state.playbook.mode ||= PLAYBOOK_MODE_NORMAL;
  state.playbook.reason ||= null;
  state.playbook.sinceMs ||= 0;
  state.playbook.lastTransitionMs ||= 0;
  state.playbook.restarts ||= [];
  state.playbook.errors ||= [];
  state.playbook.selfRecovery ||= { attempts: 0, lastAtMs: 0, lastNote: null };
}

function pruneWindow(list, nowMs, windowMs) {
  return (list || []).filter((x) => Number(x?.atMs || 0) >= (nowMs - windowMs)).slice(-200);
}

export function recordPlaybookRestart({ state, nowMs, note = 'process_restart' }) {
  ensurePlaybookState(state);
  state.playbook.restarts.push({ atMs: nowMs, note });
}

export function recordPlaybookError({ state, nowMs, kind = 'error', note = '' }) {
  ensurePlaybookState(state);
  state.playbook.errors.push({ atMs: nowMs, kind, note });
}

export function evaluatePlaybook({ state, cfg, nowMs, circuitOpen }) {
  ensurePlaybookState(state);

  state.playbook.restarts = pruneWindow(state.playbook.restarts, nowMs, cfg.PLAYBOOK_RESTART_WINDOW_MS);
  state.playbook.errors = pruneWindow(state.playbook.errors, nowMs, cfg.PLAYBOOK_ERROR_WINDOW_MS);

  const recentRestarts = state.playbook.restarts.length;
  const recentErrors = state.playbook.errors.length;

  const triggerRestart = cfg.PLAYBOOK_RESTART_THRESHOLD > 0 && recentRestarts >= cfg.PLAYBOOK_RESTART_THRESHOLD;
  const triggerError = cfg.PLAYBOOK_ERROR_THRESHOLD > 0 && recentErrors >= cfg.PLAYBOOK_ERROR_THRESHOLD;
  const triggerCircuit = !!circuitOpen;

  if (state.playbook.mode !== PLAYBOOK_MODE_DEGRADED && (triggerRestart || triggerError || triggerCircuit)) {
    const reason = triggerRestart
      ? `restart_pattern(${recentRestarts}/${cfg.PLAYBOOK_RESTART_THRESHOLD})`
      : triggerError
        ? `error_pattern(${recentErrors}/${cfg.PLAYBOOK_ERROR_THRESHOLD})`
        : 'circuit_open';

    state.playbook.mode = PLAYBOOK_MODE_DEGRADED;
    state.playbook.reason = reason;
    state.playbook.sinceMs = nowMs;
    state.playbook.lastTransitionMs = nowMs;
    return { transition: 'enter_degraded', reason, recentRestarts, recentErrors };
  }

  if (state.playbook.mode === PLAYBOOK_MODE_DEGRADED) {
    const healthyRestarts = recentRestarts < Math.max(1, cfg.PLAYBOOK_RESTART_THRESHOLD);
    const healthyErrors = recentErrors < Math.max(1, cfg.PLAYBOOK_ERROR_THRESHOLD);
    const stableLongEnough = (nowMs - Number(state.playbook.sinceMs || 0)) >= cfg.PLAYBOOK_STABLE_RECOVERY_MS;

    if (!circuitOpen && healthyRestarts && healthyErrors && stableLongEnough) {
      state.playbook.mode = PLAYBOOK_MODE_NORMAL;
      state.playbook.reason = null;
      state.playbook.lastTransitionMs = nowMs;
      return { transition: 'exit_degraded', reason: 'stable_recovery', recentRestarts, recentErrors };
    }
  }

  return { transition: 'none', recentRestarts, recentErrors, mode: state.playbook.mode };
}

export function runSelfRecovery({ state, nowMs, note = 'reconcile_and_reset_backoffs' }) {
  ensurePlaybookState(state);
  state.playbook.selfRecovery.attempts = Number(state.playbook.selfRecovery.attempts || 0) + 1;
  state.playbook.selfRecovery.lastAtMs = nowMs;
  state.playbook.selfRecovery.lastNote = note;
}
