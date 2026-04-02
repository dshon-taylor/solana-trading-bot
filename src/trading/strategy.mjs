import { computeBirdEyeSignals, fetchPaperMetricsFromBirdEye, DEFAULTS } from '../signals/momentum_signals.mjs';

export function hoursSince(msEpoch) {
  return (Date.now() - msEpoch) / 1000 / 3600;
}

export function passesBaseFilters({ pair, minLiquidityUsd, minAgeHours }) {
  const liq = pair?.liquidity?.usd || 0;
  if (liq < minLiquidityUsd) return { ok: false, reason: `liquidity<${minLiquidityUsd}` };

  const createdAt = pair?.pairCreatedAt;
  if (!createdAt) return { ok: false, reason: 'missing pairCreatedAt' };
  const age = hoursSince(createdAt);
  if (age < minAgeHours) return { ok: false, reason: `age<${minAgeHours}h` };

  return { ok: true, reason: 'ok' };
}

export function getMomentumThresholds({ profile = 'normal', strict = false } = {}) {
  const p = String(profile || 'normal').toLowerCase();
  if (p === 'aggressive') {
    return strict
      ? {
        volumeMult: 1.05,
        minBuys: 7,
        buyVsSellMult: 1.15,
        pc1h: 1.2,
        pc4h: 2.4,
        tx1h: 16,
      }
      : {
        volumeMult: 1.0,
        minBuys: 4,
        buyVsSellMult: 1.05,
        pc1h: 0.6,
        pc4h: 1.2,
        tx1h: 8,
      };
  }

  return strict
    ? {
      volumeMult: 1.25,
      minBuys: 10,
      buyVsSellMult: 1.5,
      pc1h: 3,
      pc4h: 5,
      tx1h: 30,
    }
    : {
      volumeMult: 1.10,
      minBuys: 6,
      buyVsSellMult: 1.2,
      pc1h: 1.5,
      pc4h: 3,
      tx1h: 15,
    };
}

function ratio(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}

const liqTrack = new Map(); // mint -> { liqUsd, tsMs }
const MOMENTUM_HARD_LIQ_MIN_USD = Math.max(0, Number(process.env.MOMENTUM_HARD_LIQ_MIN_USD || 20_000));
const MOMENTUM_LIQ_PENALTY_BAND_1_MIN_USD = Math.max(0, Number(process.env.MOMENTUM_LIQ_PENALTY_BAND_1_MIN_USD || 20_000));
const MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD = Math.max(0, Number(process.env.MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD || 25_000));
const MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD = Math.max(0, Number(process.env.MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD || 30_000));
const MOMENTUM_LIQ_PENALTY_OFF_MIN_USD = Math.max(0, Number(process.env.MOMENTUM_LIQ_PENALTY_OFF_MIN_USD || 35_000));
const MOMENTUM_VOLUME_EXPANSION_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 0.95));
const MOMENTUM_VOLUME_EXPANSION_MIN_RATIO_FALLBACK = Math.max(0, Number(process.env.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO_FALLBACK || 0.5));
const MOMENTUM_TX_ACCEL_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0));
const MOMENTUM_TX_ACCEL_MIN_RATIO_FALLBACK = Math.max(0, Number(process.env.MOMENTUM_TX_ACCEL_MIN_RATIO_FALLBACK || 0.2));
const MOMENTUM_WALLET_EXPANSION_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25));

// Momentum score model (deterministic, explainable)
const MOMENTUM_SCORE_PRE_RUNNER_THRESHOLD = Number(process.env.MOMENTUM_SCORE_PRE_RUNNER_THRESHOLD || 45);
const MOMENTUM_SCORE_PASS_THRESHOLD = Number(process.env.MOMENTUM_SCORE_PASS_THRESHOLD || 58);
const MOMENTUM_SCORE_STRONG_THRESHOLD = Number(process.env.MOMENTUM_SCORE_STRONG_THRESHOLD || 75);

