#!/usr/bin/env node
import fs from 'node:fs';

function parseArgs(argv) {
  const args = { file: './state/paper_live_attempts.jsonl', tail: 25, sinceHours: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--tail') args.tail = Number(argv[++i]);
    else if (a === '--since-hours') args.sinceHours = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: paper_live_attempts_summary.mjs [--file <path>] [--tail N] [--since-hours H] [--json]',
        '',
        'Summarizes the durable paper->live decision ledger written to JSONL.',
        'This helps audit how many paper entry signals would/should have gone live, and why they did not.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function pct(n, d) {
  if (!d) return '0.0%';
  return `${((n / d) * 100).toFixed(1)}%`;
}

const args = parseArgs(process.argv);
const fp = args.file;

if (!fs.existsSync(fp)) {
  console.error(`[summary] missing file: ${fp}`);
  process.exit(2);
}

const raw = fs.readFileSync(fp, 'utf8').trim();
if (!raw) {
  console.log('[summary] empty');
  process.exit(0);
}

const lines = raw.split(/\r?\n/).filter(Boolean);
let events = lines.map(safeJsonParse).filter(Boolean);

const now = Date.now();
if (Number.isFinite(args.sinceHours) && args.sinceHours > 0) {
  const cutoff = now - args.sinceHours * 60 * 60_000;
  events = events.filter(e => {
    const t = e?.t ? Date.parse(e.t) : null;
    return t && t >= cutoff;
  });
}

// We write 2 rows per attempt (stage=signal + stage=decision). Dedup by (t,mint,kind) for signal counts.
const key = (e) => `${e?.t || ''}|${e?.mint || ''}|${e?.kind || ''}`;

const signals = new Map();
const decisions = new Map();

for (const e of events) {
  if (e.stage === 'signal') signals.set(key(e), e);
  if (e.stage === 'decision') decisions.set(key(e), e);
}

const signalList = Array.from(signals.values()).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
const decisionList = Array.from(decisions.values()).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

let attempted = 0;
let okSubmitted = 0;
let skipped = 0;

const reasonCounts = new Map();

for (const d of decisionList) {
  if (d.attempted) attempted += 1;
  if (d.reason && String(d.reason).startsWith('ok:')) okSubmitted += 1;
  if (d.reason && String(d.reason).startsWith('skip:')) skipped += 1;
  if (d.reason) reasonCounts.set(d.reason, (reasonCounts.get(d.reason) || 0) + 1);
}

const topReasons = Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

const out = {
  file: fp,
  window: {
    sinceHours: args.sinceHours,
    events: events.length,
    signals: signalList.length,
    decisions: decisionList.length,
  },
  conversion: {
    attempted,
    okSubmitted,
    skipped,
    attemptedOfSignals: signalList.length ? attempted / signalList.length : 0,
    okOfAttempted: attempted ? okSubmitted / attempted : 0,
  },
  topReasons,
  recent: decisionList.slice(-args.tail),
};

if (args.json) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log([
  'paper->live attempts summary',
  `• file: ${fp}`,
  args.sinceHours ? `• window: last ${args.sinceHours}h` : '• window: all',
  `• signals: ${signalList.length}  decisions: ${decisionList.length}`,
  `• attempted: ${attempted} (${pct(attempted, signalList.length)} of signals)` ,
  `• ok:swap_submitted: ${okSubmitted} (${pct(okSubmitted, attempted)} of attempted)`,
  `• skipped: ${skipped}`,
  '',
  'top reasons:',
  ...topReasons.map(([r, n]) => `• ${n}  ${r}`),
  '',
  `recent decisions (tail ${Math.min(args.tail, decisionList.length)}):`,
  ...decisionList.slice(-args.tail).map(d => {
    const sym = d.symbol || (d.mint ? d.mint.slice(0, 6) + '…' : 'UNKNOWN');
    return `• ${d.t}  ${sym}  attempted=${!!d.attempted}  liveEnabled=${!!d.liveEnabled}  tradingEnabled=${!!d.tradingEnabled}  reason=${d.reason || 'n/a'}  sig=${d.signature || 'n/a'}`;
  }),
].join('\n'));
