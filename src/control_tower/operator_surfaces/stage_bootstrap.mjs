export function bootstrapOperatorSurfaces({
  cfg,
  state,
  conn,
  pub,
  tgSend,
  tgSendChunked,
  getDiagSnapshotMessage,
  createSpendSummaryCache,
  parseRange,
  readLedger,
  summarize,
  safeErr,
  runNodeScriptJson,
  sendPositionsReport,
  getLoopState,
  createOperatorSurfaces,
}) {
  const SPEND_CACHE_TTL_MS = Math.max(60_000, Number(process.env.SPEND_CACHE_TTL_MS || 5 * 60_000));
  const {
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
  } = createSpendSummaryCache({
    cfg,
    parseRange,
    readLedger,
    summarize,
    safeErr,
  });

  const { processOperatorCommands } = createOperatorSurfaces({
    cfg,
    state,
    conn,
    pub,
    tgSend,
    tgSendChunked,
    getDiagSnapshotMessage,
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
    SPEND_CACHE_TTL_MS,
    runNodeScriptJson,
    appendLearningNote: undefined,
    getSolUsdPrice: undefined,
    sendPositionsReport,
    getLoopState,
  });

  return {
    processOperatorCommands,
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
    SPEND_CACHE_TTL_MS,
  };
}
