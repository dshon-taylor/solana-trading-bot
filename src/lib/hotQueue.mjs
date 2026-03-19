import EventEmitter from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let Redis = null;
try {
  Redis = require('ioredis');
} catch (e) {
  // optional dependency not installed; continue without Redis
  Redis = null;
}

// Simple HOT queue manager with in-memory priority queue + optional Redis backing for persistence.
// Exported API used by scanner/watchlist (enqueue/dequeue/peek/metrics).

export default class HotQueue extends EventEmitter {
  constructor({ redisUrl = process.env.REDIS_URL, profile = 'default' } = {}) {
    super();
    this.profile = profile;
    this.map = new Map(); // mint -> item
    this.pq = []; // sorted by score desc
    this.metrics = { enqueueRate: 0, promotionsMin: 0 };
    this.limitPerMin = Number(process.env.HOT_LIMIT_PER_MIN || 120);
    this.topN = Number(process.env.TOP_N_HOT || 5);
    this.hotTtlMs = Number(process.env.HOT_TTL_MS || 300000);
    this.sampleWindow = new Map(); // minute bucket -> count per mint

    if (redisUrl && Redis) {
      this.redis = new Redis(redisUrl);
      this._redisKey = `hotQueue:${this.profile}`;
    }
  }

  _now() { return Date.now(); }

  enqueue(mint, score = 1, meta = {}) {
    const now = this._now();
    const item = { mint, score, meta, enqueuedAt: now, expireAt: now + this.hotTtlMs };
    const existing = this.map.get(mint);
    if (existing) {
      // replace if higher score
      if (score <= existing.score) return false;
      this._removeFromPQ(mint);
    }
    this.map.set(mint, item);
    this._insertPQ(item);
    this.metrics.enqueueRate += 1;
    this.emit('enqueue', item);
    if (this.redis) this.redis.hset(this._redisKey, mint, JSON.stringify(item)).catch(()=>{});
    return true;
  }

  _insertPQ(item) {
    this.pq.push(item);
    this.pq.sort((a,b)=>b.score - a.score);
  }

  _removeFromPQ(mint) {
    const idx = this.pq.findIndex(p=>p.mint===mint);
    if (idx>=0) this.pq.splice(idx,1);
  }

  dequeueTop(n=this.topN) {
    this._expireStale();
    const out = this.pq.slice(0,n).map(i=>i.mint);
    return out;
  }

  pop(mint) {
    const it = this.map.get(mint);
    if (!it) return null;
    this.map.delete(mint);
    this._removeFromPQ(mint);
    if (this.redis) this.redis.hdel(this._redisKey, mint).catch(()=>{});
    return it;
  }

  _expireStale() {
    const now = this._now();
    const toRemove = [];
    for (const [mint,item] of this.map.entries()) {
      if (item.expireAt <= now) toRemove.push(mint);
    }
    for (const m of toRemove) {
      this.map.delete(m);
      this._removeFromPQ(m);
      this.emit('ttlExpired', m);
      if (this.redis) this.redis.hdel(this._redisKey, m).catch(()=>{});
    }
  }

  size() { this._expireStale(); return this.pq.length; }

  promoteEligible(nowMs=this._now()) {
    // Apply limitPerMin enforcement and fair scheduling.
    // Count how many promotions happened in current minute
    const minute = Math.floor(nowMs/60000);
    const counts = this.sampleWindow.get(minute) || { total:0, perMint: new Map() };
    const out = [];
    for (const item of this.pq) {
      if (out.length >= this.topN) break;
      const c = counts.total || 0;
      if (c >= this.limitPerMin) break;
      const per = counts.perMint.get(item.mint) || 0;
      // fair: avoid promoting same mint > 1 per minute
      if (per > 0) continue;
      out.push(item.mint);
      counts.total = (counts.total||0) + 1;
      counts.perMint.set(item.mint, (per)+1);
    }
    this.sampleWindow.set(minute, counts);
    this.metrics.promotionsMin += out.length;
    return out;
  }

  metricsSnapshot() {
    return {
      size: this.size(),
      enqueueRate: this.metrics.enqueueRate,
      promotionsMin: this.metrics.promotionsMin,
    };
  }
}
