export function createMaybeRefreshDiagSnapshot({ runtime, refreshDiagSnapshot }) {
  return function maybeRefreshDiagSnapshot(t) {
    if (t - runtime.lastDiagSnapshotAt >= runtime.DIAG_SNAPSHOT_EVERY_MS) {
      runtime.lastDiagSnapshotAt = t;
      refreshDiagSnapshot(t);
    }
  };
}
