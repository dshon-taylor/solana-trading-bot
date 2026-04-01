export function startRpcProbeAndHeartbeat({ cfg, state, conn, pub, tgSend }) {
  import('../../persistence/rpc_probe.mjs').then(({ startRpcProbe }) => {
    try {
      const rpcHealth = startRpcProbe({ cfg, intervalMs: Number(process.env.RPC_PROBE_EVERY_MS || 30000) });
      import('../../observability/heartbeat.mjs').then(({ startHeartbeat }) => {
        try {
          startHeartbeat({ cfg, state, conn, walletPub: pub, tgSend, rpcHealth });
        } catch (e) {
          console.warn('[heartbeat] failed to start', e?.message || e);
        }
      }).catch((e) => console.warn('[heartbeat] import failed', e?.message || e));
    } catch (e) {
      console.warn('[rpc_probe] failed to start', e?.message || e);
    }
  }).catch((e) => console.warn('[rpc_probe] import failed', e?.message || e));
}
