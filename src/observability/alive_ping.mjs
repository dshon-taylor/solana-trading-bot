import { safeErr } from '../logger.mjs';

export function ensureAliveState(state) {
  state.alive ||= {};
  state.alive.lastPingAtMs ||= 0;
  state.alive.lastPingOkAtMs ||= 0;
  state.alive.lastPingErrAtMs ||= 0;
  state.alive.lastPingErr ||= null;
}

export async function maybeAlivePing({ cfg: _cfg, state, nowMs, reason = 'daily', persist }) {
  ensureAliveState(state);

  const url = process.env.ALIVE_PING_URL || '';
  const enabled = (process.env.ALIVE_PING_ENABLED || '').toLowerCase() !== 'false' && !!url;
  if (!enabled) return { ok: false, skipped: true, reason: 'disabled' };

  const everyMs = Number(process.env.ALIVE_PING_EVERY_MS || 24 * 60 * 60_000);
  const last = Number(state.alive.lastPingAtMs || 0);
  if (last && nowMs - last < everyMs) return { ok: false, skipped: true, reason: 'rate_limited' };

  // Mark intent before network call so repeated failures don't spam.
  state.alive.lastPingAtMs = nowMs;
  if (persist) persist();

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `alive: ${reason} @ ${new Date(nowMs).toISOString()}`,
    });

    if (!r.ok) throw new Error(`alive ping non-2xx: ${r.status}`);

    state.alive.lastPingOkAtMs = nowMs;
    state.alive.lastPingErrAtMs = 0;
    state.alive.lastPingErr = null;
    if (persist) persist();
    return { ok: true, skipped: false };
  } catch (e) {
    const se = safeErr(e);
    state.alive.lastPingErrAtMs = nowMs;
    state.alive.lastPingErr = se.message;
    if (persist) persist();
    return { ok: false, skipped: false, error: se.message };
  }
}
