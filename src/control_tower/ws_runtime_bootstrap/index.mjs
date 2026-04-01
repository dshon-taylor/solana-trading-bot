export function setupBirdEyeWsGlue({ wsmgr, birdEyeWs, cache, snapshotFromBirdseye, globalTimers }) {
  if (!globalThis.__WSMGR_BOUND__) {
    wsmgr.bindClients({ wsClient: birdEyeWs, restClient: { fetchSnapshot: snapshotFromBirdseye } });
    globalThis.__WSMGR_BOUND__ = true;
  }

  if (!globalThis.__BIRDEYE_PRICE_HANDLER_BOUND__) {
    try {
      birdEyeWs.on?.('price', ({ mint, price, ts, volume }) => {
        try {
          wsmgr.onWsEvent(mint, {
            price: Number(price),
            ts: Number(ts) || Date.now(),
            volume,
          });
        } catch {}
      });

      const FALLBACK_POLL_MS = Math.max(5000, Number(process.env.BIRDEYE_WS_FALLBACK_POLL_MS || 10000));
      let lastEventTime = Date.now();
      const originalOnWsEvent = wsmgr.onWsEvent;
      wsmgr.onWsEvent = function(...args) {
        lastEventTime = Date.now();
        return originalOnWsEvent.apply(this, args);
      };

      if (!globalTimers.birdeyeWsPoll) {
        globalTimers.birdeyeWsPoll = setInterval(() => {
          try {
            const timeSinceLastEvent = Date.now() - lastEventTime;
            if (timeSinceLastEvent < 5000) return;

            const subs = Array.from(birdEyeWs.subscribed || []);
            const now = Date.now();
            for (const mint of subs) {
              const p = cache.get(`birdeye:ws:price:${mint}`) || null;
              if (p && p.priceUsd != null) {
                wsmgr.onWsEvent(mint, { price: Number(p.priceUsd), ts: Number(p.tsMs) || now });
              }
            }
          } catch {}
        }, FALLBACK_POLL_MS);
      }

      globalThis.__BIRDEYE_PRICE_HANDLER_BOUND__ = true;
    } catch {}
  }

  if (!globalThis.__WSMGR_SUB_EVENTS_BOUND__) {
    wsmgr.on('subscribe', ({ mint }) => {
      try { cache.set(`birdeye:sub:${mint}`, true, Math.ceil((process.env.BIRDEYE_LITE_CACHE_TTL_MS || 45000) / 1000)); } catch {}
    });
    wsmgr.on('unsubscribe', ({ mint }) => {
      try { cache.delete && cache.delete(`birdeye:sub:${mint}`); } catch {}
    });
    globalThis.__WSMGR_SUB_EVENTS_BOUND__ = true;
  }
}

export function initBirdEyeRuntimeListeners({ state, wsmgr, birdEyeWs, safeErr }) {
  if (globalThis.__BIRDEYE_RUNTIME_LISTENERS_BOUND__) return;

  birdEyeWs.on?.('open', () => {
    for (const mint of Object.keys(state?.positions || {})) {
      if (wsmgr.diag && wsmgr.diag[mint]) wsmgr.diag[mint].ws_connected = true;
    }
    const priceListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('price') : 'n/a';
    const openListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('open') : 'n/a';
    const closeListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('close') : 'n/a';
    const errorListeners = typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('error') : 'n/a';
    console.log('[birdeye-ws] connected', { priceListeners, openListeners, closeListeners, errorListeners, wsmgrBound: !!globalThis.__WSMGR_BOUND__ });
  });

  birdEyeWs.on?.('close', () => {
    for (const mint of Object.keys(state?.positions || {})) {
      if (wsmgr.diag && wsmgr.diag[mint]) wsmgr.diag[mint].ws_connected = false;
    }
    console.warn('[birdeye-ws] closed');
  });

  birdEyeWs.on?.('error', (e) => {
    console.warn('[birdeye-ws] error', safeErr(e).message);
  });

  globalThis.__BIRDEYE_RUNTIME_LISTENERS_BOUND__ = true;

  console.log('[birdeye-ws] listeners', {
    price: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('price') : 'n/a',
    open: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('open') : 'n/a',
    close: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('close') : 'n/a',
    error: typeof birdEyeWs?.listenerCount === 'function' ? birdEyeWs.listenerCount('error') : 'n/a',
  });
}
