export async function runLoopHousekeeping({
  t,
  cfg,
  state,
  conn,
  wallet,
  lastExposureQueueDrainAt,
  lastStreamingHealthAt,
  spendSummaryCache,
  SPEND_CACHE_TTL_MS,
  refreshSpendSummaryCacheAsync,
  streamingProvider,
  syncExposureStateWithPositions,
  processExposureQueue,
  safeErr,
}) {
  let nextLastExposureQueueDrainAt = lastExposureQueueDrainAt;
  let nextLastStreamingHealthAt = lastStreamingHealthAt;

  if ((t - nextLastExposureQueueDrainAt) >= Math.max(2_000, Number(process.env.EXPOSURE_QUEUE_EVERY_MS || 7_500))) {
    nextLastExposureQueueDrainAt = t;
    try {
      syncExposureStateWithPositions({ cfg, state });
      if (Array.isArray(state.exposure?.queue) && state.exposure.queue.length > 0) {
        await processExposureQueue(cfg, conn, wallet, state);
      }
    } catch (e) {
      console.warn('[exposure] periodic queue drain failed', safeErr(e).message);
    }
  }

  if (!spendSummaryCache.inFlight && (t - Number(spendSummaryCache.loadedAtMs || 0) >= SPEND_CACHE_TTL_MS)) {
    refreshSpendSummaryCacheAsync();
  }

  if (t - nextLastStreamingHealthAt > 60_000) {
    nextLastStreamingHealthAt = t;
    state.streaming ||= {};
    state.streaming.health = streamingProvider?.getHealth?.(t) || null;
    state.streaming.metrics = streamingProvider?.getMetrics?.() || null;
  }

  return {
    lastExposureQueueDrainAt: nextLastExposureQueueDrainAt,
    lastStreamingHealthAt: nextLastStreamingHealthAt,
  };
}
