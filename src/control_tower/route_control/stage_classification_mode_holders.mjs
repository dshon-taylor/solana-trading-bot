export function classifyNoPairReason({ state, mint, nowMs, maxAgeMs, routeAvailable, routeErrorKind, hitRateLimit }) {
  if (hitRateLimit || routeErrorKind === 'rateLimited') return 'rateLimited';
  const dead = state?.marketData?.noPairDeadMints?.[mint] || null;
  if (dead && Number(dead.untilMs || 0) > nowMs) return 'deadMint';
  if (routeErrorKind === 'nonTradableMint') return 'nonTradableMint';
  if (routeAvailable === true) return 'routeableNoMarketData';
  if (routeAvailable === false || routeErrorKind === 'routeNotFound') return 'routeNotFound';
  const birdCd = Number(state?.marketData?.providers?.birdeye?.cooldownUntilMs || 0);
  const dexCd = Number(state?.marketData?.providers?.dexscreener?.cooldownUntilMs || 0);
  const jupCd = Number(state?.marketData?.providers?.jupiter?.cooldownUntilMs || 0);
  if (birdCd > nowMs && dexCd > nowMs && jupCd > nowMs) return 'providerCooldown';
  const lkg = state?.marketData?.lastKnownGood?.[mint] || null;
  const ageMs = lkg?.atMs ? Math.max(0, nowMs - Number(lkg.atMs)) : null;
  if (Number.isFinite(ageMs) && ageMs > Number(maxAgeMs || 0)) return 'staleData';
  if (routeErrorKind === 'providerEmpty') return 'providerEmpty';
  return 'retriesExhausted';
}

export function isPaperModeActive({ state, cfg, nowMs = Date.now() }) {
  if (cfg.PAPER_ENABLED === true) return true;
  return Number(state?.paper?.enabledUntilMs || 0) > Number(nowMs || 0);
}

function minHoldersRequired({ cfg, poolAgeSec }) {
  const age = Number(poolAgeSec);
  if (Number.isFinite(age) && age <= Number(cfg.HOLDER_TIER_NEW_MAX_AGE_SEC || 1800)) {
    return Number(cfg.HOLDER_TIER_MIN_NEW || 400);
  }
  return Number(cfg.HOLDER_TIER_MIN_MATURE || 900);
}

export function holdersGateCheck({ cfg, holders, poolAgeSec }) {
  const h = Number(holders);
  const req = minHoldersRequired({ cfg, poolAgeSec });
  if (!Number.isFinite(h) || h <= 0) {
    if (cfg.HOLDER_MISSING_SOFT_ALLOW) return { ok: true, soft: true, reason: 'holdersMissing_soft', required: req };
    return { ok: false, reason: 'holdersMissing', required: req };
  }
  if (h < req) return { ok: false, reason: `holdersTooLow(${Math.round(h)}<${Math.round(req)})`, required: req };
  return { ok: true, required: req };
}