const MOMENTUM_SCORE_WEIGHTS = {
  walletExpansion: Number(process.env.MOMENTUM_SCORE_WEIGHT_WALLET_EXPANSION || 12),
  txAccel: Number(process.env.MOMENTUM_SCORE_WEIGHT_TX_ACCEL || 14),
  buySellRatio: Number(process.env.MOMENTUM_SCORE_WEIGHT_BUY_SELL_RATIO || 10),
  ret1: Number(process.env.MOMENTUM_SCORE_WEIGHT_RET1 || 12),
  ret5: Number(process.env.MOMENTUM_SCORE_WEIGHT_RET5 || 12),
  acceleration: Number(process.env.MOMENTUM_SCORE_WEIGHT_ACCELERATION || 10),
  volume5m: Number(process.env.MOMENTUM_SCORE_WEIGHT_VOLUME_5M || 10),
  tx1h: Number(process.env.MOMENTUM_SCORE_WEIGHT_TX1H || 8),
  liquidityQuality: Number(process.env.MOMENTUM_SCORE_WEIGHT_LIQUIDITY_QUALITY || 6),
  mcapLiqQuality: Number(process.env.MOMENTUM_SCORE_WEIGHT_MCAP_LIQ_QUALITY || 6),
};

const MOMENTUM_SCORE_PENALTIES = {
  weakVolumeExpansion: Number(process.env.MOMENTUM_SCORE_PENALTY_WEAK_VOLUME || 3),
  weakBuyPressure: Number(process.env.MOMENTUM_SCORE_PENALTY_WEAK_BUY_PRESSURE || 5),
  weakTxAcceleration: Number(process.env.MOMENTUM_SCORE_PENALTY_WEAK_TX_ACCELERATION || 4),
  weakWalletExpansion: Number(process.env.MOMENTUM_SCORE_PENALTY_WEAK_WALLET_EXPANSION || 2),
  negativeRet1: Number(process.env.MOMENTUM_SCORE_PENALTY_NEGATIVE_RET1 || 4),
  negativeRet5: Number(process.env.MOMENTUM_SCORE_PENALTY_NEGATIVE_RET5 || 5),
  mcapLiquidityGt6: Number(process.env.MOMENTUM_SCORE_PENALTY_MCAP_LIQ_GT_6 || 4),
  mcapLiquidityGt8: Number(process.env.MOMENTUM_SCORE_PENALTY_MCAP_LIQ_GT_8 || 6),
  liquidityBand20to25: Number(process.env.MOMENTUM_SCORE_PENALTY_LIQ_20_25K || 8),
  liquidityBand25to30: Number(process.env.MOMENTUM_SCORE_PENALTY_LIQ_25_30K || 5),
  liquidityBand30to35: Number(process.env.MOMENTUM_SCORE_PENALTY_LIQ_30_35K || 2),
  lowAbsoluteTxActivity: Number(process.env.MOMENTUM_SCORE_PENALTY_LOW_ABS_TX_ACTIVITY || 1),
  lowAbsoluteVolumeActivity: Number(process.env.MOMENTUM_SCORE_PENALTY_LOW_ABS_VOLUME_ACTIVITY || 1),
};

const MOMENTUM_MIN_ABS_TX1H_SOFT = Math.max(0, Number(process.env.MOMENTUM_MIN_ABS_TX1H_SOFT || 80));
const MOMENTUM_MIN_ABS_VOLUME_5M_SOFT = Math.max(0, Number(process.env.MOMENTUM_MIN_ABS_VOLUME_5M_SOFT || 10000));
const MOMENTUM_HARD_LIQ_GUARD_BUFFER_USD = Math.max(0, Number(process.env.MOMENTUM_HARD_LIQ_GUARD_BUFFER_USD || 500));

