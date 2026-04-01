import fs from 'node:fs';
import path from 'node:path';

// Increment this when the on-disk shape changes.
export const STATE_SCHEMA_VERSION = 1;

function makeFreshState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    positions: {},
    portfolio: {
      startEquityUsdc: 100,
      maxEquityUsdc: 100,
    },
    dex: { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null },
    lastHeartbeatAt: null,
  };
}

function migrateState(state) {
  // Defensive: never throw during migration; worst case we trade with defaults.
  const s = (state && typeof state === 'object') ? state : {};

  // v0 -> v1: add schemaVersion + defaults
  if (!('schemaVersion' in s)) s.schemaVersion = 0;

  if (s.schemaVersion < 1) {
    s.positions ||= {};
    s.portfolio ||= { startEquityUsdc: 100, maxEquityUsdc: 100 };
    s.dex ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };
    s.lastHeartbeatAt ??= null;

    s.schemaVersion = 1;
  }

  // Current-version invariants (even for future versions).
  s.positions ||= {};
  s.dex ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };

  return s;
}

export function loadState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateState(parsed);
  } catch {
    return makeFreshState();
  }
}

function sanitizeForSave(state) {
  const s = (state && typeof state === 'object') ? { ...state } : {};

  // Runtime caches are ephemeral and can explode memory/file size.
  if (s.runtime && typeof s.runtime === 'object') {
    const r = { ...s.runtime };
    delete r.compactWindow;
    delete r.diagSnapshot;
    delete r.confirmTxCarryByMint;
    delete r.confirmLiqTrack;
    delete r.mintCreatedAtCache;
    delete r.momentumRepeatFail;
    s.runtime = r;
  }

  // Trim obvious array-heavy counters to keep state bounded.
  if (s.counters && typeof s.counters === 'object') {
    const trimArrays = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && v.length > 200) obj[k] = v.slice(-200);
        else if (v && typeof v === 'object') trimArrays(v);
      }
    };
    trimArrays(s.counters);
  }

  return s;
}

// Atomic write: write temp file then rename.
export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  const safeState = sanitizeForSave(state);
  fs.writeFileSync(tmp, JSON.stringify(safeState, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, statePath);
}
