export function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function splitForTelegram(text, maxLen = 3500) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}
