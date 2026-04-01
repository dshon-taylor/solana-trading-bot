function pct(n, d) {
  return d ? (100 * n / d) : 0;
}

export function summarizeLast(state, n = 100) {
  const items = (state?.debug?.last || []).slice(-n);
  const counts = {};
  for (const it of items) {
    const r = String(it.reason || 'unknown');
    const key = r.split('(')[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  return { n: items.length, counts };
}

export function autoTuneFilters({ state, cfg, nowIso }) {
  // Goal: reach momentum and make at least one trade.
  // Keep RugCheck strict; relax only liquidity/age/mcap stepwise.

  state.filterOverrides ||= {};

  const curLiq = state.filterOverrides.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
  const curAge = state.filterOverrides.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
  const curMcap = state.filterOverrides.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
  const curRatio = state.filterOverrides.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO;

  const items = (state?.debug?.last || []).slice(-120);
  const baseLiqFails = items.filter(x => String(x.reason||'').includes('liquidity<')).length;
  const ageFails = items.filter(x => String(x.reason||'').includes('age<')).length;
  const mcapFails = items.filter(x => String(x.reason||'').startsWith('mcap(') || String(x.reason||'').includes('mcap<')).length;
  const momentumFails = items.filter(x => String(x.reason||'').startsWith('momentum')).length;

  const total = items.length || 1;

  const changes = [];

  // If we're still liquidity starved, drop floor.
  if (pct(baseLiqFails, total) >= 50) {
    const next = Math.max(10_000, Math.round(curLiq * 0.8));
    if (next < curLiq) {
      state.filterOverrides.MIN_LIQUIDITY_USD = next;
      changes.push(`liq floor ${curLiq} -> ${next}`);
    }
  }

  // If age blocks often, relax down to 6h then 3h.
  if (pct(ageFails, total) >= 15) {
    const next = Math.max(3, curAge > 6 ? 6 : 3);
    if (next < curAge) {
      state.filterOverrides.MIN_TOKEN_AGE_HOURS = next;
      changes.push(`age ${curAge}h -> ${next}h`);
    }
  }

  // If mcap blocks often, relax down to 200k then 150k.
  if (pct(mcapFails, total) >= 10) {
    const next = Math.max(150_000, curMcap > 200_000 ? 200_000 : 150_000);
    if (next < curMcap) {
      state.filterOverrides.MIN_MCAP_USD = next;
      changes.push(`mcap ${curMcap} -> ${next}`);
    }
  }

  // If we're reaching momentum but failing it, relax ratio slightly.
  if (momentumFails > 0 && pct(momentumFails, total) >= 30) {
    const next = Math.max(0.10, Math.round((curRatio - 0.02) * 100) / 100);
    if (next < curRatio) {
      state.filterOverrides.LIQUIDITY_TO_MCAP_RATIO = next;
      changes.push(`liqratio ${curRatio} -> ${next}`);
    }
  }

  if (changes.length) {
    state.autoTune ||= {};
    state.autoTune.lastChangeAt = nowIso();
    state.autoTune.lastChange = changes;
  }

  return changes;
}
