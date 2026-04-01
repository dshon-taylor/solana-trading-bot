export async function runJupiterPreflight({
  enabled,
  state,
  nowIso,
  safeMsg,
  pushDebug,
  parseJupQuoteFailure,
  circuitHit,
  persist,
}) {
  if (!enabled) return;

  try {
    const { jupiterPreflight } = await import('../../providers/jupiter/client.mjs');
    const pref = await jupiterPreflight();
    state.marketData ||= {};
    state.marketData.providers ||= {};
    state.marketData.providers.jupiter ||= {};
    if (!pref || !pref.ok) {
      state.marketData.providers.jupiter.status = 'unhealthy';
      const prefReason = String(pref?.reason || 'unknown');
      pushDebug(state, { t: nowIso(), reason: `jupPreflightFailed(${safeMsg(prefReason)})` });
      const parsed = parseJupQuoteFailure({ message: prefReason });
      if (parsed !== 'nonTradableMint') {
        circuitHit({ state, nowMs: Date.now(), dep: 'jup', note: `preflight(${prefReason})`, persist });
      }
    } else {
      state.marketData.providers.jupiter.status = 'ok';
    }
  } catch (e) {
    pushDebug(state, { t: nowIso(), reason: `jupPreflightException(${safeMsg(e)})` });
    circuitHit({ state, nowMs: Date.now(), dep: 'jup', note: `preflightException(${safeMsg(e)})`, persist });
  }
}
