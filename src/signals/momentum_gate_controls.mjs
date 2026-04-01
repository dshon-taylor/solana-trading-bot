function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function isMicroFreshEnough({
  microPresentCount,
  freshnessMs,
  maxAgeMs,
  requireFreshMicro = true,
  minPresentForGate = 3,
}) {
  if (!requireFreshMicro) return { ok: true, reason: 'freshnessGateDisabled' };
  const present = Math.max(0, toNum(microPresentCount, 0));
  if (present < Math.max(1, toNum(minPresentForGate, 3))) return { ok: true, reason: 'insufficientMicroFieldsForGate' };
  const ageMs = toNum(freshnessMs, NaN);
  if (!Number.isFinite(ageMs)) return { ok: false, reason: 'microFreshnessMissing' };
  if (ageMs > Math.max(250, toNum(maxAgeMs, 10_000))) return { ok: false, reason: 'microStale' };
  return { ok: true, reason: 'microFresh' };
}

export function applyMomentumPassHysteresis({
  state,
  mint,
  nowMs,
  gatePassed,
  requiredStreak = 1,
  streakResetMs = 10 * 60_000,
}) {
  const required = Math.max(1, toNum(requiredStreak, 1));
  const resetMs = Math.max(30_000, toNum(streakResetMs, 10 * 60_000));
  if (required <= 1) {
    return { passed: !!gatePassed, streak: gatePassed ? 1 : 0, warmup: false, required };
  }

  state.runtime ||= {};
  state.runtime.momentumPassStreakByMint ||= {};
  const map = state.runtime.momentumPassStreakByMint;
  const prev = map[mint] || { streak: 0, lastAtMs: 0 };
  const stale = Number(nowMs || 0) - Number(prev.lastAtMs || 0) > resetMs;

  let nextStreak = stale ? 0 : Number(prev.streak || 0);
  if (gatePassed) nextStreak += 1;
  else nextStreak = 0;

  map[mint] = { streak: nextStreak, lastAtMs: Number(nowMs || 0) };

  const passed = !!gatePassed && nextStreak >= required;
  const warmup = !!gatePassed && !passed;
  return { passed, streak: nextStreak, warmup, required };
}

export function getCachedMintCreatedAt({ state, mint, nowMs, maxAgeMs = 60 * 60_000 }) {
  const cache = state?.runtime?.mintCreatedAtCache || null;
  const cached = cache?.[mint] || null;
  if (!cached) return null;
  const checkedAt = toNum(cached.checkedAtMs, 0);
  if (!checkedAt || (Number(nowMs || 0) - checkedAt) > Math.max(30_000, toNum(maxAgeMs, 60 * 60_000))) return null;
  const createdAtMs = toNum(cached.createdAtMs, 0);
  return createdAtMs > 0 ? { createdAtMs, source: String(cached.source || 'cache') } : null;
}

export function scheduleMintCreatedAtLookup({
  state,
  mint,
  nowMs,
  minRetryMs = 30_000,
  lookupFn,
}) {
  if (!mint || typeof lookupFn !== 'function') return false;
  state.runtime ||= {};
  state.runtime.mintCreatedAtLookup ||= {};
  const track = state.runtime.mintCreatedAtLookup;
  const row = track[mint] || { inFlight: false, lastAttemptMs: 0 };
  const retryMs = Math.max(1000, toNum(minRetryMs, 30_000));
  if (row.inFlight) return false;
  const hasAttempt = Number(row.lastAttemptMs || 0) > 0;
  if (hasAttempt && (Number(nowMs || 0) - Number(row.lastAttemptMs || 0)) < retryMs) return false;

  row.inFlight = true;
  row.lastAttemptMs = Number(nowMs || 0);
  track[mint] = row;

  Promise.resolve()
    .then(() => lookupFn())
    .catch(() => null)
    .finally(() => {
      const latest = track[mint] || {};
      latest.inFlight = false;
      track[mint] = latest;
    });

  return true;
}
