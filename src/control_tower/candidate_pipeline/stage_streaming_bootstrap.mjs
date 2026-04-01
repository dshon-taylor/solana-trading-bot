export function bootstrapStreamingCandidateSources({
  cfg,
  state,
  birdseye,
  tgSend,
  saveState,
  createStreamingProvider,
  createCandidatePipeline,
}) {
  const streamingProvider = createStreamingProvider(cfg, {
    log: (...args) => console.log(...args),
  });
  streamingProvider.start();

  const { fetchCandidateSources } = createCandidatePipeline({
    cfg,
    state,
    birdseye,
    streamingProvider,
    tgSend,
    saveState,
  });

  return {
    streamingProvider,
    fetchCandidateSources,
    lastStreamingHealthAt: 0,
  };
}
