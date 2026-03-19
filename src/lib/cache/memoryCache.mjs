// Simple in-memory LRU cache (small stub)
import LRU from 'lru-cache';
const cache = new LRU({max: 1000, ttl: parseInt(process.env.BIRDEYE_LITE_CACHE_TTL_MS||'45000')});
export function get(key){ return cache.get(key); }
export function set(key,val){ cache.set(key,val); }
export default cache;
