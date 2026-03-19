import EventEmitter from 'events';
import cache from '../global_cache.mjs';

const WS_URL = process.env.BIRDEYE_WS_URL || 'wss://public-api.birdeye.so/socket/solana';
const API_KEY = process.env.BIRDEYE_API_KEY || '';
const ENABLED = (process.env.BIRDEYE_WS_ENABLED || 'true') === 'true' && !!API_KEY;
const POLL_MS = Math.max(250, Number(process.env.BIRDEYE_SUB_POLL_MS || 750));

class BirdEyeWS extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.status = 'CLOSED';
    this.backoffMs = 1000;
    this.maxBackoffMs = 30000;
    this.subscribed = new Set();
    this.desired = new Set();
    this._timer = null;
  }

  url() {
    const sep = WS_URL.includes('?') ? '&' : '?';
    return `${WS_URL}${sep}x-api-key=${encodeURIComponent(API_KEY)}`;
  }

  connect() {
    if (!ENABLED || this.ws || this.status === 'OPEN' || this.status === 'CONNECTING') return;
    this.status = 'CONNECTING';
    try {
      const ws = new globalThis.WebSocket(this.url(), 'echo-protocol');
      this.ws = ws;
      ws.onopen = () => {
        this.status = 'OPEN';
        this.backoffMs = 1000;
        this.emit('open');
        // resubscribe desired set
        for (const mint of this.desired) this._subscribeMint(mint);
      };
      ws.onmessage = (ev) => this._onMessage(ev?.data);
      ws.onerror = () => {
        this.emit('error', new Error('birdeye ws error'));
      };
      ws.onclose = () => {
        this.status = 'CLOSED';
        this.ws = null;
        this.subscribed.clear();
        this.emit('close');
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.maxBackoffMs, Math.floor(this.backoffMs * 1.8));
      };
    } catch (e) {
      this.status = 'CLOSED';
      this.ws = null;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.maxBackoffMs, Math.floor(this.backoffMs * 1.8));
    }
  }

  start() {
    if (!ENABLED) return;
    this.connect();
    if (this._timer) return;
    this._timer = setInterval(() => this._syncSubscriptions(), POLL_MS);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    try { this.ws?.close?.(); } catch {}
    this.ws = null;
    this.status = 'CLOSED';
  }

  _send(obj) {
    if (!this.ws || this.status !== 'OPEN') return;
    try { this.ws.send(JSON.stringify(obj)); } catch {}
  }

  _subscribeMint(mint) {
    if (!mint || this.subscribed.has(mint)) return;
    // price stream (1m ohlcv updates)
    this._send({
      type: 'SUBSCRIBE_PRICE',
      data: {
        queryType: 'simple',
        chartType: '1m',
        address: mint,
        currency: 'usd',
      },
    });
    // tx stream for buy/sell pressure
    this._send({
      type: 'SUBSCRIBE_TXS',
      data: {
        queryType: 'simple',
        address: mint,
        txsType: 'swap',
      },
    });
    this.subscribed.add(mint);
  }

  _unsubscribeMint(mint) {
    if (!mint || !this.subscribed.has(mint)) return;
    this._send({ type: 'UNSUBSCRIBE_PRICE', data: { address: mint } });
    this._send({ type: 'UNSUBSCRIBE_TXS', data: { address: mint } });
    this.subscribed.delete(mint);
  }

  _syncSubscriptions() {
    const entries = cache.entries('birdeye:sub:');
    const desired = new Set(entries.map(([k]) => String(k).replace(/^birdeye:sub:/, '')));
    this.desired = desired;
    for (const mint of desired) this._subscribeMint(mint);
    for (const mint of Array.from(this.subscribed)) {
      if (!desired.has(mint)) this._unsubscribeMint(mint);
    }
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw || '{}')); } catch { return; }
    const type = String(msg?.type || '');
    const d = msg?.data || {};
    const mint = String(d?.address || d?.tokenAddress || d?.from?.address || '').trim();
    if (!mint) return;

    if (type === 'PRICE_DATA') {
      const c = Number(d?.c || 0);
      const v = Number(d?.v || 0);
      const tsMs = Number(d?.unixTime || 0) > 0 ? Number(d.unixTime) * 1000 : Date.now();
      cache.set(`birdeye:ws:price:${mint}`, { priceUsd: c, volume1m: v, tsMs }, 60);

      // emit direct low-latency price event for consumers (manager)
      try { this.emit('price', { mint, price: Number(c), ts: tsMs, volume: Number(v) }); } catch (e) {}

      // maintain rolling window in cache
      const k = `birdeye:ws:series:${mint}`;
      const series = cache.get(k) || [];
      series.push({ t: tsMs, c, v });
      const cutoff = Date.now() - (35 * 60 * 1000);
      while (series.length && Number(series[0]?.t || 0) < cutoff) series.shift();
      cache.set(k, series, 3600);
    }

    if (type === 'TXS_DATA') {
      const k = `birdeye:ws:tx:${mint}`;
      const arr = cache.get(k) || [];
      const now = Date.now();
      const side = String(d?.side || '').toLowerCase();
      arr.push({ t: now, side });
      const cutoff = now - (65 * 60 * 1000);
      while (arr.length && Number(arr[0]?.t || 0) < cutoff) arr.shift();
      cache.set(k, arr, 3600);
    }
  }

  getStatus() {
    return {
      enabled: ENABLED,
      status: this.status,
      subscribedCount: this.subscribed.size,
      desiredCount: this.desired.size,
      url: WS_URL,
    };
  }
}

const singleton = new BirdEyeWS();
export default singleton;
