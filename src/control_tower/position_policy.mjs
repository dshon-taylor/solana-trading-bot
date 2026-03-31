import { nowIso } from '../logger.mjs';
import { pushDebug } from '../debug_buffer.mjs';
import { computePreTrailStopPrice } from '../lib/stop_policy.mjs';

export function positionCount(state) {
  return Object.values(state.positions || {}).filter(p => p?.status === 'open').length;
}

export function entryCapacityAvailable(state, cfg) {
  state.runtime ||= {};
  const open = positionCount(state);
  const maxPos = Math.max(0, Number(cfg.MAX_POSITIONS || 0));
  const resumeAt = Math.max(0, maxPos - 1);

  if (state.runtime.maxPosHaltActive) {
    if (open <= resumeAt) state.runtime.maxPosHaltActive = false;
  } else if (open >= maxPos) {
    state.runtime.maxPosHaltActive = true;
  }

  return !state.runtime.maxPosHaltActive && open < maxPos;
}

export function enforceEntryCapacityGate({ state, cfg, mint, symbol = null, tag = 'generic' }) {
  const nowMs = Date.now();
  const pauseUntilMs = Number(state?.exposure?.pausedUntilMs || 0);
  if (pauseUntilMs > nowMs) {
    pushDebug(state, {
      t: nowIso(),
      mint,
      symbol,
      reason: `ENTRY(blocked exposurePause ${tag} until=${new Date(pauseUntilMs).toISOString()})`,
    });
    return false;
  }
  if (entryCapacityAvailable(state, cfg)) return true;
  pushDebug(state, {
    t: nowIso(),
    mint,
    symbol,
    reason: `ENTRY(blocked preSwap maxPositionsHysteresis ${tag})`,
  });
  return false;
}

export function cleanTokenText(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined' || low === 'n/a') return '';
  return s;
}

export function tokenDisplayName({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  if (n) return n;
  const s = cleanTokenText(symbol);
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

export function tokenDisplayWithSymbol({ name = null, symbol = null, mint = null } = {}) {
  const n = cleanTokenText(name);
  const s = cleanTokenText(symbol);
  if (n && s) return `${n} (${s})`;
  if (n) return n;
  if (s) return s;
  const m = cleanTokenText(mint);
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

export function conservativeExitMark(priceUsd, pos = null, snapshot = null, cfg = null) {
  const px = Number(priceUsd || 0);
  if (!(px > 0)) return px;
  const spreadPct = Number(snapshot?.spreadPct ?? snapshot?.pair?.spreadPct ?? snapshot?.pair?.market?.spreadPct ?? snapshot?.pair?.raw?.spreadPct);
  const spread = Number.isFinite(spreadPct) && spreadPct > 0 ? (spreadPct / 100) : 0;
  const slip = Math.max(0, Number(cfg?.DEFAULT_SLIPPAGE_BPS || 0) / 10_000);
  const baseHaircut = Math.max(0.01, Math.min(0.04, slip * 0.6));
  const spreadHaircut = Math.max(0, Math.min(0.04, spread * 0.5));
  const totalHaircut = Math.max(0.01, Math.min(0.08, baseHaircut + spreadHaircut));
  return px * (1 - totalHaircut);
}

export function applyMomentumDefaultsToPosition(cfg, pos) {
  if (!pos || pos.status !== 'open') return;
  const entry = Number(pos.entryPriceUsd || 0);
  if (!entry) return;

  pos.stopAtEntry = cfg.LIVE_MOMO_STOP_AT_ENTRY === true;
  pos.trailActivatePct = cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT;
  pos.trailDistancePct = cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT;

  const nowMs = Date.now();
  const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMs;
  const baseline = computePreTrailStopPrice({
    entryPriceUsd: entry,
    entryAtMs,
    nowMs,
    armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
    prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
    stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
  });
  if (Number.isFinite(Number(baseline)) && baseline > 0) {
    pos.stopPriceUsd = Math.max(Number(pos.stopPriceUsd || 0), Number(baseline));
  }
}
