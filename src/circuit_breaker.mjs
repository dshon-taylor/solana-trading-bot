// Simple circuit breaker for entry engine dependencies.
// Goal: after N consecutive failures from a dependency, pause *entries* for a while
// instead of tight-looping and spamming.

export function ensureCircuitState(state) {
  state.circuit ||= {};
  state.circuit.failures ||= { dex: 0, rpc: 0, jup: 0 };
  state.circuit.trippedUntilMs ||= 0;
  state.circuit.lastTripReason ||= null;
  state.circuit.lastTripAtMs ||= 0;
  state.circuit.lastResetAtMs ||= 0;
}

export function circuitEnabled() {
  return (process.env.CIRCUIT_BREAKER_ENABLED ?? 'true') === 'true';
}

export function circuitSnapshot(state) {
  ensureCircuitState(state);
  return {
    failures: { ...(state.circuit.failures || {}) },
    trippedUntilMs: Number(state.circuit.trippedUntilMs || 0),
    lastTripReason: state.circuit.lastTripReason || null,
  };
}

function thresholds() {
  // Conservative defaults: be quick to trip to avoid cascades.
  return {
    dex: Number(process.env.CIRCUIT_FAILS_DEX || 4),
    rpc: Number(process.env.CIRCUIT_FAILS_RPC || 3),
    jup: Number(process.env.CIRCUIT_FAILS_JUP || 5),
  };
}

function cooldownMs() {
  // Default to 60 minutes cooldown to provide breathing room for dependencies to recover.
  return Number(process.env.CIRCUIT_COOLDOWN_MS || 60 * 60_000);
}

export function circuitOkForEntries({ state, nowMs }) {
  ensureCircuitState(state);
  const until = Number(state.circuit.trippedUntilMs || 0);
  return !(until && nowMs < until);
}

export function circuitHit({ state, nowMs, dep, note, persist }) {
  ensureCircuitState(state);
  if (!circuitEnabled()) return { tripped: false, dep, count: 0 };

  state.circuit.failures[dep] = Number(state.circuit.failures[dep] || 0) + 1;

  const th = thresholds();
  const count = state.circuit.failures[dep];

  if (count >= (th[dep] ?? 999999)) {
    state.circuit.trippedUntilMs = nowMs + cooldownMs();
    state.circuit.lastTripAtMs = nowMs;
    state.circuit.lastTripReason = `${dep}: ${note || 'failure'}`;
    if (persist) persist();
    return { tripped: true, dep, count, untilMs: state.circuit.trippedUntilMs };
  }

  if (persist) persist();
  return { tripped: false, dep, count };
}

export function circuitClear({ state, nowMs, dep, persist }) {
  ensureCircuitState(state);
  if (!dep) {
    state.circuit.failures = { dex: 0, rpc: 0, jup: 0 };
  } else {
    state.circuit.failures[dep] = 0;
  }
  state.circuit.lastResetAtMs = nowMs;
  if (persist) persist();
}
