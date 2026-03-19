// Centralized Jupiter 429 detection + cooldown/backoff state.
// Goal: avoid hammering Jupiter quote/swap endpoints during upstream throttling.

export function isJup429(e) {
  const msg = String(e?.message || '');
  const code = String(e?.code || '');
  return code === 'JUPITER_429' || msg.includes('JUPITER_429') || (Number(e?.status) === 429);
}

export function jupCooldownRemainingMs(state, nowMs) {
  const until = Number(state?.jup?.cooldownUntilMs || 0);
  return Math.max(0, until - Number(nowMs));
}

function ensureJupShape(state) {
  state.jup ||= { cooldownUntilMs: 0, streak429: 0, last429AtMs: 0, lastReason: null };
  state.jup.cooldownUntilMs = Number(state.jup.cooldownUntilMs || 0);
  state.jup.streak429 = Number(state.jup.streak429 || 0);
  state.jup.last429AtMs = Number(state.jup.last429AtMs || 0);
}

/**
 * Register a Jupiter 429 hit and return the new cooldown.
 *
 * Strategy: jittered exponential backoff capped at maxMs, with streak reset after quiet period.
 */
export function hitJup429({
  state,
  nowMs,
  baseMs = 15_000,
  maxMs = 10 * 60_000,
  quietResetMs = 10 * 60_000,
  reason = 'jupiter(429)',
  persist = null,
} = {}) {
  ensureJupShape(state);

  const t = Number(nowMs);

  // If last 429 was a while ago, reset streak.
  if (state.jup.last429AtMs && (t - state.jup.last429AtMs) > quietResetMs) {
    state.jup.streak429 = 0;
  }

  state.jup.last429AtMs = t;
  state.jup.lastReason = reason;

  const streak = Math.max(0, Math.min(12, Number(state.jup.streak429 || 0)));
  const mult = Math.pow(2, streak);
  const raw = Math.min(maxMs, Math.round(baseMs * mult));
  const jitter = Math.round(raw * (0.15 + Math.random() * 0.2));
  const waitMs = Math.min(maxMs, raw + jitter);

  state.jup.streak429 = streak + 1;
  state.jup.cooldownUntilMs = Math.max(state.jup.cooldownUntilMs || 0, t + waitMs);

  try { persist?.(); } catch {}

  return { cooldownUntilMs: state.jup.cooldownUntilMs, waitMs, streak: state.jup.streak429 };
}
