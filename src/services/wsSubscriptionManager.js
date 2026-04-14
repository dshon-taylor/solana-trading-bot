import { EventEmitter } from 'node:events';

class WsSubscriptionManager extends EventEmitter {
  constructor() {
    super();
    this.live = new Map();
    this.diag = {};
    this.wsClient = null;
    this.restClient = null;
    this.staleMs = Math.max(300, Number(process.env.BIRDEYE_WS_STALE_MS || 1200));
  }

  bindClients({ wsClient, restClient } = {}) {
    this.wsClient = wsClient || this.wsClient;
    this.restClient = restClient || this.restClient;
  }

  subscribe(mint) {
    if (!mint) return;
    const rec = this.live.get(mint) || {};
    rec.subscribed = true;
    this.live.set(mint, rec);
    this.diag[mint] = this.diag[mint] || {};
    this.diag[mint].subscribedAtMs = this.diag[mint].subscribedAtMs || Date.now();
    this.emit('subscribe', { mint });
    try { this.wsClient?.subscribeMint?.(mint); } catch {}
  }

  unsubscribe(mint) {
    if (!mint) return;
    this.live.delete(mint);
    delete this.diag[mint];
    this.emit('unsubscribe', { mint });
    try { this.wsClient?.unsubscribeMint?.(mint); } catch {}
  }

  onFill(mint, { entryPrice = null, stopPrice = null, stopPct = null, trailingPct = null } = {}) {
    if (!mint) return;
    const rec = this.live.get(mint) || {};
    rec.entryPrice = Number(entryPrice) > 0 ? Number(entryPrice) : rec.entryPrice || null;
    rec.stopPrice = Number(stopPrice) > 0 ? Number(stopPrice) : rec.stopPrice || null;
    rec.stopPct = Number.isFinite(Number(stopPct)) ? Number(stopPct) : rec.stopPct ?? null;
    rec.trailingPct = Number.isFinite(Number(trailingPct)) ? Number(trailingPct) : rec.trailingPct ?? null;
    this.live.set(mint, rec);

    this.diag[mint] = this.diag[mint] || {};
    this.diag[mint].fillAtMs = Date.now();

    this.subscribe(mint);
  }

  onWsEvent(mint, { price, ts, volume } = {}) {
    if (!mint) return;
    const now = Number(ts) || Date.now();
    const px = Number(price);
    if (!(px > 0)) return;

    const rec = this.live.get(mint) || {};
    rec.lastPrice = px;
    rec.lastTs = now;
    if (volume != null) rec.lastVolume = volume;
    this.live.set(mint, rec);

    this.diag[mint] = this.diag[mint] || {};
    this.diag[mint].last_ws_ts = now;
    this.diag[mint].last_ws_price = px;

    this.emit('tick', { mint, price: px, ts: now, volume });

    if (rec.stopPrice && px <= rec.stopPrice) {
      this.emit('exit', {
        mint,
        price: px,
        reason: { rule: 'stop' },
        chunked: true,
      });
    }
  }

  async restResync() {
    if (!this.restClient?.fetchSnapshot) return;
    const mints = Array.from(this.live.keys());
    for (const mint of mints) {
      try {
        const snap = await this.restClient.fetchSnapshot(mint);
        const px = Number(snap?.priceUsd || snap?.price || 0);
        if (px > 0) this.onWsEvent(mint, { price: px, ts: Date.now() });
      } catch {}
    }
  }
}

export default new WsSubscriptionManager();
