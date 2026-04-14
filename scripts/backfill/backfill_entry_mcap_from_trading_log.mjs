import fs from 'node:fs';

const STATE_PATH = './state/state.json';
const LOG_PATH = fs.existsSync('./state/trading_log.md') ? './state/trading_log.md' : './trading.md';

function parseEntries(md) {
  const out = [];
  const re = /## ENTRY\s+(.+?)\s+\(([^)]+)\)\n([\s\S]*?)(?=\n##\s|$)/g;
  for (const m of md.matchAll(re)) {
    const body = m[3] || '';
    const time = (body.match(/- time:\s*(.+)/) || [])[1]?.trim() || null;
    const mcapRaw = (body.match(/- mcapUsd:\s*([^\n]+)/) || [])[1]?.trim() || null;
    const liqRaw = (body.match(/- liquidityUsd:\s*([^\n]+)/) || [])[1]?.trim() || null;
    const mcap = Number(mcapRaw);
    const liq = Number(liqRaw);
    out.push({
      mint: (m[2] || '').trim(),
      time,
      tMs: time ? Date.parse(time) : 0,
      mcapUsd: Number.isFinite(mcap) ? mcap : null,
      liquidityUsd: Number.isFinite(liq) ? liq : null,
    });
  }
  return out;
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const md = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
const entries = parseEntries(md);

let updated = 0;
for (const pos of Object.values(state.positions || {})) {
  const mint = String(pos?.mint || '');
  const entryMs = pos?.entryAt ? Date.parse(pos.entryAt) : 0;
  if (!mint || !entryMs) continue;
  if (pos.mcapUsdAtEntry != null && Number.isFinite(Number(pos.mcapUsdAtEntry))) continue;

  const matches = entries
    .filter(e => e.mint === mint && e.tMs > 0 && Math.abs(e.tMs - entryMs) <= 10 * 60_000)
    .sort((a, b) => Math.abs(a.tMs - entryMs) - Math.abs(b.tMs - entryMs));
  const hit = matches[0] || null;
  if (!hit) continue;

  if (hit.mcapUsd != null) pos.mcapUsdAtEntry = hit.mcapUsd;
  if (hit.liquidityUsd != null) pos.liquidityUsdAtEntry = hit.liquidityUsd;
  updated += 1;
}

fs.writeFileSync(STATE_PATH, JSON.stringify(state));
console.log(JSON.stringify({ ok: true, updated }));
