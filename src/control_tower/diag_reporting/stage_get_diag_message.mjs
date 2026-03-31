import { createGetDiagSnapshotMessageFull } from './stage_get_diag_message_full_implementation.mjs';

export function createGetDiagSnapshotMessage({
  state,
  getCounters,
  cfg,
  nowIso,
  fmtCt,
  runtime,
}) {
  void nowIso;
  void cfg;

  return createGetDiagSnapshotMessageFull({ state, getCounters, cfg, fmtCt, runtime });
}
