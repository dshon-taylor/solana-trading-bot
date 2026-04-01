export function h(title) {
  return `🕯️ ${title}`;
}

export function kv(label, value) {
  return `• ${label}: ${value}`;
}

export function moneyUsd(x) {
  return `$${Number(x).toFixed(2)}`;
}

export function num(x, d = 2) {
  return Number(x).toFixed(d);
}

export function chunkLines(lines, maxLines = 25) {
  const out = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    out.push(lines.slice(i, i + maxLines));
  }
  return out;
}
