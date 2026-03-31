export function createSpendSummaryCache({
  cfg,
  parseRange,
  readLedger,
  summarize,
  safeErr,
}) {
  const spendSummaryCache = {
    loadedAtMs: 0,
    summaries: new Map(),
    inFlight: false,
    lastError: null,
  };

  function refreshSpendSummaryCacheAsync() {
    if (spendSummaryCache.inFlight) return;
    spendSummaryCache.inFlight = true;
    Promise.resolve().then(() => {
      const events = readLedger(cfg.LEDGER_PATH);
      const next = new Map();
      for (const key of ['last', '24h', '7d', '30d']) {
        next.set(key, summarize(events, parseRange(key)));
      }
      spendSummaryCache.summaries = next;
      spendSummaryCache.loadedAtMs = Date.now();
      spendSummaryCache.lastError = null;
    }).catch((e) => {
      spendSummaryCache.lastError = safeErr(e).message;
    }).finally(() => {
      spendSummaryCache.inFlight = false;
    });
  }

  return {
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
  };
}
