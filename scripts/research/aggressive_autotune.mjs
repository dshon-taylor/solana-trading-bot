#!/usr/bin/env node
/*
Short-horizon live autotune controller.

Goals:
- Push toward maximum entry count by loosening momentum thresholds and speeding rechecks.
- Avoid total failure states (rate limits / swap errors / cooldown spirals) by backing off one step.

This script is intentionally conservative in how much it changes per run:
- At most one "level" up/down per invocation.
- Always keeps values within known validation bounds (see src/config.mjs).

It edits ./.env (persisted config) and logs decisions to ./analysis/aggressive_autotune_log.md.

Usage:
  node scripts/research/aggressive_autotune.mjs            # dry-run
  node scripts/research/aggressive_autotune.mjs --apply   # write .env + state file
  node scripts/research/aggressive_autotune.mjs --apply --pm2-reload solana-momentum-bot

Exit codes:
  0 success
  2 missing required files
*/

import fs from 'node:fs';
import childProcess from 'node:child_process';

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = {
    apply: false,
    windowMin: 15,
    tail: 200,
    envFile: './.env',
    stateFile: './state/state.json',
    candidatesFile: null, // default: ./state/candidates/YYYY-MM-DD.jsonl
    logFile: './analysis/aggressive_autotune_log.md',
    controllerStateFile: './analysis/aggressive_autotune_state.json',
    pm2Reload: false,
    pm2Proc: 'solana-momentum-bot',
    printTelegram: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--window-min') args.windowMin = Number(argv[++i]);
    else if (a === '--tail') args.tail = Number(argv[++i]);
    else if (a === '--env') args.envFile = argv[++i];
    else if (a === '--state') args.stateFile = argv[++i];
    else if (a === '--candidates') args.candidatesFile = argv[++i];
    else if (a === '--log') args.logFile = argv[++i];
    else if (a === '--controller-state') args.controllerStateFile = argv[++i];
    else if (a === '--pm2-reload') {
      args.pm2Reload = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) args.pm2Proc = argv[++i];
    }
    else if (a === '--telegram' || a === '--print-telegram') args.printTelegram = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`[autotune] unknown arg: ${a}`);
      args.help = true;
    }
  }

  return args;
}

function usage() {
  return [
    'Usage: aggressive_autotune.mjs [--apply|--dry-run] [--window-min 15] [--tail 200] [--pm2-reload [procName]] [--print-telegram]',
    '',
    'Reads:',
    '  - state/state.json debug.last reject taxonomy (persisted by daemon)',
    '  - today\'s state/candidates/YYYY-MM-DD.jsonl (best-effort throughput proxy)',
    'Writes:',
    '  - analysis/aggressive_autotune_log.md',
    '  - analysis/aggressive_autotune_state.json (tracks current level)',
    'Optionally edits:',
    '  - .env (aggressive knobs)',
  ].join('\n');
}

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function fmtPct(x, digits = 0) {
  if (!Number.isFinite(x)) return '0%';
  return `${(x * 100).toFixed(digits)}%`;
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function ymdUtc(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseEnvFile(text) {
  const lines = text.split(/\r?\n/);
  const kv = new Map();
  const meta = []; // {type:'kv'|'other', key?, raw}

  for (const raw of lines) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || raw.trim().startsWith('#')) {
      meta.push({ type: 'other', raw });
      continue;
    }
    const key = m[1];
    const val = m[2];
    kv.set(key, val);
    meta.push({ type: 'kv', key, raw });
  }

  return { lines, kv, meta };
}

function renderEnv(meta, kv, updates) {
  const out = [];
  const seen = new Set();

  for (const row of meta) {
    if (row.type !== 'kv') {
      out.push(row.raw);
      continue;
    }
    const key = row.key;
    const nextVal = updates.has(key) ? updates.get(key) : kv.get(key);
    out.push(`${key}=${nextVal ?? ''}`);
    seen.add(key);
  }

  // Append new keys at end.
  for (const [k, v] of updates.entries()) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }

  // Preserve trailing newline.
  return out.join('\n').replace(/\n*$/, '\n');
}

