export async function maybeSendScanCycleVisibilityPing({ state, cfg, t, tgSend, boostedRaw, boosted }) {
  const visibilityPings = (state?.flags?.tgVisibilityPings ?? cfg.TG_VISIBILITY_PINGS);
  if (!visibilityPings) return;
  try {
    if (!globalThis.__lastEvalPingAt || (t - globalThis.__lastEvalPingAt) > 30 * 60_000) {
      globalThis.__lastEvalPingAt = t;
      await tgSend(cfg, `🔎 Scan cycle: boostedRaw=${boostedRaw.length} deduped=${boosted.length}`);
    }
  } catch {}
}

export async function maybeSendSourceMixVisibilityPing({ state, cfg, t, tgSend, preCandidates }) {
  const visibilityPings2 = (state?.flags?.tgVisibilityPings ?? cfg.TG_VISIBILITY_PINGS);
  if (!visibilityPings2) return;
  try {
    const total = preCandidates.length;
    const fromJup = preCandidates.filter(x => x?.tok?._source === 'jup').length;
    if (total > 0 && (!globalThis.__lastSourcePingAt || (t - globalThis.__lastSourcePingAt) > 30 * 60_000)) {
      globalThis.__lastSourcePingAt = t;
      await tgSend(cfg, `🧭 Candidate sources: total=${total} (jup=${fromJup}, dexBoosted=${total - fromJup})`);
    }
  } catch {}
}
