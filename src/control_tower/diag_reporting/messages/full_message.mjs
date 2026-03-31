export function buildFullDiagMessage({ state, fmtCt, nowMs, windowHours, updatedIso, ageSec, diagSnapshot }) {
  state.runtime ||= {};
  if (!Number.isFinite(Number(state.runtime.botStartTimeMs || 0))) state.runtime.botStartTimeMs = nowMs;
  const botStartTimeMs = Number(state.runtime.botStartTimeMs || nowMs);
  const useWindowHours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : null;
  const windowStartMs = useWindowHours ? (nowMs - (useWindowHours * 3_600_000)) : botStartTimeMs;
  const windowLabel = useWindowHours ? `${useWindowHours}h` : 'sinceStart';
  return [
    `🧪 *Diag Snapshot* window=${windowLabel} start=${fmtCt(windowStartMs)}`,
    `snapshotAt=${updatedIso} staleness=${ageSec == null ? 'n/a' : `${ageSec}s`} buildMs=${diagSnapshot.builtInMs}`,
    diagSnapshot.message,
  ].join('\n');
}
