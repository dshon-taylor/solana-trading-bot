#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const STATE_PATH = path.join(ROOT, 'state/state.json');
const PM2_OUT_PATH = path.join(ROOT, 'state/pm2-out-0.log');
const PM2_ERR_PATH = path.join(ROOT, 'state/pm2-err-0.log');
const LOG_PATH = path.join(ROOT, 'analysis/aggressive_autotune_log.md');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const mode = String(arg('--mode', 'dry-run')).toLowerCase(); // dry-run|apply
const windowMin = Math.max(10, Number(arg('--window-min', '20')) || 20);
const now = new Date();
const nowMs = now.getTime();
const sinceMs = nowMs - (windowMin * 60_000);

if (!['dry-run', 'apply'].includes(mode)) {
  console.error('Invalid --mode (use dry-run|apply)');
  process.exit(2);
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function parseIsoPrefixLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}Z`);
  return Number.isFinite(t) ? t : null;
}

function normalizeReason(reason) {
  const r = String(reason || 'unknown');
  if (r.startsWith('noPair(')) {
    const inner = r.slice('noPair('.length).replace(/\)$/, '');
    return `noPair.${inner}`;
  }
  return r.split('(')[0];
}

function summarizeRejects(items) {
  const counts = {};
  for (const it of items) {
    const key = normalizeReason(it?.reason);
    counts[key] = Number(counts[key] || 0) + 1;
  }
  const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { counts, top: pairs.slice(0, 8), total: items.length };
}

function parseEnvRaw(raw) {
  const lines = raw.split(/\r?\n/);
  const kv = {};
  for (const ln of lines) {
    if (!ln || ln.trim().startsWith('#')) continue;
    const i = ln.indexOf('=');
    if (i <= 0) continue;
    kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim();
  }
  return { lines, kv };
}

function setEnvValues(raw, updates) {
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((ln) => {
    if (!ln || ln.trim().startsWith('#')) return ln;
    const i = ln.indexOf('=');
    if (i <= 0) return ln;
    const k = ln.slice(0, i).trim();
    if (!(k in updates)) return ln;
    seen.add(k);
    return `${k}=${updates[k]}`;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  return out.join('\n');
}

function nearestStep(value, ladder) {
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(Number(value) - Number(ladder[i]));
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const envRaw = readText(ENV_PATH);
if (!envRaw) {
  console.error('Missing .env in trading-bot root');
  process.exit(2);
}

const state = readJson(STATE_PATH, {});
const debugLast = Array.isArray(state?.debug?.last) ? state.debug.last : [];
const recentDebug = debugLast.filter((x) => {
  const t = Date.parse(String(x?.t || ''));
  return Number.isFinite(t) && t >= sinceMs;
});
const rejectSummary = summarizeRejects(recentDebug);

const pm2OutRecent = readText(PM2_OUT_PATH)
  .split(/\r?\n/)
  .filter((ln) => {
    const t = parseIsoPrefixLine(ln);
    return t != null && t >= sinceMs;
  });
const pm2ErrRecent = readText(PM2_ERR_PATH)
  .split(/\r?\n/)
  .filter((ln) => {
    const t = parseIsoPrefixLine(ln);
    return t != null && t >= sinceMs;
  });

const allRecentLogLines = [...pm2OutRecent, ...pm2ErrRecent];
const rateLimitCount = allRecentLogLines.filter((ln) => /\b429\b|rate limit|rate-limited|providerCooldown/i.test(ln)).length
  + Number(rejectSummary.counts['noPair.rateLimited'] || 0)
  + Number(rejectSummary.counts['noPair.providerCooldown'] || 0);
const swapErrorCount = allRecentLogLines.filter((ln) => /swap error|jupiter swap failed|transaction failed|sendtransaction|simulation error/i.test(ln)).length
  + Number(rejectSummary.counts.swapError || 0);
const attemptSignals = allRecentLogLines.filter((ln) => /entry attempt|attempting entry|swap attempt|entrySuccess|signature=/i.test(ln)).length;
const momentumRejectCount = Number(rejectSummary.counts.momentum || 0);

const attemptsNearZero = attemptSignals < 1;
const rejectTotal = Math.max(1, rejectSummary.total);
const rateLimitShare = rateLimitCount / rejectTotal;
const momentumShare = momentumRejectCount / rejectTotal;

const LADDERS = {
  LIVE_PARALLEL_QUOTE_FANOUT_N: [2, 3, 4, 5, 6],
  NO_PAIR_RETRY_ATTEMPTS: [4, 5, 6, 7],
  NO_PAIR_RETRY_BASE_MS: [275, 240, 200, 160, 130],
  PAPER_ENTRY_COOLDOWN_MS: [180000, 150000, 120000, 90000, 60000],
  PAPER_ENTRY_RET_15M_PCT: [0.03, 0.025, 0.02, 0.015, 0.01],
  PAPER_ENTRY_RET_5M_PCT: [0.01, 0.008, 0.006, 0.005, 0.004],
  PAPER_ENTRY_GREEN_LAST5: [2, 2, 1, 1, 1],
  LIVE_REJECT_RECHECK_BURST_ATTEMPTS: [2, 3, 4, 5, 6],
  LIVE_REJECT_RECHECK_BURST_DELAY_MS: [140, 120, 100, 90, 80],
};

const { kv: env } = parseEnvRaw(envRaw);
const baseStep = nearestStep(Number(env.LIVE_PARALLEL_QUOTE_FANOUT_N || 2), LADDERS.LIVE_PARALLEL_QUOTE_FANOUT_N);

let decision = 'hold';
let delta = 0;
let rationale = 'steady state';
if (swapErrorCount >= 4 || rateLimitShare >= 0.35 || rateLimitCount >= 8) {
  decision = 'backoff';
  delta = -1;
  rationale = `failure pressure high (swapError=${swapErrorCount}, rateLimit=${rateLimitCount}, rateLimitShare=${rateLimitShare.toFixed(2)})`;
} else if (attemptsNearZero) {
  decision = 'escalate';
  delta = 1;
  rationale = `attempt signals near-zero; push aggressiveness (momentumShare=${momentumShare.toFixed(2)})`;
}

const targetStep = Math.max(0, Math.min(4, baseStep + delta));
const updates = {};
const changes = [];
for (const [k, ladder] of Object.entries(LADDERS)) {
  const idx = Math.min(targetStep, ladder.length - 1);
  const next = String(ladder[idx]);
  const cur = String(env[k] ?? '');
  if (cur !== next) {
    updates[k] = next;
    changes.push(`${k}: ${cur || '(unset)'} -> ${next}`);
  }
}

const logBlock = [
  `## ${now.toISOString()}`,
  `- mode: ${mode}`,
  `- windowMin: ${windowMin}`,
  `- diagProxy: debug.last=${rejectSummary.total}, pm2OutLines=${pm2OutRecent.length}, pm2ErrLines=${pm2ErrRecent.length}`,
  `- rejectTop: ${rejectSummary.top.map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
  `- safetySignals: attemptsNearZero=${attemptsNearZero}, attemptSignals=${attemptSignals}, swapError=${swapErrorCount}, rateLimit=${rateLimitCount}, rateLimitShare=${rateLimitShare.toFixed(2)}`,
  `- decision: ${decision} (step ${baseStep} -> ${targetStep}) — ${rationale}`,
  `- changes: ${changes.length ? changes.join('; ') : 'none'}`,
  '',
  'Telegram summary template:',
  '```',
  `[aggressive-autotune] ${mode.toUpperCase()} ${decision} step ${baseStep}->${targetStep}`,
  `window=${windowMin}m rejects=${rejectSummary.total} attemptsNearZero=${attemptsNearZero} swapErr=${swapErrorCount} rateLimit=${rateLimitCount}`,
  `topRejects=${rejectSummary.top.slice(0, 5).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
  `${changes.length ? `changes=${changes.join(' | ')}` : 'changes=none'}`,
  '```',
  '',
].join('\n');

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
fs.appendFileSync(LOG_PATH, logBlock, 'utf8');

if (mode === 'apply' && Object.keys(updates).length > 0) {
  const nextEnv = setEnvValues(envRaw, updates);
  fs.writeFileSync(ENV_PATH, nextEnv, 'utf8');
}

const result = {
  ok: true,
  mode,
  decision,
  step: { from: baseStep, to: targetStep },
  attemptsNearZero,
  swapErrorCount,
  rateLimitCount,
  rateLimitShare: Number(rateLimitShare.toFixed(4)),
  rejectTop: rejectSummary.top,
  updates,
  logPath: path.relative(ROOT, LOG_PATH),
};

console.log(JSON.stringify(result, null, 2));
