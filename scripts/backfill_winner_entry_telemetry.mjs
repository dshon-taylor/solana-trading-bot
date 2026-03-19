#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { createBirdseyeLiteClient } from '../src/birdeye_lite.mjs';

const ROOT = process.cwd();
const TRADES = path.join(ROOT, 'state', 'trades.jsonl');
const TRADING_MD = path.join(ROOT, 'trading.md');

const LOOKBACK_HOURS = Number(process.argv[2] || 72);
const fromMs = Date.now() - LOOKBACK_HOURS * 3600 * 1000;

function num(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function parseMdBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(/^##\s+(ENTRY|EXIT)\s+(.+?)\s+\(([^)]+)\)/);
    if (h) {
      if (cur) blocks.push(cur);
      cur = { kind: h[1].toLowerCase(), label: h[2], mint: h[3] };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^-\s*([^:]+):\s*(.*)$/);
    if (kv) cur[kv[1].trim()] = kv[2].trim();
  }
  if (cur) blocks.push(cur);
  return blocks;
}

function buildEntryByExitTx(blocks) {
  const q = new Map();
  const out = new Map();
  for (const b of blocks) {
    if (b.kind === 'entry') {
      if (!q.has(b.mint)) q.set(b.mint, []);
      q.get(b.mint).push(b);
    } else if (b.kind === 'exit') {
      const arr = q.get(b.mint) || [];
      const entry = arr.length ? arr.shift() : null;
      const tx = String(b.tx || '').trim();
      if (tx && entry) out.set(tx, entry);
    }
  }
  return out;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const rows = readJsonl(TRADES);
const blocks = parseMdBlocks(fs.readFileSync(TRADING_MD, 'utf8'));
const entryByExitTx = buildEntryByExitTx(blocks);

const birdeye = createBirdseyeLiteClient({
  enabled: true,
  apiKey: process.env.BIRDEYE_API_KEY || '',
  chain: 'solana',
  maxRps: 8,
  retries: 1,
  cacheTtlMs: 1,
  perMintMinIntervalMs: 1,
});

let scanned = 0;
let patched = 0;
let birdeyeEnriched = 0;
for (const r of rows) {
  if (String(r.kind || '') !== 'exit') continue;
  const tMs = Date.parse(r.time || r.exitAt || '');
  if (!Number.isFinite(tMs) || tMs < fromMs) continue;
  const pnl = num(r.pnlUsdNetApprox ?? r.pnlUsdApprox);
  if (!(pnl > 0)) continue;

  scanned += 1;
  const needs = (
    r.liquidityUsdAtEntry == null ||
    r.mcapUsdAtEntry == null ||
    r.signalTx1h == null ||
    r.signalBuyDominance == null
  );
  if (!needs) continue;

  const entry = entryByExitTx.get(String(r.exitTx || '').trim());
  if (entry) {
    let sig = {};
    try { sig = JSON.parse(entry.signal || '{}'); } catch {}
    const buys = num(sig.buys1h);
    const sells = num(sig.sells1h);
    const buyDom = num(sig.buyDominance) ?? ((buys != null && sells != null && (buys + sells) > 0) ? (buys / (buys + sells)) : null);
    r.entryAt = r.entryAt || entry.time || null;
    r.entryTx = r.entryTx || entry.tx || null;
    r.entryPriceUsd = r.entryPriceUsd ?? num(entry.tokenPriceUsd) ?? null;
    r.liquidityUsdAtEntry = num(entry.liquidityUsd) ?? r.liquidityUsdAtEntry ?? null;
    r.mcapUsdAtEntry = num(entry.mcapUsd) ?? r.mcapUsdAtEntry ?? null;
    r.signalTx1h = num(sig.tx1h) ?? r.signalTx1h ?? null;
    r.signalBuyDominance = buyDom ?? r.signalBuyDominance ?? null;
    r.entrySignalRaw = (entry.signal && entry.signal.length < 5000) ? entry.signal : (r.entrySignalRaw || null);
    r.telemetryBackfilledAt = new Date().toISOString();
    r.telemetryBackfillSource = 'trading_md_entry_pair';
    patched += 1;
  }

  try {
    const entry = entryByExitTx.get(String(r.exitTx || '').trim());
    const entryAtMs = Date.parse(entry?.time || r.entryAt || '');

    let snapAt = null;
    if (Number.isFinite(entryAtMs) && typeof birdeye.getTokenSnapshotAt === 'function') {
      snapAt = await birdeye.getTokenSnapshotAt(r.mint, entryAtMs, { toleranceSec: 180 });
    }
    const snapNow = await birdeye.getTokenSnapshot(r.mint);

    const holdersAt = num(snapAt?.participation?.holders ?? snapAt?.raw?.holders ?? snapAt?.raw?.holderCount);
    const uniqueBuyersAt = num(snapAt?.participation?.uniqueBuyers ?? snapAt?.raw?.uniqueWallet24hBuy ?? snapAt?.raw?.uniqueBuyers);
    const liqAt = num(snapAt?.liquidityUsd ?? snapAt?.raw?.liquidity ?? snapAt?.raw?.liquidityUsd);
    const pxAt = num(snapAt?.priceUsd ?? snapAt?.raw?.price ?? snapAt?.raw?.value);

    if (holdersAt != null || uniqueBuyersAt != null || liqAt != null || pxAt != null) {
      if (r.holdersAtEntry == null && holdersAt != null) r.holdersAtEntry = holdersAt;
      if (r.uniqueBuyersAtEntry == null && uniqueBuyersAt != null) r.uniqueBuyersAtEntry = uniqueBuyersAt;
      if (r.liquidityUsdAtEntry == null && liqAt != null) r.liquidityUsdAtEntry = liqAt;
      if (r.entryPriceUsd == null && pxAt != null) r.entryPriceUsd = pxAt;
      r.birdeyeAtEntryObservedAt = new Date().toISOString();
      r.birdeyeAtEntryEndpoint = snapAt?.endpoint || null;
      birdeyeEnriched += 1;
    }

    const holdersNow = num(snapNow?.raw?.holders ?? snapNow?.raw?.holder ?? snapNow?.raw?.holderCount);
    const uniqueBuyersNow = num(snapNow?.raw?.uniqueWallet24hBuy ?? snapNow?.raw?.uniqueBuyers);
    if (holdersNow != null || uniqueBuyersNow != null) {
      r.birdeyeNowHolders = holdersNow;
      r.birdeyeNowUniqueBuyers = uniqueBuyersNow;
      r.birdeyeNowObservedAt = new Date().toISOString();
    }
  } catch {}
}

fs.writeFileSync(TRADES, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

console.log(JSON.stringify({ ok: true, lookbackHours: LOOKBACK_HOURS, winnerRowsScanned: scanned, patchedFromEntry: patched, birdeyeNowEnriched: birdeyeEnriched, file: TRADES }, null, 2));
