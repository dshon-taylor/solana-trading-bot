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
  'watchlistSeen',
  'watchlistEvaluated',
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
  'hotBypass',
  'providerHealth',
  'scanCycle',
  'candidateSeen',
  'candidateRouteable',
  'candidateLiquiditySeen',
  'shortlistPreCandidate',
  'shortlistSelected',
  'preHotFlow',
]);

const FAMILY_KIND_SETS = {
  momentum: new Set([
    'watchlistSeen',
    'watchlistEvaluated',
    'momentumEval',
    'momentumPassed',
    'momentumFailChecks',
    'momentumLiq',
    'momentumRecent',
    'momentumScoreSample',
    'momentumInputSample',
    'momentumAgeSample',
    'repeatSuppressed',
    'blocker',
    'stalkableSeen',
    'hotBypass',
    'preHotFlow',
  ]),
  provider: new Set(['providerHealth']),
  confirm: new Set(['confirmReached', 'confirmPassed', 'postMomentumFlow']),
  execution: new Set(['attempt', 'fill']),
  scanner: new Set(['scanCycle', 'candidateSeen', 'candidateRouteable', 'candidateLiquiditySeen', 'shortlistPreCandidate', 'shortlistSelected']),
};

const STORE_BY_PATH = new Map();
const HOUR_MS = 60 * 60_000;

function toEvent(ev) {
  const tMs = Number(ev?.tMs || 0);
  const kind = String(ev?.kind || '').trim();
  if (!Number.isFinite(tMs) || !kind) return null;
  return { tMs, kind, reason: ev?.reason ?? null, extra: ev?.extra ?? null };
}

function makeStore(filePath) {
  return {
    filePath,
    seq: 0,
    events: [],
    hourBuckets: new Map(),
    windowCache: new Map(),
    sync: { initialized: false, offset: 0, remainder: '' },
  };
}

function getStore(filePath) {
  const p = String(filePath || '');
  if (!STORE_BY_PATH.has(p)) STORE_BY_PATH.set(p, makeStore(p));
  return STORE_BY_PATH.get(p);
}

function maxBufferedEvents() {
  return Math.max(10_000, Number(process.env.DIAG_EVENT_RING_MAX || 250_000));
}

function rebuildHourBuckets(store) {
  const m = new Map();
  for (const ev of store.events) {
    const hourKey = Math.floor(Number(ev?.tMs || 0) / HOUR_MS);
    if (!m.has(hourKey)) m.set(hourKey, []);
    m.get(hourKey).push(ev);
  }
  store.hourBuckets = m;
}

function ingestEventIntoStore(store, event) {
  store.events.push(event);
  const hourKey = Math.floor(Number(event?.tMs || 0) / HOUR_MS);
  if (!store.hourBuckets.has(hourKey)) store.hourBuckets.set(hourKey, []);
  store.hourBuckets.get(hourKey).push(event);
  store.seq += 1;
  store.windowCache.clear();

  const cap = maxBufferedEvents();
  if (store.events.length > cap) {
    store.events = store.events.slice(store.events.length - cap);
    rebuildHourBuckets(store);
    store.windowCache.clear();
  }
}

function readTailLines(filePath, maxLines) {
  const linesWanted = Math.max(1, Number(maxLines || 10_000));
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const size = Number(st.size || 0);
    if (size <= 0) return { lines: [], size };

    const chunkSize = 64 * 1024;
    let pos = size;
    let text = '';
    let nlCount = 0;

    while (pos > 0 && nlCount <= linesWanted) {
      const start = Math.max(0, pos - chunkSize);
      const len = pos - start;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      const part = buf.toString('utf8');
      text = part + text;
      nlCount += (part.match(/\n/g) || []).length;
      pos = start;
    }

    const rawLines = text.split('\n').filter(Boolean);
    const lines = rawLines.slice(-linesWanted);
    return { lines, size };
  } finally {
    fs.closeSync(fd);
  }
}

