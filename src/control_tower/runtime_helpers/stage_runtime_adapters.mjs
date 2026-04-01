export function createRuntimeAdapters({
  resolveConfirmTxMetrics,
  snapshotFromBirdseye,
  computeMcapUsdCore,
  getTokenSupply,
  runNodeScriptJsonCore,
  safeErr,
}) {
  const resolveConfirmTxMetricsWithFallback = (args) => resolveConfirmTxMetrics({
    ...args,
    snapshotFromBirdseye,
  });

  const computeMcapUsd = (cfg, pair, rpcUrl) => computeMcapUsdCore(cfg, pair, rpcUrl, { getTokenSupply });

  const runNodeScriptJson = (scriptPath, args, timeoutMs = 90_000) => runNodeScriptJsonCore(scriptPath, args, { timeoutMs, safeErr });

  return {
    resolveConfirmTxMetricsWithFallback,
    computeMcapUsd,
    runNodeScriptJson,
  };
}
