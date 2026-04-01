export async function bootRuntimeContext({
  getConfig,
  summarizeConfigForBoot,
  loadWallet,
  getPublicKeyBase58,
  makeConnection,
  loadState,
  createBirdseyeLiteClient,
  initBirdEyeRuntimeListeners,
  wsmgr,
  birdEyeWs,
  safeErr,
  bindWsManagerExitHandler,
  getSplBalance,
  executeSwap,
  getSolUsdPrice,
  closePosition,
  startWatchlistCleanupTimer,
  globalTimers,
  ensureWatchlistState,
  seedOpenPositionsOnBoot,
  cache,
  announceBootStatus,
  tgSend,
  tgSetMyCommands,
  resolveBootSolUsdWithRetry,
  safeMsg,
  sendBootBalancesMessage,
  getSolBalanceLamports,
  fmtUsd,
  reconcileStartupState,
  reconcilePositions,
  positionCount,
  syncExposureStateWithPositions,
}) {
  const cfg = getConfig();
  console.log(summarizeConfigForBoot(cfg));

  const wallet = loadWallet();
  const pub = getPublicKeyBase58(wallet);
  const conn = makeConnection(cfg.SOLANA_RPC_URL);
  const state = loadState(cfg.STATE_PATH);

  const birdseye = createBirdseyeLiteClient({
    enabled: cfg.BIRDEYE_LITE_ENABLED,
    apiKey: cfg.BIRDEYE_API_KEY,
    chain: cfg.BIRDEYE_LITE_CHAIN,
    maxRps: cfg.BIRDEYE_LITE_MAX_RPS,
    cacheTtlMs: cfg.BIRDEYE_LITE_CACHE_TTL_MS,
    perMintMinIntervalMs: cfg.BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS,
  });

  try {
    initBirdEyeRuntimeListeners({ state, wsmgr, birdEyeWs, safeErr });
    birdEyeWs.start();
  } catch (e) {
    console.warn('[birdeye-ws] start failed', safeErr(e).message);
  }

  bindWsManagerExitHandler({
    wsmgr,
    state,
    cfg,
    conn,
    wallet,
    getSplBalance,
    executeSwap,
    getSolUsdPrice,
    closePosition,
    safeErr,
  });

  startWatchlistCleanupTimer({ globalTimers, cfg, wsmgr });

  state.positions ||= {};
  state.portfolio ||= { maxEquityUsd: cfg.STARTING_CAPITAL_USDC };
  state.paperAttempts ||= [];
  state.runtime ||= {};
  state.runtime.botStartTimeMs = Date.now();
  ensureWatchlistState(state);

  await seedOpenPositionsOnBoot({
    state,
    cfg,
    wsmgr,
    cache,
    birdseye,
    closePosition,
    conn,
    wallet,
  });

  await announceBootStatus({ cfg, pub, tgSend, tgSetMyCommands });

  const solUsd = await resolveBootSolUsdWithRetry({
    getSolUsdPrice,
    tgSend,
    cfg,
    safeMsg,
  });

  await sendBootBalancesMessage({
    cfg,
    conn,
    pub,
    solUsd,
    getSolBalanceLamports,
    tgSend,
    fmtUsd,
  });

  await reconcileStartupState({
    cfg,
    conn,
    pub,
    state,
    reconcilePositions,
    positionCount,
    syncExposureStateWithPositions,
    safeErr,
  });

  return { cfg, wallet, pub, conn, state, birdseye, solUsd };
}
