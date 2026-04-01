import fs from 'node:fs';
import path from 'node:path';

const TS_EVENT_KINDS = new Set([
  'watchlistSeen',
  'watchlistEvaluated',
  'momentumEval',
  'momentumPassed',
  'confirmReached',
  'confirmPassed',
  'attempt',
  'fill',
]);

const PERSIST_KINDS = new Set([
  'momentumEval',
  'momentumPassed',
  'momentumFailChecks',
  'momentumLiq',
  'momentumRecent',
  'momentumScoreSample',
  'momentumInputSample',
  'momentumAgeSample',
  'repeatSuppressed',
  'confirmReached',
  'confirmPassed',
  'attempt',
  'fill',
  'postMomentumFlow',
  'blocker',
  'stalkableSeen',
  'scanCycle',
  'candidateSeen',
  'candidateRouteable',
  'candidateLiquiditySeen',
]);

export function getDiagEventsPath(statePath = 'state/state.json') {
  return path.join(path.dirname(statePath || 'state/state.json'), 'diag_events.jsonl');
}

export function shouldPersistDiagEvent(kind) {
  return PERSIST_KINDS.has(String(kind || ''));
}

export function appendDiagEvent({ appendJsonl, statePath, event }) {
  if (typeof appendJsonl !== 'function') return false;
  const kind = String(event?.kind || '');
  if (!shouldPersistDiagEvent(kind)) return false;
  appendJsonl(getDiagEventsPath(statePath), {
    tMs: Number(event?.tMs || Date.now()),
    kind,
    reason: event?.reason ?? null,
    extra: event?.extra ?? null,
  });
  return true;
}

export function readRecentDiagEvents({
  statePath,
  nowMs = Date.now(),
  windowStartMs = null,
  retainMs = null,
  replayMaxLines = null,
} = {}) {
  const p = getDiagEventsPath(statePath);
  if (!fs.existsSync(p)) return [];

  const maxLines = Math.max(
    10_000,
    Number(replayMaxLines ?? process.env.DIAG_HYDRATE_MAX_LINES ?? 500_000),
  );
  const retentionMs = Number.isFinite(Number(retainMs))
    ? Number(retainMs)
    : Math.max(60 * 60_000, Number(process.env.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
  const retentionCutoff = Math.max(0, Number(nowMs) - retentionMs);
  const windowCutoff = Number.isFinite(Number(windowStartMs)) ? Number(windowStartMs) : 0;
  const cutoff = Math.max(retentionCutoff, windowCutoff);

  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.trim().split('\n').slice(-maxLines);
  const out = [];
  for (const ln of lines) {
    try {
      const ev = JSON.parse(ln);
      const tMs = Number(ev?.tMs || 0);
      const kind = String(ev?.kind || '').trim();
      if (!Number.isFinite(tMs) || tMs < cutoff || !kind) continue;
      out.push({ tMs, kind, reason: ev?.reason ?? null, extra: ev?.extra ?? null });
    } catch {}
  }
  return out;
}

function pushTs(arr, tMs, cutoffMs) {
  arr.push(Number(tMs || Date.now()));
  while (arr.length && Number(arr[0] || 0) < cutoffMs) arr.shift();
}

function pushObj(arr, obj, cutoffMs) {
  arr.push(obj);
  while (arr.length && Number(arr[0]?.tMs || 0) < cutoffMs) arr.shift();
}

export function buildCompactWindowFromDiagEvents({ events = [], cutoffMs = 0 } = {}) {
  const w = {
    momentumRecent: [],
    momentumScoreSamples: [],
    momentumInputSamples: [],
    momentumAgeSamples: [],
    blockers: [],
    watchlistSeen: [],
    watchlistEvaluated: [],
    momentumEval: [],
    momentumPassed: [],
    momentumFailChecks: [],
    confirmReached: [],
    confirmPassed: [],
    attempt: [],
    fill: [],
    postMomentumFlow: [],
    momentumLiqValues: [],
    stalkableSeen: [],
    scanCycles: [],
    candidateSeen: [],
    candidateRouteable: [],
    candidateLiquiditySeen: [],
    repeatSuppressed: [],
  };

  for (const ev of events) {
    const tMs = Number(ev?.tMs || 0);
    const kind = String(ev?.kind || '');
    const reason = ev?.reason ?? null;
    const extra = ev?.extra ?? null;
    if (!Number.isFinite(tMs) || tMs < cutoffMs || !kind) continue;

    if (TS_EVENT_KINDS.has(kind)) {
      if (!Array.isArray(w[kind])) w[kind] = [];
      pushTs(w[kind], tMs, cutoffMs);
      continue;
    }

    if (kind === 'blocker') {
      pushObj(w.blockers, { tMs, reason: String(reason || 'unknown'), mint: String(extra?.mint || 'unknown'), stage: String(extra?.stage || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'momentumFailChecks') {
      pushObj(w.momentumFailChecks, { tMs, checks: Array.isArray(extra?.checks) ? extra.checks.slice(0, 16) : [], mint: String(extra?.mint || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'momentumLiq') {
      pushObj(w.momentumLiqValues, { tMs, liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'stalkableSeen') {
      pushObj(w.stalkableSeen, { tMs, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'candidateSeen') {
      pushObj(w.candidateSeen, { tMs, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'candidateRouteable') {
      pushObj(w.candidateRouteable, { tMs, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'candidateLiquiditySeen') {
      pushObj(w.candidateLiquiditySeen, { tMs, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'scanCycle') {
      pushObj(w.scanCycles, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'repeatSuppressed') {
      pushObj(w.repeatSuppressed, { tMs, mint: String(extra?.mint || 'unknown'), reason: String(extra?.reason || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'momentumRecent') {
      pushObj(w.momentumRecent, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'momentumScoreSample') {
      pushObj(w.momentumScoreSamples, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'momentumInputSample') {
      pushObj(w.momentumInputSamples, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'momentumAgeSample') {
      pushObj(w.momentumAgeSamples, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'postMomentumFlow') {
      pushObj(w.postMomentumFlow, { tMs, ...(extra || {}) }, cutoffMs);
    }
  }

  return w;
}
