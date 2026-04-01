const store = new Map();
let cleanupTimer = null;
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 60000; // Clean up expired entries every 60 seconds

function now() { return Date.now(); }

function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const currentTime = now();
    let removed = 0;
    for (const [key, record] of store.entries()) {
      if (record.expires && record.expires < currentTime) {
        store.delete(key);
        removed++;
      }
    }
    lastCleanup = currentTime;
    if (removed > 0) {
      console.log(`[global_cache] Cleaned up ${removed} expired entries`);
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function set(key, value, ttlS = 0) {
  const expires = ttlS && ttlS > 0 ? now() + (ttlS * 1000) : null;
  store.set(String(key), { v: value, expires });
  if (!cleanupTimer) scheduleCleanup();
}

export function get(key) {
  const r = store.get(String(key));
  if (!r) return undefined;
  // Lazy expiration check on read
  if (r.expires && r.expires < now()) {
    store.delete(String(key));
    return undefined;
  }
  return r.v;
}

export function del(key) {
  store.delete(String(key));
}

export function keys(prefix = '') {
  const p = String(prefix || '');
  const out = [];
  const currentTime = now();
  for (const k of store.keys()) {
    const r = store.get(k);
    if (r?.expires && r.expires < currentTime) continue; // Skip expired
    if (!p || k.startsWith(p)) out.push(k);
  }
  return out;
}

export function entries(prefix = '') {
  const p = String(prefix || '');
  const out = [];
  const currentTime = now();
  for (const [k, r] of store.entries()) {
    if (r?.expires && r.expires < currentTime) continue; // Skip expired
    if (!p || k.startsWith(p)) out.push([k, r.v]);
  }
  return out;
}

export function size() {
  return store.size;
}

export function stopCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export default { set, get, del, delete: del, keys, entries, size, stopCleanup };
