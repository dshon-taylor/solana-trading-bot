import { createRefreshDiagSnapshot, initializeDiagSnapshotState } from './stage_diag_snapshot.mjs';
import { createGetDiagSnapshotMessage } from './stage_get_diag_message.mjs';
import { createMaybeRefreshDiagSnapshot } from './stage_maybe_refresh.mjs';
export { initializeDiagCounters } from './stage_boot_counters.mjs';
export { runRejectionSummary } from './stage_rejection_summary.mjs';

export function createDiagReporting({
  state,
  getCounters,
  cfg,
  birdseye,
  nowIso,
  fmtCt,
}) {
  const runtime = initializeDiagSnapshotState({ state });

  const refreshDiagSnapshot = createRefreshDiagSnapshot({
    state,
    getCounters,
    cfg,
    birdseye,
    runtime,
  });

  const getDiagSnapshotMessage = createGetDiagSnapshotMessage({
    state,
    getCounters,
    cfg,
    nowIso,
    fmtCt,
    runtime,
  });

  const maybeRefreshDiagSnapshot = createMaybeRefreshDiagSnapshot({
    runtime,
    refreshDiagSnapshot,
  });

  return { refreshDiagSnapshot, getDiagSnapshotMessage, maybeRefreshDiagSnapshot };
}
