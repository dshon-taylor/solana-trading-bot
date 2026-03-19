const cache = new Map();

export function memoizeTTL(fn, ttlMs = 15000) {
  return async function(key) {
    const now = Date.now();
    const rec = cache.get(key);
    if (rec && (now - rec.t) < ttlMs) return rec.v;
    const v = await fn(key);
    cache.set(key, { v, t: now });
    return v;
  };
}

// Simple token-bucket limiter keyed by name
const buckets = new Map();
export function tokenBucket(name, capacity = 5, refillMs = 1000) {
  if (!buckets.has(name)) {
    buckets.set(name, { tokens: capacity, last: Date.now(), capacity, refillMs });
  }
  return {
    tryTake() {
      const b = buckets.get(name);
      const now = Date.now();
      const delta = now - b.last;
      if (delta > 0) {
        const refill = Math.floor(delta / b.refillMs);
        if (refill > 0) {
          b.tokens = Math.min(b.capacity, b.tokens + refill);
          b.last = now;
        }
      }
      if (b.tokens > 0) {
        b.tokens -= 1;
        return true;
      }
      return false;
    }
  };
}

export function clearCache() { cache.clear(); }
