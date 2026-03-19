const store = new Map();

function now() { return Date.now(); }

export function set(key, value, ttlS = 0) {
  const expires = ttlS && ttlS > 0 ? now() + (ttlS * 1000) : null;
  store.set(String(key), { v: value, expires });
}

export function get(key) {
  const r = store.get(String(key));
  if (!r) return undefined;
  if (r.expires && r.expires < now()) { store.delete(String(key)); return undefined; }
  return r.v;
}

export function del(key) {
  store.delete(String(key));
}

export function keys(prefix = '') {
  const p = String(prefix || '');
  const out = [];
  for (const k of store.keys()) {
    const r = store.get(k);
    if (r?.expires && r.expires < now()) { store.delete(k); continue; }
    if (!p || k.startsWith(p)) out.push(k);
  }
  return out;
}

export function entries(prefix = '') {
  const p = String(prefix || '');
  const out = [];
  for (const [k, r] of store.entries()) {
    if (r?.expires && r.expires < now()) { store.delete(k); continue; }
    if (!p || k.startsWith(p)) out.push([k, r.v]);
  }
  return out;
}

export function size() {
  // prune expired
  for (const [k, r] of store.entries()) {
    if (r?.expires && r.expires < now()) store.delete(k);
  }
  return store.size;
}

export default { set, get, del, keys, entries, size };
