export async function runLoopTail({
  t,
  cfg,
  lastPosRef,
  runPositionsLoop,
  processOperatorCommands,
}) {
  await processOperatorCommands(t);

  if (t - lastPosRef.value >= cfg.POSITIONS_EVERY_MS) {
    await runPositionsLoop(t);
  }

  await new Promise((r) => setTimeout(r, 250));
}
