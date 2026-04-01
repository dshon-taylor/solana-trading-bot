import fs from 'node:fs';
import path from 'node:path';

export const STATE_SCHEMA_VERSION = 1;

function makeFreshState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    startedAt: new Date().toISOString(),
    positions: {},
    portfolio: { startEquityUsdc: 100, maxEquityUsdc: 100 },
    dex: { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null },
    lastHeartbeatAt: null,
  };
}

function migrateState(state) {
  const s = (state && typeof state === 'object') ? state : {};
  if (!('schemaVersion' in s)) s.schemaVersion = 0;
  if (s.schemaVersion < 1) {
    s.positions ||= {};
    s.portfolio ||= { startEquityUsdc: 100, maxEquityUsdc: 100 };
    s.dex ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };
    s.lastHeartbeatAt ??= null;
    s.schemaVersion = 1;
  }
  s.positions ||= {};
  s.dex ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };
  return s;
}

export function loadState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return migrateState(JSON.parse(raw));
  } catch {
    return makeFreshState();
  }
}

function sanitizeForSave(state) {
  const s = (state && typeof state === 'object') ? { ...state } : {};
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
  return s;
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitizeForSave(state), null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, statePath);
}
