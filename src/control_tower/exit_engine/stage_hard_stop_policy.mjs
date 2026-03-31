export function recordHardStopAndMaybePause({ cfg, state, nowMs, reason }) {
  if (!cfg.HARD_STOP_COOLDOWN_ENABLED) return { tripped: false };
  const why = String(reason || '').toLowerCase();
  const isHardStop = why.includes('stop hit') && !why.includes('trailing stop');
  if (!isHardStop) return { tripped: false };

  state.runtime ||= {};
  state.runtime.hardStopEventsMs ||= [];
  const windowMs = Number(cfg.HARD_STOP_COOLDOWN_WINDOW_MS || (15 * 60_000));
  const cutoff = nowMs - windowMs;
  state.runtime.hardStopEventsMs = state.runtime.hardStopEventsMs.filter((ts) => Number(ts || 0) >= cutoff);
  state.runtime.hardStopEventsMs.push(nowMs);

  const trigger = Number(cfg.HARD_STOP_COOLDOWN_TRIGGER_COUNT || 3);
  if (state.runtime.hardStopEventsMs.length >= trigger) {
    state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
    const pauseMs = Number(cfg.HARD_STOP_COOLDOWN_PAUSE_MS || (20 * 60_000));
    const until = nowMs + pauseMs;
    state.exposure.pausedUntilMs = Math.max(Number(state.exposure.pausedUntilMs || 0), until);
    state.runtime.hardStopEventsMs = [];
    return { tripped: true, untilMs: state.exposure.pausedUntilMs };
  }
  return { tripped: false };
}
