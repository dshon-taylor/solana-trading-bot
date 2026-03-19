// Centralized DexScreener 429 detection + cooldown/backoff state.

export function isDexScreener429(e) {
  const msg = String(e?.message || e || '');
  return msg.includes('DEXSCREENER_429') || msg.includes(' 429') || msg.includes('429');
}

export function ensureDexState(state) {
  state.dex ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };
  state.dex.cooldownUntilMs = Number(state.dex.cooldownUntilMs || 0);
  state.dex.streak429 = Number(state.dex.streak429 || 0);
  state.dex.last429AtMs = Number(state.dex.last429AtMs || 0);
  state.dex.lastReason = state.dex.lastReason || null;
  return state.dex;
}

export function getDexCooldownUntilMs(state) {
  ensureDexState(state);
  return Number(state.dex.cooldownUntilMs || 0);
}

function computeDexCooldownMs({ state, nowMs, baseMs }) {
  ensureDexState(state);

  // Reset streak if it has been calm for 10 minutes.
  if (state.dex.last429AtMs && (nowMs - state.dex.last429AtMs) > 10 * 60_000) {
    state.dex.streak429 = 0;
  }

  const streak = Math.max(0, Math.min(10, Number(state.dex.streak429 || 0)));
  const exp = Math.min(8, streak); // cap growth
  const raw = baseMs * (2 ** exp);

  // Jitter +/- 20%
  const jitter = 0.8 + (Math.random() * 0.4);
  const wait = Math.round(raw * jitter);

  // Hard cap at 15 minutes.
  return Math.min(wait, 15 * 60_000);
}

/**
 * Register a DexScreener 429 hit and return the new cooldown.
 *
 * @param {object} params
 * @param {object} params.state - shared state object (will mutate state.dex)
 * @param {number} params.nowMs
 * @param {number} params.baseMs
 * @param {string} [params.reason]
 * @param {function} [params.persist] - optional callback to persist state (best-effort)
 */
export function hitDex429({ state, nowMs, baseMs, reason, persist }) {
  ensureDexState(state);

  state.dex.streak429 = Number(state.dex.streak429 || 0) + 1;
  state.dex.last429AtMs = nowMs;
  state.dex.lastReason = reason || 'DEXSCREENER_429';

  const waitMs = computeDexCooldownMs({ state, nowMs, baseMs });
  state.dex.cooldownUntilMs = nowMs + waitMs;

  // Persist so restarts don't instantly hammer again.
  try { persist?.(); } catch {}

  return {
    waitMs,
    cooldownUntilMs: state.dex.cooldownUntilMs,
    streak429: state.dex.streak429,
    reason: state.dex.lastReason,
  };
}