function syncStoreFromFile({ filePath, nowMs = Date.now(), replayMaxLines = null, retainMs = null } = {}) {
  const store = getStore(filePath);
  if (!fs.existsSync(filePath)) {
    store.sync.initialized = true;
    store.sync.offset = 0;
    store.sync.remainder = '';
    return store;
  }

  const st = fs.statSync(filePath);
  const size = Number(st.size || 0);
  const retentionMs = Number.isFinite(Number(retainMs))
    ? Number(retainMs)
    : Math.max(60 * 60_000, Number(process.env.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
  const cutoff = Math.max(0, Number(nowMs || Date.now()) - retentionMs);

  const doTailLoad = !store.sync.initialized || size < Number(store.sync.offset || 0);
  if (doTailLoad) {
    const maxLines = Math.max(10_000, Number(replayMaxLines ?? process.env.DIAG_HYDRATE_MAX_LINES ?? 500_000));
    const { lines, size: tailSize } = readTailLines(filePath, maxLines);
    store.events = [];
    store.hourBuckets = new Map();
    store.windowCache = new Map();
    store.seq = 0;
    for (const ln of lines) {
      try {
        const ev = toEvent(JSON.parse(ln));
        if (!ev || ev.tMs < cutoff) continue;
        ingestEventIntoStore(store, ev);
      } catch {}
    }
    store.sync.initialized = true;
    store.sync.offset = tailSize;
    store.sync.remainder = '';
    return store;
  }

  if (size === Number(store.sync.offset || 0)) return store;

  const start = Number(store.sync.offset || 0);
  const len = Math.max(0, size - start);
  if (len <= 0) return store;

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const chunk = store.sync.remainder + buf.toString('utf8');
    const lines = chunk.split('\n');
    store.sync.remainder = lines.pop() || '';
    for (const ln of lines) {
      if (!ln) continue;
      try {
        const ev = toEvent(JSON.parse(ln));
        if (!ev || ev.tMs < cutoff) continue;
        ingestEventIntoStore(store, ev);
      } catch {}
    }
    store.sync.offset = size;
  } finally {
    fs.closeSync(fd);
  }

  return store;
}

function familyForKind(kind) {
  const k = String(kind || '');
  if (FAMILY_KIND_SETS.momentum.has(k)) return 'momentum';
  if (FAMILY_KIND_SETS.confirm.has(k)) return 'confirm';
  if (FAMILY_KIND_SETS.execution.has(k)) return 'execution';
  if (FAMILY_KIND_SETS.scanner.has(k)) return 'scanner';
  return null;
}

function familyForMode(mode = 'compact') {
  const m = String(mode || 'compact').toLowerCase();
  if (m === 'momentum') return 'momentum';
  if (m === 'confirm') return 'confirm';
  if (m === 'execution') return 'execution';
  if (m === 'scanner') return 'scanner';
  return null;
}

function matchesFamily(ev, family) {
  if (!family) return true;
  const set = FAMILY_KIND_SETS[family];
  return set ? set.has(String(ev?.kind || '')) : true;
}

function collectEventsFromStore({ store, cutoffMs = 0, family = null } = {}) {
  const startHour = Math.floor(Number(cutoffMs || 0) / HOUR_MS);
  const hourKeys = Array.from(store.hourBuckets.keys()).filter((k) => Number(k) >= startHour).sort((a, b) => a - b);
  const out = [];
  for (const hk of hourKeys) {
    const rows = store.hourBuckets.get(hk) || [];
    for (const ev of rows) {
      if (Number(ev?.tMs || 0) < cutoffMs) continue;
      if (!matchesFamily(ev, family)) continue;
      out.push(ev);
    }
  }
  return out;
}

function dedupeEvents(events = []) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const key = `${Number(ev?.tMs || 0)}|${String(ev?.kind || '')}|${String(ev?.reason || '')}|${JSON.stringify(ev?.extra || null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  out.sort((a, b) => Number(a?.tMs || 0) - Number(b?.tMs || 0));
  return out;
}

export function getDiagEventsPath(statePath = 'state/state.json') {
  return path.join(path.dirname(statePath || 'state/state.json'), 'diag_events.jsonl');
}

export function getDiagFamilyEventsPath(statePath = 'state/state.json', family = 'momentum') {
  return path.join(path.dirname(statePath || 'state/state.json'), `diag_events.${String(family || 'other')}.jsonl`);
}

export function shouldPersistDiagEvent(kind) {
  return PERSIST_KINDS.has(String(kind || ''));
}

export function appendDiagEvent({ appendJsonl, statePath, event }) {
  if (typeof appendJsonl !== 'function') return false;
  const normalized = toEvent(event);
  const kind = String(normalized?.kind || '');
  if (!normalized || !shouldPersistDiagEvent(kind)) return false;

  const canonicalPath = getDiagEventsPath(statePath);
  appendJsonl(canonicalPath, normalized);
  ingestEventIntoStore(getStore(canonicalPath), normalized);

  const family = familyForKind(kind);
  if (family) {
    try {
      const familyPath = getDiagFamilyEventsPath(statePath, family);
      appendJsonl(familyPath, normalized);
      ingestEventIntoStore(getStore(familyPath), normalized);
    } catch {}
  }

  return true;
}

export function readRecentDiagEvents({
  statePath,
  nowMs = Date.now(),
  windowStartMs = null,
  retainMs = null,
  replayMaxLines = null,
  mode = null,
  preferFamilyLogs = true,
} = {}) {
  const retentionMs = Number.isFinite(Number(retainMs))
    ? Number(retainMs)
    : Math.max(60 * 60_000, Number(process.env.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
  const retentionCutoff = Math.max(0, Number(nowMs || Date.now()) - retentionMs);
  const windowCutoff = Number.isFinite(Number(windowStartMs)) ? Number(windowStartMs) : 0;
  const cutoff = Math.max(retentionCutoff, windowCutoff);

  const canonicalPath = getDiagEventsPath(statePath);
  const canonicalStore = syncStoreFromFile({ filePath: canonicalPath, nowMs, replayMaxLines, retainMs: retentionMs });
  let primary = collectEventsFromStore({ store: canonicalStore, cutoffMs: cutoff, family: null });

  const useFamily = preferFamilyLogs && String(process.env.DIAG_FAMILY_LOGS_ENABLED || 'true') === 'true';
  const fam = useFamily ? familyForMode(mode) : null;
  if (fam) {
    const familyPath = getDiagFamilyEventsPath(statePath, fam);
    const familyStore = syncStoreFromFile({ filePath: familyPath, nowMs, replayMaxLines, retainMs: retentionMs });
    const famRows = collectEventsFromStore({ store: familyStore, cutoffMs: cutoff, family: fam });
    const backstop = (process.env.DIAG_FAMILY_CANONICAL_BACKSTOP ?? 'true') === 'true';
    primary = backstop ? dedupeEvents([...famRows, ...primary.filter((ev) => matchesFamily(ev, fam))]) : famRows;
  }

  return primary;
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
    shortlistPreCandidate: [],
    shortlistSelected: [],
    repeatSuppressed: [],
    providerHealth: [],
    hotBypass: [],
    preHotFlow: [],
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
      pushObj(w.blockers, { tMs, reason: String(reason || 'unknown'), mint: String(extra?.mint || 'unknown'), stage: String(extra?.stage || 'unknown'), liqUsd: Number(extra?.liqUsd || 0), mcapUsd: Number(extra?.mcapUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'momentumFailChecks') {
      pushObj(w.momentumFailChecks, { tMs, checks: Array.isArray(extra?.checks) ? extra.checks.slice(0, 16) : [], mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
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
    if (kind === 'shortlistPreCandidate') {
      pushObj(w.shortlistPreCandidate, { tMs, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'shortlistSelected') {
      pushObj(w.shortlistSelected, { tMs, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'scanCycle') {
      pushObj(w.scanCycles, { tMs, ...(extra || {}) }, cutoffMs);
      continue;
    }
    if (kind === 'repeatSuppressed') {
      pushObj(w.repeatSuppressed, { tMs, mint: String(extra?.mint || 'unknown'), reason: String(extra?.reason || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) }, cutoffMs);
      continue;
    }
    if (kind === 'providerHealth') {
      pushObj(w.providerHealth, { tMs, provider: String(extra?.provider || 'unknown'), outcome: String(extra?.outcome || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'hotBypass') {
      pushObj(w.hotBypass, { tMs, mint: String(extra?.mint || 'unknown'), decision: String(extra?.decision || 'unknown'), primary: String(extra?.primary || 'unknown') }, cutoffMs);
      continue;
    }
    if (kind === 'preHotFlow') {
      pushObj(w.preHotFlow, {
        tMs,
        mint: String(extra?.mint || 'unknown'),
        liqUsd: Number(extra?.liqUsd || 0),
        mcapUsd: Number(extra?.mcapUsd || 0),
        stage: String(extra?.stage || 'preHot'),
        outcome: String(extra?.outcome || 'unknown'),
        reason: String(extra?.reason || 'none'),
        reasons: Array.isArray(extra?.reasons) ? extra.reasons.slice(0, 8).map((x) => String(x || '')) : [],
      }, cutoffMs);
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

export function getCompactWindowForDiagRequest({
  statePath,
  mode = 'compact',
  nowMs = Date.now(),
  windowStartMs = 0,
  retainMs = null,
  replayMaxLines = null,
} = {}) {
  const retentionMs = Number.isFinite(Number(retainMs))
    ? Number(retainMs)
    : Math.max(60 * 60_000, Number(process.env.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
  const cutoff = Math.max(0, Number(windowStartMs || 0), Number(nowMs || Date.now()) - retentionMs);
  const key = `${String(mode || 'compact')}|${Math.floor(cutoff / 1000)}`;

  const canonicalPath = getDiagEventsPath(statePath);
  const canonicalStore = syncStoreFromFile({ filePath: canonicalPath, nowMs, replayMaxLines, retainMs: retentionMs });
  const currentSeq = Number(canonicalStore.seq || 0);
  const cached = canonicalStore.windowCache.get(key);
  if (cached && Number(cached.seq || -1) === currentSeq) return cached.window;

  const events = readRecentDiagEvents({
    statePath,
    nowMs,
    windowStartMs: cutoff,
    retainMs: retentionMs,
    replayMaxLines,
    mode,
    preferFamilyLogs: true,
  });
  const window = buildCompactWindowFromDiagEvents({ events, cutoffMs: cutoff });
  canonicalStore.windowCache.set(key, { seq: currentSeq, window });
  return window;
}
