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
    this._lastSubSig = '';
    this._lastSubSentAtMs = 0;
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
        // resubscribe desired set as one complex subscription per message type
        this._lastSubSig = '';
        this._syncSubscriptions();
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
        chartType: '1s',
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
    const desiredRaw = entries.map(([k]) => String(k).replace(/^birdeye:sub:/, '')).filter(Boolean);
    const desired = new Set(desiredRaw.slice(0, 100));
    this.desired = desired;

    // BirdEye WS keeps one active subscription per message type.
    // Use complex queries that include the full desired set instead of per-mint simple messages.
    const desiredArr = Array.from(desired).sort();
    this.subscribed = new Set(desiredArr);
    const sig = desiredArr.join(',');
    const nowMs = Date.now();
    const changed = sig !== this._lastSubSig;
    const minResubMs = 2500;
    if (!changed && (nowMs - this._lastSubSentAtMs) < minResubMs) return;

    if (!this.ws || this.status !== 'OPEN') return;

    if (!desiredArr.length) {
      this._send({ type: 'UNSUBSCRIBE_PRICE' });
      this._send({ type: 'UNSUBSCRIBE_TXS' });
      this.subscribed = new Set();
      this._lastSubSig = sig;
      this._lastSubSentAtMs = nowMs;
      return;
    }

    const priceQuery = desiredArr
      .map((m) => `(address = ${m} AND chartType = 1s AND currency = usd)`)
      .join(' OR ');
    const txQuery = desiredArr
      .map((m) => `address = ${m}`)
      .join(' OR ');

    this._send({
      type: 'SUBSCRIBE_PRICE',
      data: {
        queryType: 'complex',
        query: priceQuery,
      },
    });
    this._send({
      type: 'SUBSCRIBE_TXS',
      data: {
        queryType: 'complex',
        query: txQuery,
        txsType: 'swap',
      },
    });

    this.subscribed = new Set(desiredArr);
    this._lastSubSig = sig;
    this._lastSubSentAtMs = nowMs;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw || '{}')); } catch { return; }
    const type = String(msg?.type || '');
    const d = msg?.data || {};
    const preferredCandidates = [
      String(d?.tokenAddress || '').trim(),
      String(d?.address || '').trim(),
      String(d?.from?.address || '').trim(),
      String(d?.to?.address || '').trim(),
    ].filter(Boolean);
    let mint = preferredCandidates.find((m) => this.desired.has(m)) || preferredCandidates[0] || '';
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
      const tsMs = Number(d?.blockUnixTime || 0) > 0 ? (Number(d.blockUnixTime) * 1000) : Date.now();
      const side = String(d?.side || '').toLowerCase();

      // Normalize trade-derived price into token USD semantics.
      // Prefer tokenPrice for simple token subscriptions; avoid pricePair (can represent pair ratio semantics).
      const tokenAddress = String(d?.tokenAddress || '').trim();
      const fromAddress = String(d?.from?.address || '').trim();
      const toAddress = String(d?.to?.address || '').trim();
      const tokenPrice = Number(d?.tokenPrice);
      const fromPrice = Number(d?.from?.price);
      const toPrice = Number(d?.to?.price);
      const fromNearest = Number(d?.from?.nearestPrice);
      const toNearest = Number(d?.to?.nearestPrice);

      let priceUsd = null;
      if (Number.isFinite(tokenPrice) && tokenPrice > 0) {
        priceUsd = tokenPrice;
      } else if (tokenAddress && fromAddress && tokenAddress === fromAddress) {
        if (Number.isFinite(fromPrice) && fromPrice > 0) priceUsd = fromPrice;
        else if (Number.isFinite(fromNearest) && fromNearest > 0) priceUsd = fromNearest;
      } else if (tokenAddress && toAddress && tokenAddress === toAddress) {
        if (Number.isFinite(toPrice) && toPrice > 0) priceUsd = toPrice;
        else if (Number.isFinite(toNearest) && toNearest > 0) priceUsd = toNearest;
      } else {
        // Last-resort fallback when tokenAddress missing/ambiguous.
        const generic = [fromPrice, toPrice, fromNearest, toNearest].find((x) => Number.isFinite(x) && x > 0);
        priceUsd = Number.isFinite(generic) ? generic : null;
      }

      arr.push({
        t: tsMs,
        side,
        priceUsd,
        txHash: String(d?.txHash || ''),
        volumeUSD: Number.isFinite(Number(d?.volumeUSD)) ? Number(d.volumeUSD) : null,
      });
      const cutoff = Date.now() - (65 * 60 * 1000);
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
      subscriptionMode: 'complex_bulk',
      lastSubSentAtMs: this._lastSubSentAtMs || 0,
      url: WS_URL,
    };
  }
}

const singleton = new BirdEyeWS();
export default singleton;
