export function syncExposureStateWithPositions({ cfg, state }) {
  state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
  const openCount = Object.values(state.positions || {}).filter((p) => p?.status === 'open').length;
  const maxActive = Math.max(1, Number(cfg?.MAX_ACTIVE_RUNNERS || 3));
  state.exposure.activeRunnerCount = Math.max(0, Math.min(openCount, maxActive));
  return { openCount, activeRunnerCount: state.exposure.activeRunnerCount };
}
