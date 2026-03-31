export function cleanTokenText(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined' || low === 'n/a') return '';
  return s;
}

export function tokenDisplayName({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  if (n) return n;
  const s = cleanTokenText(symbol);
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

export function tokenDisplayWithSymbol({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  const s = cleanTokenText(symbol);
  if (n && s) return `${n} (${s})`;
  if (n) return n;
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}
