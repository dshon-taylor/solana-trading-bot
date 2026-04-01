const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function inferRpcUrl(wsUrl) {
  if (!wsUrl) return '';
  if (wsUrl.startsWith('wss://')) return wsUrl.replace(/^wss:/, 'https:');
  if (wsUrl.startsWith('ws://')) return wsUrl.replace(/^ws:/, 'http:');
  return wsUrl;
}

function parseProgramIds(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractBase58Mentions(payload) {
  const text = JSON.stringify(payload || {});
  return [...new Set((text.match(BASE58_RE) || []).filter((x) => x.length >= 32 && x.length <= 44))];
}

async function defaultRpcCall(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC_HTTP_${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error?.message || 'RPC_ERROR');
  return json.result;
}

export function createLaserstreamDevnetClient(opts = {}) {
  const wsUrl = opts.wsUrl || process.env.LASERSTREAM_DEVNET_WS_URL || '';
  const rpcUrl = opts.rpcUrl || process.env.LASERSTREAM_DEVNET_RPC_URL || inferRpcUrl(wsUrl);
  const programIds = opts.programIds || parseProgramIds(process.env.LASERSTREAM_PROGRAM_IDS);
  const reconnectBaseMs = Math.max(250, Number(opts.reconnectBaseMs || process.env.LASERSTREAM_RECONNECT_BASE_MS || 1000));
  const reconnectMaxMs = Math.max(reconnectBaseMs, Number(opts.reconnectMaxMs || process.env.LASERSTREAM_RECONNECT_MAX_MS || 15000));
  const replayLookbackSeconds = Math.max(5, Number(opts.replayLookbackSeconds || process.env.LASERSTREAM_REPLAY_LOOKBACK_SECONDS || 120));
  const heartbeatStaleMs = Math.max(1000, Number(opts.heartbeatStaleMs || process.env.LASERSTREAM_HEARTBEAT_STALE_MS || 15000));
  const bufferMax = Math.max(100, Number(opts.bufferMax || process.env.LASERSTREAM_BUFFER_MAX || 2000));

  const socketFactory = opts.socketFactory || ((url) => new globalThis.WebSocket(url));
  const rpcCall = opts.rpcCall || ((method, params) => defaultRpcCall(rpcUrl, method, params));
  const log = opts.log || (() => {});

  let ws = null;
  let stopRequested = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;

  const queue = [];
  const seenSig = new Set();
  const metrics = {
    startedAtMs: Date.now(),
    disconnects: 0,
    reconnects: 0,
    replayedMessages: 0,
    liveMessages: 0,
    receivedCandidates: 0,
    queueDrops: 0,
    lastMessageAtMs: 0,
    lagMs: 0,
  };

  function enqueueCandidate(mint, meta = {}) {
    if (!mint) return;
    queue.push({
      tokenAddress: mint,
      tokenSymbol: null,
      _source: 'laserstream-devnet',
      _meta: {
        t: toIso(),
        kind: meta.kind || 'live',
        sig: meta.sig || null,
      },
    });
    if (queue.length > bufferMax) {
      queue.splice(0, queue.length - bufferMax);
      metrics.queueDrops += 1;
    }
    metrics.receivedCandidates += 1;
  }

  function handlePayload(payload, kind = 'live') {
    const nowMs = Date.now();
    metrics.lastMessageAtMs = nowMs;
    metrics.lagMs = Math.max(0, nowMs - Number(payload?.params?.result?.context?.slotTimeMs || nowMs));
    if (kind === 'replay') metrics.replayedMessages += 1;
    else metrics.liveMessages += 1;

    const mentions = extractBase58Mentions(payload);
    for (const mint of mentions.slice(0, 8)) enqueueCandidate(mint, { kind, sig: payload?.params?.result?.value?.signature || null });
  }

  async function runReplayBackfill() {
    if (!rpcUrl || !programIds.length) return;
    const minBlockTime = Math.floor((Date.now() - (replayLookbackSeconds * 1000)) / 1000);

    for (const programId of programIds) {
      let signatures = [];
      try {
        signatures = await rpcCall('getSignaturesForAddress', [programId, { limit: 30 }]);
      } catch (error) {
        log('[laserstream] replay signatures failed', error?.message || error);
        continue;
      }
      for (const row of signatures || []) {
        if (!row?.signature || seenSig.has(row.signature)) continue;
        if (Number(row.blockTime || 0) < minBlockTime) continue;
        seenSig.add(row.signature);
        try {
          const tx = await rpcCall('getTransaction', [row.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
          if (!tx) continue;
          handlePayload({ params: { result: { value: { signature: row.signature, tx } } } }, 'replay');
        } catch (error) {
          log('[laserstream] replay tx failed', row.signature, error?.message || error);
        }
      }
    }
  }

  function scheduleReconnect() {
    if (stopRequested) return;
    reconnectAttempts += 1;
    metrics.reconnects += 1;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** Math.min(8, reconnectAttempts - 1)));
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopRequested) return;
    if (!wsUrl) throw new Error('LASERSTREAM_DEVNET_WS_URL missing');
    ws = socketFactory(wsUrl);

    ws.onopen = async () => {
      reconnectAttempts = 0;

      // Baseline heartbeat stream: slot notifications are frequent on active clusters,
      // so this gives us a cheap liveness signal even when program logs are quiet.
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe', params: [] }));

      const ids = programIds.length ? programIds : [];
      ids.forEach((programId, i) => {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: i + 2,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }));
      });
      await runReplayBackfill();
    };

    ws.onmessage = (event) => {
      const payload = safeJsonParse(event?.data);
      if (!payload) return;
      handlePayload(payload, 'live');
    };

    ws.onerror = () => {
      // close handler will perform reconnect.
    };

    ws.onclose = () => {
      metrics.disconnects += 1;
      scheduleReconnect();
    };
  }

  return {
    start() {
      stopRequested = false;
      connect();
      pingTimer = globalThis.setInterval(() => {
        if (!metrics.lastMessageAtMs) return;
        const age = Date.now() - metrics.lastMessageAtMs;
        if (age > heartbeatStaleMs) {
          log(`[laserstream] stale heartbeat ageMs=${age}`);
        }
      }, Math.max(1000, Math.floor(heartbeatStaleMs / 2)));
      pingTimer.unref?.();
    },

    stop() {
      stopRequested = true;
      clearTimeout(reconnectTimer);
      globalThis.clearInterval(pingTimer);
      reconnectTimer = null;
      pingTimer = null;
      try {
        ws?.close();
      } catch {}
    },

    drainCandidates(limit = 200) {
      const n = Math.max(1, Math.min(queue.length, Number(limit || 200)));
      return queue.splice(0, n);
    },

    getHealth(nowMs = Date.now()) {
      const last = Number(metrics.lastMessageAtMs || 0);
      const ageMs = last ? Math.max(0, nowMs - last) : null;
      return {
        mode: 'laserstream-devnet',
        status: !last ? 'warming' : (ageMs > heartbeatStaleMs ? 'stale' : 'healthy'),
        lastMessageAtMs: last || null,
        lastMessageAgeMs: ageMs,
        heartbeatStaleMs,
        queueDepth: queue.length,
      };
    },

    getMetrics() {
      return {
        ...metrics,
        queueDepth: queue.length,
        uptimeMs: Math.max(0, Date.now() - metrics.startedAtMs),
      };
    },

    async soak(durationMs = 60_000) {
      this.start();
      await sleep(durationMs);
      const health = this.getHealth();
      const out = { health, metrics: this.getMetrics() };
      this.stop();
      return out;
    },
  };
}
