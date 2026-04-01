import { createLaserstreamDevnetClient } from './laserstream_devnet.mjs';

function createExistingProvider() {
  return {
    mode: 'existing',
    start() {},
    stop() {},
    drainCandidates() { return []; },
    getHealth() {
      return {
        mode: 'existing',
        status: 'disabled',
        queueDepth: 0,
      };
    },
    getMetrics() {
      return {
        mode: 'existing',
        disconnects: 0,
        reconnects: 0,
        replayedMessages: 0,
        liveMessages: 0,
        receivedCandidates: 0,
        lagMs: 0,
        queueDepth: 0,
      };
    },
  };
}

export function createStreamingProvider(cfg = {}, opts = {}) {
  const mode = String(cfg.STREAMING_PROVIDER_MODE || 'existing').toLowerCase();
  const laserEnabled = cfg.LASERSTREAM_ENABLED === true;

  if (mode === 'laserstream-devnet') {
    if (!cfg.LASERSTREAM_STAGING_MODE) return createExistingProvider();
    if (!laserEnabled) return createExistingProvider();

    const client = createLaserstreamDevnetClient({
      wsUrl: cfg.LASERSTREAM_DEVNET_WS_URL,
      rpcUrl: cfg.LASERSTREAM_DEVNET_RPC_URL,
      programIds: cfg.LASERSTREAM_PROGRAM_IDS,
      reconnectBaseMs: cfg.LASERSTREAM_RECONNECT_BASE_MS,
      reconnectMaxMs: cfg.LASERSTREAM_RECONNECT_MAX_MS,
      replayLookbackSeconds: cfg.LASERSTREAM_REPLAY_LOOKBACK_SECONDS,
      heartbeatStaleMs: cfg.LASERSTREAM_HEARTBEAT_STALE_MS,
      bufferMax: cfg.LASERSTREAM_BUFFER_MAX,
      ...opts,
    });

    return {
      mode,
      ...client,
    };
  }

  return createExistingProvider();
}
