export function buildRuntimePipelines({
  createScanPipeline,
  createEntryDispatch,
  scanPipelineArgs,
  entryDispatchArgs,
}) {
  const { runScanPipeline } = createScanPipeline(scanPipelineArgs);
  const { runEntryDispatch } = createEntryDispatch(entryDispatchArgs);
  return { runScanPipeline, runEntryDispatch };
}