function momentumSignalWithThresholds(pair, t) {
  // BirdEye-native signals (use WS cache if present on pair.wsCache)
  const wsCache = pair?.wsCache || {};
  const be = computeBirdEyeSignals(pair, wsCache);

  const liq = Number(pair?.liquidity?.usd || 0);
  const tx1h = Number(be.tx_1h || 0);
  const volume5m = Number(be.volume_5m || 0);
  const mcapUsd = Number(pair?.marketCap ?? pair?.fdv ?? pair?.mcapUsd ?? 0);
  const ret1Raw = (be.ret_1m ?? be.ret1m ?? pair?.priceChange?.m1);
  const ret5Raw = (be.ret_5m ?? be.ret5m ?? pair?.priceChange?.m5);
  const ret1 = Number.isFinite(Number(ret1Raw)) ? Number(ret1Raw) : (Number(pair?.priceChange?.h1 || 0) / 60);
  const ret5 = Number.isFinite(Number(ret5Raw)) ? Number(ret5Raw) : (Number(pair?.priceChange?.h1 || 0) / 12);
  const bsr = Number(be.buySellRatio || 0);
  const buyDominance = Number(be.buyDominance ?? be.buy_dominance ?? (bsr > 0 ? (bsr / (1 + bsr)) : 0));
  const vol1m = Number(be.volatility_1m ?? be.vol1m ?? wsCache.volatility_1m ?? Math.abs(ret1 || 0));

  // Acceleration-aware early momentum interpretation (kept for diagnostics only)
  const retDenom = Math.max(Math.abs(ret5), 0.0001);
  const accelerationRatio = ret1 / retDenom;
  const earlyAccelerationPositive = (ret5 >= 4) && (ret1 >= (ret5 * 0.3));
  const earlyRetComboPass = (ret5 >= 4) && (ret1 >= 1.5) && earlyAccelerationPositive;
  // Optional spread/age metadata (reject when explicitly bad)
  const spreadPct = Number(
    pair?.spreadPct
    ?? pair?.market?.spreadPct
    ?? pair?.raw?.spreadPct
    ?? pair?.raw?.spread
    ?? NaN
  );
  const pairCreatedAt = Number(pair?.pairCreatedAt || 0) || null;
  const ageSec = pairCreatedAt ? Math.max(0, (Date.now() - pairCreatedAt) / 1000) : null;

  // Hard guards (loss-control): reject thin/chaotic setups.
  const hardRejects = [];
  const hardLiqGuardFloorUsd = Math.max(0, MOMENTUM_HARD_LIQ_MIN_USD - MOMENTUM_HARD_LIQ_GUARD_BUFFER_USD);
  if (liq < hardLiqGuardFloorUsd) hardRejects.push(`liq<${Math.round(hardLiqGuardFloorUsd)}`);
  if (Number.isFinite(spreadPct) && spreadPct > 3) hardRejects.push('spread>3%');
  if (ageSec != null && ageSec < 180) hardRejects.push('age<180s');

  // Reject if market-cap to liquidity ratio is extremely high (thin relative liquidity).
  const mcLiqRatio = (mcapUsd > 0 && liq > 0) ? (mcapUsd / liq) : null;
  if (mcLiqRatio != null && mcLiqRatio > 10.0) hardRejects.push('mcap/liquidity>10.0');

  // Reject if liquidity dropped >10% within last 60s (per-mint runtime tracking).
  const mintKey = String(pair?.baseToken?.address || pair?.pairAddress || '').trim();
  if (mintKey && liq > 0) {
    const nowMs = Date.now();
    const prev = liqTrack.get(mintKey) || null;
    if (prev && (nowMs - Number(prev.tsMs || 0)) <= 60_000) {
      const dropPct = prev.liqUsd > 0 ? ((prev.liqUsd - liq) / prev.liqUsd) : 0;
      if (dropPct > 0.10) hardRejects.push('liqDrop60s>10%');
    }
    liqTrack.set(mintKey, { liqUsd: liq, tsMs: nowMs });
  }

  // Exact requested BirdEye-native rules (migrate to contributors/penalties)
  const fallbackVolume = !!be?.fallbackMeta?.volume;
  const fallbackTx = !!be?.fallbackMeta?.tx;
  const volumeRising = fallbackVolume
    ? (volume5m >= (MOMENTUM_VOLUME_EXPANSION_MIN_RATIO_FALLBACK * Number(be.volume_30m_avg || 0)))
    : (volume5m > (MOMENTUM_VOLUME_EXPANSION_MIN_RATIO * Number(be.volume_30m_avg || 0)));
  const buyDominant = Number(be.buySellRatio || 0) > 1.1;
  const txRising = fallbackTx
    ? (Number(be.tx_1m || 0) >= (MOMENTUM_TX_ACCEL_MIN_RATIO_FALLBACK * Number(be.tx_5m_avg || 0)))
    : (Number(be.tx_1m || 0) > (MOMENTUM_TX_ACCEL_MIN_RATIO * Number(be.tx_5m_avg || 0)));
  const priceBreaking = Number(pair?.priceUsd || be.price || 0) >= Number(be.rolling_high_5m || 0);
  const walletExpansion = Number(be.walletExpansion || 0);
  const walletExpanding = walletExpansion > 1.20;

  // Scoring model config (env-driven with sane defaults)
  const preRunnerScoreThreshold = Number(process.env.MOMENTUM_SCORE_PRE_RUNNER_THRESHOLD || process.env.PRE_RUNNER_SCORE_THRESHOLD || 45);
  const momentumPassScoreThreshold = Number(process.env.MOMENTUM_SCORE_PASS_THRESHOLD || process.env.MOMENTUM_PASS_SCORE_THRESHOLD || 52);
  const strongMomentumScoreThreshold = Number(process.env.MOMENTUM_SCORE_STRONG_THRESHOLD || process.env.STRONG_MOMENTUM_SCORE_THRESHOLD || 75);

  // Component weights (sum not required; normalized later)
  const weights = {
    participation: {
      walletExpansionRatio: Number(process.env.W_WALLET_EXPANSION || 20),
      txAccelRatio: Number(process.env.W_TX_ACCEL || 18),
      buySellRatio: Number(process.env.W_BUY_SELL || 15),
    },
    priceBehavior: {
      ret1: Number(process.env.W_RET1 || 15),
      ret5: Number(process.env.W_RET5 || 12),
      accelerationRatio: Number(process.env.W_ACCEL || 5),
    },
    marketQuality: {
      volume5m: Number(process.env.W_V5M || 8),
      tx1h: Number(process.env.W_TX1H || 5),
      liquidityQuality: Number(process.env.W_LIQ || 2),
      mcapLiq: Number(process.env.W_MCLIQ || 3),
    },
  };

  // Normalize helpers
  function norm01(x, cap = Infinity) {
    if (!Number.isFinite(x)) return 0;
    if (cap === Infinity) return Math.max(0, x);
    return Math.max(0, Math.min(1, x / cap));
  }

  // Component raw scores (0-1) and sub-scores
  const comp = {};
  // Participation
  const walletExpansionRatio = Number(be.walletExpansion || 0) / Math.max(1, MOMENTUM_WALLET_EXPANSION_MIN_RATIO);
  const txAccelRatio = ratio(Number(be.tx_1m || 0), Math.max(1, Number(be.tx_5m_avg || 0)));
  const buySellRatio = Number(be.buySellRatio || 0);
  comp.walletExpansionRatio = norm01(walletExpansionRatio, 2);
  comp.txAccelRatio = norm01(txAccelRatio, 3);
  comp.buySellRatio = norm01(buySellRatio / 2, 1); // map >2 -> 1

  // Price behavior
  comp.ret1 = norm01(ret1 / 5, 1); // 5% is treated as full credit
  comp.ret5 = norm01(ret5 / 10, 1); // 10% is full credit
  comp.accelerationRatio = norm01(accelerationRatio / 2, 1);

  // Market quality
  comp.volume5m = norm01(volume5m / Math.max(1, Number(be.volume_30m_avg || 1)), 3);
  comp.tx1h = norm01(tx1h / Math.max(1, Number(be.tx_1h_avg || tx1h || 1)), 3);
  comp.liquidityQuality = norm01(liq / Math.max(1, MOMENTUM_HARD_LIQ_MIN_USD), 3);
  // lower mcap/liquidity is structurally better; invert into quality score
  comp.mcapLiq = (() => {
    if (!(mcLiqRatio != null && Number.isFinite(mcLiqRatio))) return 0;
    if (mcLiqRatio <= 3) return 1;
    if (mcLiqRatio <= 6) return 0.6;
    if (mcLiqRatio <= 8) return 0.2;
    if (mcLiqRatio <= 10) return 0.1;
    return 0;
  })();

  // Weighted aggregation
  const flatWeights = {
    walletExpansionRatio: weights.participation.walletExpansionRatio,
    txAccelRatio: weights.participation.txAccelRatio,
    buySellRatio: weights.participation.buySellRatio,
    ret1: weights.priceBehavior.ret1,
    ret5: weights.priceBehavior.ret5,
    accelerationRatio: weights.priceBehavior.accelerationRatio,
    volume5m: weights.marketQuality.volume5m,
    tx1h: weights.marketQuality.tx1h,
    liquidityQuality: weights.marketQuality.liquidityQuality,
    mcapLiq: weights.marketQuality.mcapLiq,
  };
  const weightSum = Object.values(flatWeights).reduce((s, v) => s + (Number(v) || 0), 0) || 1;
  const componentScores = {};
  Object.keys(flatWeights).forEach(k => {
    componentScores[k] = (Number(flatWeights[k]) || 0) * (Number(comp[k]) || 0) / weightSum * 100; // scaled to 0-100
  });
  const momentumScore = Math.round(Object.values(componentScores).reduce((s, v) => s + v, 0));

  // Penalties (weak negatives, not hard rejects unless safety-critical)
  const penalties = {};
  if (!volumeRising) penalties.volumeExpansion = MOMENTUM_SCORE_PENALTIES.weakVolumeExpansion;
  if (!buyDominant) penalties.buyPressure = MOMENTUM_SCORE_PENALTIES.weakBuyPressure;
  if (!txRising) penalties.txAcceleration = MOMENTUM_SCORE_PENALTIES.weakTxAcceleration;
  if (!walletExpanding) penalties.walletExpansion = MOMENTUM_SCORE_PENALTIES.weakWalletExpansion;
  if (ret1 < 0) penalties.negativeRet1 = MOMENTUM_SCORE_PENALTIES.negativeRet1;
  if (ret5 < 0) penalties.negativeRet5 = MOMENTUM_SCORE_PENALTIES.negativeRet5;
  if (mcLiqRatio != null && mcLiqRatio > 8.0) penalties.mcapLiquidityGt8 = MOMENTUM_SCORE_PENALTIES.mcapLiquidityGt8;
  else if (mcLiqRatio != null && mcLiqRatio > 6.0) penalties.mcapLiquidityGt6 = MOMENTUM_SCORE_PENALTIES.mcapLiquidityGt6;
  if (tx1h < MOMENTUM_MIN_ABS_TX1H_SOFT) penalties.lowAbsoluteTxActivity = MOMENTUM_SCORE_PENALTIES.lowAbsoluteTxActivity;
  if (volume5m < MOMENTUM_MIN_ABS_VOLUME_5M_SOFT) penalties.lowAbsoluteVolumeActivity = MOMENTUM_SCORE_PENALTIES.lowAbsoluteVolumeActivity;

  // Tiered momentum-stage liquidity penalty (while retaining ultra-thin hard reject)
  if (liq >= MOMENTUM_LIQ_PENALTY_BAND_1_MIN_USD && liq < MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD) {
    penalties.liquidity20kTo25k = MOMENTUM_SCORE_PENALTIES.liquidityBand20to25;
  } else if (liq >= MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD && liq < MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD) {
    penalties.liquidity25kTo30k = MOMENTUM_SCORE_PENALTIES.liquidityBand25to30;
  } else if (liq >= MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD && liq < MOMENTUM_LIQ_PENALTY_OFF_MIN_USD) {
    penalties.liquidity30kTo35k = MOMENTUM_SCORE_PENALTIES.liquidityBand30to35;
  }
  // Apply penalties by subtracting points
  const penaltyTotal = Object.values(penalties).reduce((s, v) => s + v, 0);
  let finalScore = Math.max(0, momentumScore - penaltyTotal);

  // Near-threshold boost to reduce early over-filtering without changing hard guards.
  const nearThresholdBoostApplied = (
    walletExpansion >= 1.35
    && txAccelRatio >= 1.15
    && buySellRatio >= 1.2
  );
  if (nearThresholdBoostApplied) finalScore += 2;

  // Bands
  const bands = {
    strong: finalScore >= strongMomentumScoreThreshold,
    moderate: finalScore >= momentumPassScoreThreshold && finalScore < strongMomentumScoreThreshold,
    weak: finalScore < momentumPassScoreThreshold,
  };

  // Build diagnostics: top contributors and penalties
  const sortedContrib = Object.entries(componentScores).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topContributors = sortedContrib.map(([k, v]) => ({ name: k, score: Math.round(v) }));
  const topPenalties = Object.entries(penalties).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ name: k, penalty: v }));

  // Determine ok by hard guards AND score threshold
  let ok = hardRejects.length === 0 && (finalScore >= momentumPassScoreThreshold);

  const failed = [];
  if (!volumeRising) failed.push('volumeExpansion');
  if (!buyDominant) failed.push('buyPressure');
  if (!txRising) failed.push('txAcceleration');
  if (!walletExpanding) failed.push('walletExpansion');

  const reasons = {
    ...be,
    liqUsd: liq,
    tx1h,
    volume5m,
    mcapUsd: Number.isFinite(mcapUsd) ? mcapUsd : null,
    mcLiqRatio: Number.isFinite(mcLiqRatio) ? mcLiqRatio : null,
    ret1,
    ret5,
    accelerationRatio,
    earlyAccelerationPositive,
    earlyRetComboPass, // retained for diagnostics but no longer auto-pass
    buyDominance,
    vol1m,
    spreadPct: Number.isFinite(spreadPct) ? spreadPct : null,
    walletExpansion,
    uniqueBuyers1m: Number(be.uniqueBuyers1m || 0),
    uniqueBuyers5mAvg: Number(be.uniqueBuyers5mAvg || 0),
    walletExpansionThreshold: 1.20,
    ageSec,
    positives: [volumeRising, buyDominant, txRising, walletExpanding].filter(Boolean).length,
    hardRejects,
    failedChecks: failed,
    ruleMode: 'weighted_momentum_score_with_hard_guards',
    momentumScore: finalScore,
    momentumScoreThreshold: momentumPassScoreThreshold,
    momentumScoreBand: bands.strong ? 'strong' : (bands.moderate ? 'moderate' : 'weak'),
    topScoreContributors: topContributors,
    topPenaltyContributors: topPenalties,
    momentumDiagnostics: {
      componentScores: Object.fromEntries(Object.entries(componentScores).map(([k, v]) => [k, Math.round(v)])),
      penalties,
      penaltyTotal,
      momentumScore: Math.round(momentumScore),
      nearThresholdBoostApplied,
      nearThresholdBoostPoints: nearThresholdBoostApplied ? 2 : 0,
      ratios: {
        walletExpansionRatio,
        txAccelRatio,
        buySellRatio,
      },
      finalScore,
      thresholds: {
        preRunnerScoreThreshold,
        momentumPassScoreThreshold,
        strongMomentumScoreThreshold,
      },
      scoreDistributionBands: {
        weakLt: momentumPassScoreThreshold,
        passGte: momentumPassScoreThreshold,
        strongGte: strongMomentumScoreThreshold,
      },
      weights: flatWeights,
      topContributors,
      topPenalties,
      bands,
    },
    momentumLiqGuardrailUsd: MOMENTUM_HARD_LIQ_MIN_USD,
    minimumActivitySoftThresholds: {
      tx1h: MOMENTUM_MIN_ABS_TX1H_SOFT,
      volume5m: MOMENTUM_MIN_ABS_VOLUME_5M_SOFT,
    },
    liquidityPenaltyBands: {
      hardRejectBelow: hardLiqGuardFloorUsd,
      hardGuardBufferUsd: MOMENTUM_HARD_LIQ_GUARD_BUFFER_USD,
      canonicalThresholdUsd: MOMENTUM_HARD_LIQ_MIN_USD,
      band20to25: { min: MOMENTUM_LIQ_PENALTY_BAND_1_MIN_USD, maxExclusive: MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD, penalty: MOMENTUM_SCORE_PENALTIES.liquidityBand20to25 },
      band25to30: { min: MOMENTUM_LIQ_PENALTY_BAND_2_MIN_USD, maxExclusive: MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD, penalty: MOMENTUM_SCORE_PENALTIES.liquidityBand25to30 },
      band30to35: { min: MOMENTUM_LIQ_PENALTY_BAND_3_MIN_USD, maxExclusive: MOMENTUM_LIQ_PENALTY_OFF_MIN_USD, penalty: MOMENTUM_SCORE_PENALTIES.liquidityBand30to35 },
      noPenaltyAtOrAbove: MOMENTUM_LIQ_PENALTY_OFF_MIN_USD,
    },
    liqHardGuardPassed: liq >= hardLiqGuardFloorUsd,
  };

  // Keep compatibility for fallback scoring/diagnostics
  reasons.v1h = Number(be.volume_5m || 0) * 12;
  reasons.volumeTarget = Math.max(1, Number(be.volume_30m_avg || 0));
  reasons.buys1h = Number(pair?.txns?.h1?.buys || 0);
  reasons.buyTarget = 1;
  reasons.pc1h = Number(pair?.priceChange?.h1 || 0);
  reasons.pc4h = Number(pair?.priceChange?.h4 || 0);
  reasons.tx1h = tx1h;

  const paper = fetchPaperMetricsFromBirdEye(pair, wsCache);
  if (paper) reasons.paper = paper;

  return { ok, reasons, thresholds: t };
}

