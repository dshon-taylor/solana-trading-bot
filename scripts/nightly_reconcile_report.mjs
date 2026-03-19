#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const BOT_ROOT = path.resolve(SCRIPT_DIR, '..');
const STATE_DIR = path.join(BOT_ROOT, 'state');
const ROOT = BOT_ROOT;
const TRADES = path.join(STATE_DIR, 'trades.jsonl');
const PAPER = path.join(STATE_DIR, 'paper_trades.jsonl');
const OUT_DIR = path.join(STATE_DIR, 'reports');

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function toTs(row) {
  const t = row?.time || row?.exitAt || row?.entryAt || row?.t;
  const ms = Date.parse(t || '');
  return Number.isFinite(ms) ? ms : null;
}

function sum(nums) { return nums.reduce((a,b)=>a+(Number(b)||0),0); }

function summarize(rows, nowMs, winMs) {
  const from = nowMs - winMs;
  const inWin = rows.filter(r => {
    const ts = toTs(r);
    return ts != null && ts >= from && ts <= nowMs;
  });

  const exits = inWin.filter(r => String(r.kind || '').toLowerCase() === 'exit');
  const blocked = inWin.filter(r => String(r.kind || '').toLowerCase() === 'blocked');
  const pnlGross = sum(exits.map(r => r.pnlUsdApprox));
  const pnlNet = sum(exits.map(r => (r.pnlUsdNetApprox ?? r.pnlUsdApprox ?? 0)));

  return {
    rows: inWin.length,
    exits: exits.length,
    blocked: blocked.length,
    pnlGrossUsd: Number(pnlGross.toFixed(6)),
    pnlNetUsd: Number(pnlNet.toFixed(6)),
    winRate: exits.length ? Number((exits.filter(r => Number(r.pnlPct || 0) > 0).length / exits.length).toFixed(4)) : null,
    biggestWinUsd: exits.length ? Math.max(...exits.map(r => Number(r.pnlUsdApprox || 0))) : null,
    biggestLossUsd: exits.length ? Math.min(...exits.map(r => Number(r.pnlUsdApprox || 0))) : null,
  };
}

const nowMs = Date.now();
const trades = readJsonl(TRADES);
const paper = readJsonl(PAPER);

const report = {
  generatedAt: new Date(nowMs).toISOString(),
  sources: {
    trades: path.relative(ROOT, TRADES),
    paper: path.relative(ROOT, PAPER),
  },
  counts: {
    tradesRows: trades.length,
    paperRows: paper.length,
  },
  windows: {
    last24h: summarize(trades, nowMs, 24 * 60 * 60_000),
    last7d: summarize(trades, nowMs, 7 * 24 * 60 * 60_000),
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
const outJson = path.join(OUT_DIR, `nightly_reconcile_${ts}.json`);
const latest = path.join(OUT_DIR, 'nightly_reconcile_latest.json');
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
fs.writeFileSync(latest, JSON.stringify(report, null, 2));

const line = [
  report.generatedAt,
  report.windows.last24h.rows,
  report.windows.last24h.exits,
  report.windows.last24h.blocked,
  report.windows.last24h.pnlGrossUsd,
  report.windows.last24h.pnlNetUsd,
  report.windows.last7d.rows,
  report.windows.last7d.exits,
  report.windows.last7d.blocked,
  report.windows.last7d.pnlGrossUsd,
  report.windows.last7d.pnlNetUsd,
].join(',');
const csv = path.join(OUT_DIR, 'nightly_reconcile_history.csv');
if (!fs.existsSync(csv)) {
  fs.writeFileSync(csv, 'generatedAt,last24hRows,last24hExits,last24hBlocked,last24hPnlGrossUsd,last24hPnlNetUsd,last7dRows,last7dExits,last7dBlocked,last7dPnlGrossUsd,last7dPnlNetUsd\n');
}
fs.appendFileSync(csv, `${line}\n`);

console.log(JSON.stringify({ ok: true, outJson, latest, csv }, null, 2));
