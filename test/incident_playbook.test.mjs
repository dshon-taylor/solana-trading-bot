import { describe, it, expect } from 'vitest';
import {
  ensurePlaybookState,
  recordPlaybookRestart,
  recordPlaybookError,
  evaluatePlaybook,
  PLAYBOOK_MODE_DEGRADED,
} from '../src/observability/incident_playbook.mjs';

const cfg = {
  PLAYBOOK_RESTART_THRESHOLD: 3,
  PLAYBOOK_RESTART_WINDOW_MS: 10 * 60_000,
  PLAYBOOK_ERROR_THRESHOLD: 4,
  PLAYBOOK_ERROR_WINDOW_MS: 5 * 60_000,
  PLAYBOOK_STABLE_RECOVERY_MS: 2 * 60_000,
};

describe('incident playbook', () => {
  it('enters degraded mode on restart threshold, then exits when stable', () => {
    const state = {};
    ensurePlaybookState(state);
    const t0 = Date.now();

    recordPlaybookRestart({ state, nowMs: t0 - 30_000 });
    recordPlaybookRestart({ state, nowMs: t0 - 20_000 });
    recordPlaybookRestart({ state, nowMs: t0 - 10_000 });

    const enter = evaluatePlaybook({ state, cfg, nowMs: t0, circuitOpen: false });
    expect(enter.transition).toBe('enter_degraded');
    expect(state.playbook.mode).toBe(PLAYBOOK_MODE_DEGRADED);

    const hold = evaluatePlaybook({ state, cfg, nowMs: t0 + 60_000, circuitOpen: false });
    expect(hold.transition).toBe('none');

    // after window passes and stable time reached, auto-recover
    const exit = evaluatePlaybook({
      state,
      cfg,
      nowMs: t0 + cfg.PLAYBOOK_STABLE_RECOVERY_MS + cfg.PLAYBOOK_RESTART_WINDOW_MS,
      circuitOpen: false,
    });
    expect(exit.transition).toBe('exit_degraded');
  });

  it('enters degraded mode on error bursts', () => {
    const state = {};
    ensurePlaybookState(state);
    const t0 = Date.now();

    for (let i = 0; i < 4; i++) {
      recordPlaybookError({ state, nowMs: t0 - (i * 5_000), kind: 'swap_error' });
    }

    const enter = evaluatePlaybook({ state, cfg, nowMs: t0, circuitOpen: false });
    expect(enter.transition).toBe('enter_degraded');
    expect(String(enter.reason)).toMatch(/error_pattern/);
  });
});