export function evaluateMomentumSignal(pair, { profile = 'normal', strict = false } = {}) {
  const thresholds = getMomentumThresholds({ profile, strict });
  return momentumSignalWithThresholds(pair, thresholds);
}

export function canUseMomentumFallback(sig, { tolerance = 0.85 } = {}) {
  if (!sig || sig.ok) return false;
  const r = sig.reasons || {};

  const vScore = Math.min(1, ratio(Number(r.v1h || 0), Number(r.volumeTarget || 0) || 0));
  const bScore = Math.min(1, ratio(Number(r.buys1h || 0), Number(r.buyTarget || 0) || 0));
  const pScore = Math.min(1, Math.min(
    ratio(Number(r.pc1h || 0), Number(sig.thresholds?.pc1h || 0) || 0),
    ratio(Number(r.pc4h || 0), Number(sig.thresholds?.pc4h || 0) || 0),
  ));
  const tScore = Math.min(1, ratio(Number(r.tx1h || 0), Number(sig.thresholds?.tx1h || 0) || 0));

  const score = (0.25 * vScore) + (0.25 * bScore) + (0.25 * pScore) + (0.25 * tScore);
  return score >= Number(tolerance || 0.85);
}

export function momentumSignal(pair) {
  // Backward-compatible alias.
  return momentumSignalWithThresholds(pair, getMomentumThresholds({ profile: 'normal', strict: false }));
}

export function momentumSignalStrict(pair) {
  // Backward-compatible alias.
  return momentumSignalWithThresholds(pair, getMomentumThresholds({ profile: 'normal', strict: true }));
}
