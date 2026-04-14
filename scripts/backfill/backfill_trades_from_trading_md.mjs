#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TRADING_MD_CANDIDATES = [
  path.join(ROOT, 'state', 'trading_log.md'),
  path.join(ROOT, 'trading.md'),
];
const TRADING_MD = TRADING_MD_CANDIDATES.find((p) => fs.existsSync(p)) || TRADING_MD_CANDIDATES[0];
const TRADES_JSONL = path.join(ROOT, 'state', 'trades.jsonl');

function parseBlocks(text) {
  const lines = text.split('\n');
  const rows = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    if (cur.kind === 'exit' && cur.exitTx && cur.mint) rows.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const head = line.match(/^##\s+(ENTRY|EXIT)\s+(.+?)\s+\(([^)]+)\)\s*$/);
    if (head) {
      flush();
      const kind = head[1].toLowerCase();
      const symbol = String(head[2] || '').trim();
      const mint = String(head[3] || '').trim();
      cur = { kind, symbol, mint };
      continue;
    }
    if (!cur) continue;

    const kv = line.match(/^-\s*([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].trim();

    if (k === 'time') {
      if (cur.kind === 'entry') cur.entryAt = v;
      else cur.exitAt = v;
      cur.time = v;
    } else if (k === 'reason') cur.exitReason = v;
    else if (k === 'tx') {
      if (cur.kind === 'entry') cur.entryTx = v;
      else cur.exitTx = v;
    } else if (k === 'entrytx') cur.entryTx = v;
    else if (k === 'exittx') cur.exitTx = v;
    else if (k === 'entrypriceusd') cur.entryPriceUsd = Number(v);
    else if (k === 'exitpriceusd') cur.exitPriceUsd = Number(v);
    else if (k === 'pnlpct') cur.pnlPct = Number(v);
    else if (k === 'pnlusdapprox') cur.pnlUsdApprox = Number(v);
    else if (k === 'pnlusdnetapprox') cur.pnlUsdNetApprox = Number(v);
    else if (k === 'sentsolapprox' || k === 'spentsolapprox') cur.spentSolApprox = Number(v);
    else if (k === 'solusd' || k === 'solusdatentry') cur.solUsdAtEntry = Number(v);
    else if (k === 'entrypricesource') cur.entryPriceSource = v;
    else if (k === 'exitpricesource') cur.exitPriceSource = v;
    else if (k === 'entryfeelamports') cur.entryFeeLamports = Number(v);
    else if (k === 'exitfeelamports') cur.exitFeeLamports = Number(v);
  }
  flush();
  return rows;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

if (!fs.existsSync(TRADING_MD)) {
  console.error(`missing trading log at ${TRADING_MD}`);
  process.exit(1);
}

const md = fs.readFileSync(TRADING_MD, 'utf8');
const parsed = parseBlocks(md);
const existing = readJsonl(TRADES_JSONL);
const existingByExitTx = new Set(existing.map(r => String(r?.exitTx || '').trim()).filter(Boolean));

const add = [];
for (const r of parsed) {
  const tx = String(r.exitTx || '').trim();
  if (!tx || existingByExitTx.has(tx)) continue;
  add.push({
    time: r.time || r.exitAt || null,
    kind: 'exit',
    mint: r.mint || null,
    symbol: r.symbol || null,
    entryAt: r.entryAt || null,
    exitAt: r.exitAt || r.time || null,
    entryTx: r.entryTx || null,
    exitTx: r.exitTx || null,
    spentSolApprox: Number.isFinite(Number(r.spentSolApprox)) ? Number(r.spentSolApprox) : null,
    solUsdAtEntry: Number.isFinite(Number(r.solUsdAtEntry)) ? Number(r.solUsdAtEntry) : null,
    entryPriceUsd: Number.isFinite(Number(r.entryPriceUsd)) ? Number(r.entryPriceUsd) : null,
    exitPriceUsd: Number.isFinite(Number(r.exitPriceUsd)) ? Number(r.exitPriceUsd) : null,
    entryPriceSource: r.entryPriceSource || null,
    exitPriceSource: r.exitPriceSource || null,
    entryFeeLamports: Number.isFinite(Number(r.entryFeeLamports)) ? Number(r.entryFeeLamports) : null,
    exitFeeLamports: Number.isFinite(Number(r.exitFeeLamports)) ? Number(r.exitFeeLamports) : null,
    pnlPct: Number.isFinite(Number(r.pnlPct)) ? Number(r.pnlPct) : null,
    pnlUsdApprox: Number.isFinite(Number(r.pnlUsdApprox)) ? Number(r.pnlUsdApprox) : null,
    pnlUsdNetApprox: Number.isFinite(Number(r.pnlUsdNetApprox)) ? Number(r.pnlUsdNetApprox) : null,
    exitReason: r.exitReason || null,
    source: 'trading_md_backfill',
  });
}

if (add.length) {
  fs.mkdirSync(path.dirname(TRADES_JSONL), { recursive: true });
  const payload = add.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(TRADES_JSONL, payload);
}

console.log(JSON.stringify({
  ok: true,
  parsed: parsed.length,
  existing: existing.length,
  added: add.length,
  out: TRADES_JSONL,
}, null, 2));