function bucketReason(r) {
  const s = String(r || 'unknown');
  // candidate ledger reasons can be like: momentum(false)[strict], noPair(rateLimited)
  if (s.startsWith('noPair(')) {
    const inner = s.slice('noPair('.length).split(')')[0];
    return `noPair.${inner || 'unknown'}`;
  }
  if (s.startsWith('momentum')) return 'momentum';
  if (s.startsWith('swapError')) return 'swapError';
  if (s.startsWith('alreadyOpen')) return 'alreadyOpen';
  if (s.startsWith('lowSolFees')) return 'lowSolFees';
  if (s.startsWith('marketData(')) return 'marketData';
  if (s.startsWith('baseFilters(')) return 'baseFilters';
  if (s.startsWith('mcap(') || s.includes('mcap<')) return 'mcap';
  if (s.startsWith('liq<') || s.includes('liq=')) return 'liquidity';
  if (s.startsWith('rug')) return 'rug';
  return s.split('(')[0];
}

function countBy(items, f) {
  const m = new Map();
  for (const it of items) {
    const k = f(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function topN(map, n = 8) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function readJsonlTail(fp, maxLines = 2000) {
  if (!fs.existsSync(fp)) return [];
  const stat = fs.statSync(fp);
  if (!stat.size) return [];
  // Simple approach: read whole file if small; otherwise read tail-ish chunk.
  const maxBytes = 2 * 1024 * 1024; // 2MB
  const start = Math.max(0, stat.size - maxBytes);
  const buf = fs.readFileSync(fp);
  const text = buf.slice(start).toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map(safeJsonParse).filter(Boolean);
}

function withinWindowIso(tIso, windowMs, nowMs) {
  const t = Date.parse(tIso);
  if (!t) return false;
  return t >= (nowMs - windowMs) && t <= (nowMs + 5_000);
}

function loadControllerState(fp) {
  try {
    if (!fs.existsSync(fp)) return { level: 0, lastChangeAt: null };
    const j = readJson(fp);
    return {
      level: Number.isFinite(Number(j.level)) ? Number(j.level) : 0,
      lastChangeAt: j.lastChangeAt || null,
    };
  } catch {
    return { level: 0, lastChangeAt: null };
  }
}

function chooseNextLevel({ curLevel, signals }) {
  // signals: { attemptsNearZero, rateLimitBad, swapErrorBad }
  if (signals.rateLimitBad || signals.swapErrorBad) return Math.max(0, curLevel - 1);
  if (signals.attemptsNearZero) return Math.min(4, curLevel + 1);
  // otherwise keep
  return curLevel;
}

function profileForLevel(level) {
  // Hard caps/bounds aligned with src/config.mjs + index.mjs constants.
  // Level 0: baseline conservative (still "live conversion profile" enabled)
  // Level 4: very aggressive within known-safe bounds.
  const L = clamp(level, 0, 4);

  const profiles = [
    {
      level: 0,
      LIVE_PARALLEL_QUOTE_FANOUT_N: 1,
      LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 2,
      LIVE_REJECT_RECHECK_BURST_DELAY_MS: 180,
      NO_PAIR_RETRY_ATTEMPTS: 3,
      NO_PAIR_RETRY_BASE_MS: 300,
      NO_PAIR_TEMP_TTL_MS: 90_000,
      PAPER_ENTRY_RET_15M_PCT: 0.03,
      PAPER_ENTRY_RET_5M_PCT: 0.01,
      PAPER_ENTRY_GREEN_LAST5: 2,
      PAPER_ENTRY_COOLDOWN_MS: 180_000,
    },
    {
      level: 1,
      LIVE_PARALLEL_QUOTE_FANOUT_N: 2,
      LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 2,
      LIVE_REJECT_RECHECK_BURST_DELAY_MS: 140,
      NO_PAIR_RETRY_ATTEMPTS: 4,
      NO_PAIR_RETRY_BASE_MS: 275,
      NO_PAIR_TEMP_TTL_MS: 60_000,
      PAPER_ENTRY_RET_15M_PCT: 0.028,
      PAPER_ENTRY_RET_5M_PCT: 0.009,
      PAPER_ENTRY_GREEN_LAST5: 2,
      PAPER_ENTRY_COOLDOWN_MS: 150_000,
    },
    {
      level: 2,
      LIVE_PARALLEL_QUOTE_FANOUT_N: 3,
      LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 3,
      LIVE_REJECT_RECHECK_BURST_DELAY_MS: 120,
      NO_PAIR_RETRY_ATTEMPTS: 5,
      NO_PAIR_RETRY_BASE_MS: 250,
      NO_PAIR_TEMP_TTL_MS: 45_000,
      PAPER_ENTRY_RET_15M_PCT: 0.025,
      PAPER_ENTRY_RET_5M_PCT: 0.008,
      PAPER_ENTRY_GREEN_LAST5: 2,
      PAPER_ENTRY_COOLDOWN_MS: 120_000,
    },
    {
      level: 3,
      LIVE_PARALLEL_QUOTE_FANOUT_N: 4,
      LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 4,
      LIVE_REJECT_RECHECK_BURST_DELAY_MS: 110,
      NO_PAIR_RETRY_ATTEMPTS: 6,
      NO_PAIR_RETRY_BASE_MS: 225,
      NO_PAIR_TEMP_TTL_MS: 35_000,
      PAPER_ENTRY_RET_15M_PCT: 0.022,
      PAPER_ENTRY_RET_5M_PCT: 0.007,
      PAPER_ENTRY_GREEN_LAST5: 2,
      PAPER_ENTRY_COOLDOWN_MS: 90_000,
    },
    {
      level: 4,
      LIVE_PARALLEL_QUOTE_FANOUT_N: 5,
      LIVE_REJECT_RECHECK_BURST_ATTEMPTS: 5,
      LIVE_REJECT_RECHECK_BURST_DELAY_MS: 100,
      NO_PAIR_RETRY_ATTEMPTS: 6,
      NO_PAIR_RETRY_BASE_MS: 200,
      NO_PAIR_TEMP_TTL_MS: 30_000,
      PAPER_ENTRY_RET_15M_PCT: 0.020,
      PAPER_ENTRY_RET_5M_PCT: 0.006,
      PAPER_ENTRY_GREEN_LAST5: 2,
      PAPER_ENTRY_COOLDOWN_MS: 60_000,
    },
  ];

  return profiles[L];
}

function computeSignals({ recentRejectBuckets, candidatesWindow }) {
  const totalCandidates = candidatesWindow.length;
  const rejects = candidatesWindow.filter(e => e.outcome === 'reject');
  const rejectsByBucket = countBy(rejects, e => bucketReason(e.reason));

  const rateLimited = (recentRejectBuckets.get('noPair.rateLimited') || 0) + (rejectsByBucket.get('noPair.rateLimited') || 0);
  const swapError = (recentRejectBuckets.get('swapError') || 0) + (rejectsByBucket.get('swapError') || 0);

  // "Attempts" proxy: if we ever hit swapError, we are at least trying to submit.
  // Better: count outcomes that look like passed momentum? but we don't log attempt in candidates.
  // Use an "entry scarcity" heuristic: lots of evaluated candidates but near-zero non-momentum rejects indicates thresholds too tight.
  const momentumRejects = (recentRejectBuckets.get('momentum') || 0) + (rejectsByBucket.get('momentum') || 0);

  // Near-zero attempts: lots of evaluations but essentially all rejected at momentum gate.
  const attemptsNearZero = totalCandidates >= 40 && momentumRejects / Math.max(1, rejects.length) >= 0.70 && swapError === 0;

  // Excessive rate limiting: even modest candidate volume with significant rateLimited signals.
  const rateLimitBad = rateLimited >= 6;

  // Excessive swap errors: repeated failures indicates execution/Jup instability.
  const swapErrorBad = swapError >= 3;

  return {
    attemptsNearZero,
    rateLimitBad,
    swapErrorBad,
    rateLimited,
    swapError,
    momentumRejects,
    totalCandidates,
    totalRejects: rejects.length,
  };
}

function pm2Reload(procName) {
  try {
    childProcess.execSync(`pm2 reload ${procName}`, { stdio: 'inherit' });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e?.message || e) };
  }
}

function ensureDirFor(fp) {
  const dir = fp.split('/').slice(0, -1).join('/');
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  if (!Number.isFinite(args.windowMin) || args.windowMin <= 0) {
    console.error('[autotune] invalid --window-min');
    process.exit(2);
  }

  if (!fs.existsSync(args.envFile)) {
    console.error(`[autotune] missing env file: ${args.envFile}`);
    process.exit(2);
  }
  if (!fs.existsSync(args.stateFile)) {
    console.error(`[autotune] missing state file: ${args.stateFile}`);
    process.exit(2);
  }

  const nowMs = Date.now();
  const windowMs = args.windowMin * 60_000;

  const envText = fs.readFileSync(args.envFile, 'utf8');
  const { kv: envKv, meta: envMeta } = parseEnvFile(envText);

  const state = readJson(args.stateFile);
  const debugLast = Array.isArray(state?.debug?.last) ? state.debug.last.slice(-args.tail) : [];

  const recent = debugLast
    .filter(x => withinWindowIso(x?.t || x?.time || x?.ts || x?.at || x?.iso || x?.date, windowMs, nowMs) || true) // fallback: debug.last often lacks per-entry t; keep it
    .map(x => ({ reason: x?.reason || x?.event?.reason || x?.why || 'unknown' }));

  const recentBuckets = countBy(recent, x => bucketReason(x.reason));

  const candidatesFp = args.candidatesFile || `./state/candidates/${ymdUtc(new Date(nowMs))}.jsonl`;
  const candTail = readJsonlTail(candidatesFp, 4000);
  const candWindow = candTail.filter(e => withinWindowIso(e?.t || e?.time, windowMs, nowMs));

  const ctl = loadControllerState(args.controllerStateFile);

  const signals = computeSignals({ recentRejectBuckets: recentBuckets, candidatesWindow: candWindow });
  const nextLevel = chooseNextLevel({ curLevel: ctl.level, signals });

  const curProfile = profileForLevel(ctl.level);
  const nextProfile = profileForLevel(nextLevel);

  // Build updates by comparing env current -> desired profile. Only touch keys we own.
  const keys = [
    'LIVE_PARALLEL_QUOTE_FANOUT_N',
    'LIVE_REJECT_RECHECK_BURST_ATTEMPTS',
    'LIVE_REJECT_RECHECK_BURST_DELAY_MS',
    'NO_PAIR_RETRY_ATTEMPTS',
    'NO_PAIR_RETRY_BASE_MS',
    'NO_PAIR_TEMP_TTL_MS',
    'PAPER_ENTRY_RET_15M_PCT',
    'PAPER_ENTRY_RET_5M_PCT',
    'PAPER_ENTRY_GREEN_LAST5',
    'PAPER_ENTRY_COOLDOWN_MS',
  ];

  const updates = new Map();
  const changes = [];

  for (const k of keys) {
    const desired = nextProfile[k];
    if (desired === undefined) continue;

    // preserve formatting: numbers as is, floats trimmed.
    const desiredStr = String(desired);
    const curStr = envKv.get(k);
    if (curStr === undefined || String(curStr).trim() !== desiredStr) {
      updates.set(k, desiredStr);
      changes.push(`${k}: ${curStr ?? '(unset)'} -> ${desiredStr}`);
    }
  }

  // Respect global caps even if profile table has a bug.
  function capUpdate(k, v) {
    const n = Number(v);
    if (k === 'LIVE_PARALLEL_QUOTE_FANOUT_N') return String(clamp(n, 0, 6));
    if (k === 'LIVE_REJECT_RECHECK_BURST_ATTEMPTS') return String(Math.round(clamp(n, 1, 6)));
    if (k === 'LIVE_REJECT_RECHECK_BURST_DELAY_MS') return String(Math.round(clamp(n, 50, 2000)));
    if (k === 'NO_PAIR_RETRY_ATTEMPTS') return String(Math.round(clamp(n, 1, 10)));
    if (k === 'NO_PAIR_RETRY_BASE_MS') return String(Math.round(clamp(n, 50, 2000)));
    if (k === 'NO_PAIR_TEMP_TTL_MS') return String(Math.round(clamp(n, 5_000, 10 * 60_000)));
    if (k === 'PAPER_ENTRY_RET_15M_PCT' || k === 'PAPER_ENTRY_RET_5M_PCT') return String(clamp(n, 0, 2));
    if (k === 'PAPER_ENTRY_GREEN_LAST5') return String(Math.round(clamp(n, 0, 5)));
    if (k === 'PAPER_ENTRY_COOLDOWN_MS') return String(Math.round(clamp(n, 10_000, 120 * 60_000)));
    return String(v);
  }
  for (const [k, v] of updates.entries()) updates.set(k, capUpdate(k, v));

  const decision = {
    t: nowIso(),
    mode: args.apply ? 'apply' : 'dry-run',
    windowMin: args.windowMin,
    candidatesFile: candidatesFp,
    controller: {
      prevLevel: ctl.level,
      nextLevel,
    },
    signals,
    topRejects: topN(recentBuckets, 8),
    plannedChanges: changes,
  };

  // Write log (markdown)
  ensureDirFor(args.logFile);
  const logLines = [];
  logLines.push(`\n## ${decision.t} (${decision.mode})`);
  logLines.push('');
  logLines.push(`- window: last ${decision.windowMin}m`);
  logLines.push(`- level: ${decision.controller.prevLevel} -> ${decision.controller.nextLevel}`);
  logLines.push(`- candidates: ${decision.signals.totalCandidates} (rejects=${decision.signals.totalRejects})`);
  logLines.push(`- heuristics: attemptsNearZero=${decision.signals.attemptsNearZero} rateLimitBad=${decision.signals.rateLimitBad} swapErrorBad=${decision.signals.swapErrorBad}`);
  logLines.push(`- counts: rateLimited=${decision.signals.rateLimited} swapError=${decision.signals.swapError} momentumRejects=${decision.signals.momentumRejects}`);
  logLines.push('');
  logLines.push('Top reject buckets (state.debug.last + candidates tail best-effort):');
  if (decision.topRejects.length) {
    for (const [k, v] of decision.topRejects) logLines.push(`- ${mdEscape(k)}: ${v}`);
  } else {
    logLines.push('- (none)');
  }
  logLines.push('');
  logLines.push('Planned knob changes:');
  if (decision.plannedChanges.length) {
    for (const c of decision.plannedChanges) logLines.push(`- ${mdEscape(c)}`);
  } else {
    logLines.push('- (no changes)');
  }

  fs.appendFileSync(args.logFile, logLines.join('\n') + '\n');

  // Apply .env updates + controller state
  let reloadRes = null;
  if (args.apply) {
    if (updates.size) {
      const nextEnv = renderEnv(envMeta, envKv, updates);
      fs.writeFileSync(args.envFile, nextEnv);
    }
    ensureDirFor(args.controllerStateFile);
    fs.writeFileSync(args.controllerStateFile, JSON.stringify({ level: nextLevel, lastChangeAt: decision.t }, null, 2) + '\n');

    if (args.pm2Reload) {
      reloadRes = pm2Reload(args.pm2Proc);
    }
  }

  // Print a Telegram-ready summary (do not send).
  const tg = [
    `🧠 Aggressive autotune (${args.apply ? 'APPLIED' : 'DRY-RUN'})`,
    `• window: ${args.windowMin}m  candidates=${signals.totalCandidates} rejects=${signals.totalRejects}`,
    `• level: ${ctl.level} -> ${nextLevel}`,
    `• flags: attemptsNearZero=${signals.attemptsNearZero} rateLimitBad=${signals.rateLimitBad} swapErrorBad=${signals.swapErrorBad}`,
    `• counts: rateLimited=${signals.rateLimited} swapError=${signals.swapError} momentumRejects=${signals.momentumRejects}`,
    decision.plannedChanges.length ? `• changes:\n${decision.plannedChanges.map(x => `  - ${x}`).join('\n')}` : '• changes: none',
    reloadRes ? `• pm2 reload: ${reloadRes.ok ? 'ok' : 'failed'} ${reloadRes.err ? `(${reloadRes.err})` : ''}` : null,
    `🕒 ${decision.t}`,
  ].filter(Boolean).join('\n');

  if (args.printTelegram) console.log(tg);

  // Always print a compact CLI summary.
  console.log([
    `[autotune] ${decision.mode} t=${decision.t}`,
    `[autotune] level ${ctl.level} -> ${nextLevel} changes=${updates.size} candidates=${signals.totalCandidates} rateLimited=${signals.rateLimited} swapError=${signals.swapError}`,
    args.apply && args.pm2Reload ? `[autotune] pm2 reload ${args.pm2Proc}: ${reloadRes?.ok ? 'ok' : 'failed'}` : null,
  ].filter(Boolean).join('\n'));
}

main().catch((e) => {
  console.error('[autotune] fatal:', e);
  process.exit(1);
});
