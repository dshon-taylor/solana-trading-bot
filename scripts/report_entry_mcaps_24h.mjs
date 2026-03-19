import fs from 'node:fs';

const STATE_PATH = './state/state.json';
const OUT_PATH = './analysis/entry_mcaps_last24h.json';

const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
const since = Date.now() - 24 * 60 * 60 * 1000;

const rows = Object.values(state.positions || {})
  .map((p) => ({
    mint: p?.mint || null,
    symbol: p?.symbol || null,
    entryAt: p?.entryAt || null,
    mcapUsdAtEntry: (p?.mcapUsdAtEntry != null && Number.isFinite(Number(p.mcapUsdAtEntry))) ? Number(p.mcapUsdAtEntry) : null,
    liquidityUsdAtEntry: (p?.liquidityUsdAtEntry != null && Number.isFinite(Number(p.liquidityUsdAtEntry))) ? Number(p.liquidityUsdAtEntry) : null,
    status: p?.status || null,
    entryTx: p?.entryTx || null,
  }))
  .filter((r) => r.entryAt && Date.parse(r.entryAt) >= since)
  .sort((a, b) => Date.parse(a.entryAt) - Date.parse(b.entryAt));

const withMcap = rows.filter((r) => r.mcapUsdAtEntry != null).length;
const out = {
  generatedAt: new Date().toISOString(),
  windowStart: new Date(since).toISOString(),
  totalEntriesLast24h: rows.length,
  withMcap,
  missingMcap: rows.length - withMcap,
  rows,
};

fs.mkdirSync('./analysis', { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: true, outPath: OUT_PATH, total: out.totalEntriesLast24h, withMcap, missingMcap: out.missingMcap }));
