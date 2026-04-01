import { formatThroughputSummary } from '../../core/metrics.mjs';
import { formatMarketDataProviderSummary } from '../../market_data_router.mjs';
import { formatWatchlistSummary } from '../watchlist_control.mjs';
import { formatTrackerIngestionSummary, formatTrackerSamplingBreakdown } from '../../tracker.mjs';

export function initializeDiagSnapshotState({ state }) {
  const DIAG_SNAPSHOT_EVERY_MS = Math.max(1_000, Number(process.env.DIAG_SNAPSHOT_EVERY_MS || 5_000));
  const runtime = {
    DIAG_SNAPSHOT_EVERY_MS,
    lastDiagSnapshotAt: 0,
    diagSnapshot: {
      updatedAtMs: 0,
      builtInMs: 0,
      message: '⏳ Diag snapshot warming…',
    },
  };
  try {
    const snapCarry = state?.runtime?.diagSnapshot || null;
    if (snapCarry && typeof snapCarry.message === 'string') {
      runtime.diagSnapshot = {
        updatedAtMs: Number(snapCarry.updatedAtMs || 0),
        builtInMs: Number(snapCarry.builtInMs || 0),
        message: snapCarry.message,
      };
    }
  } catch {}
  return runtime;
}

export function formatMomentumFailDiag({ state, nowMs }) {
  const mf = state.debug?.momentumFail || null;
  const windowMs = Number(mf?.windowMs || 0);
  const events = Array.isArray(mf?.events) ? mf.events : [];
  if (!windowMs || !events.length) return 'momentumFailed(checks): n/a';
  const cutoff = nowMs - windowMs;
  const counts = {};
  let nEvents = 0;
  for (const ev of events) {
    if (!ev || typeof ev.tMs !== 'number' || ev.tMs < cutoff) continue;
    nEvents += 1;
    for (const c of (ev.checks || [])) {
      const k = String(c || 'unknown');
      counts[k] = Number(counts[k] || 0) + 1;
    }
  }
  const top = Object.entries(counts)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 10)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ') || 'none';
  const windowMin = Math.round(windowMs / 60_000);
  return `momentumFailed(checks) last${windowMin}m events=${nEvents} top=${top}`;
}

export function formatBirdseyeLiteDiag({ birdseye, nowMs = Date.now() }) {
  if (!birdseye || typeof birdseye.getStats !== 'function') return null;
  const s = birdseye.getStats(nowMs) || {};
  const hitRate = (typeof s.cacheHitRate === 'number') ? `${(s.cacheHitRate * 100).toFixed(0)}%` : 'n/a';
  return [
    '• birdeyeLiteCache:',
    `  - ttlMs=${s.ttlMs} perMintMinIntervalMs=${s.perMintMinIntervalMs} size=${s.cacheSize}`,
    `  - cache hit=${s.cacheHits}/${Number(s.cacheHits || 0) + Number(s.cacheMisses || 0)}(${hitRate}) fetches=${s.fetches} fetchPerMin≈${s.fetchPerMin}`,
  ].join('\n');
}

export function createRefreshDiagSnapshot({ state, getCounters, cfg, birdseye, runtime }) {
  return function refreshDiagSnapshot(nowMs = Date.now()) {
    const counters = getCounters();
    const startedAt = Date.now();
    const elapsedHours = Math.max(1 / 60, (nowMs - Number(counters?.lastFlushAt || nowMs)) / 3_600_000);
    const preHotPassedPerDay = (Number(counters?.watchlist?.preHotPassed || 0) / elapsedHours) * 24;
    const preHotMinLiqActive = Number(state?.filterOverrides?.MIN_LIQUIDITY_FLOOR_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD ?? 0);
    const wlFunnel = counters?.watchlist?.funnelCumulative || {};
    const body = [
      `profile: aggressive=${cfg.AGGRESSIVE_MODE ? 'on' : 'off'} shortlistPrefilter=${cfg.EARLY_SHORTLIST_PREFILTER_MODE} forceAttemptOnConfirmPass=${cfg.FORCE_ATTEMPT_POLICY_ACTIVE ? 'on' : 'off'} canaryMode=${cfg.CONVERSION_CANARY_MODE ? 'on' : 'off'} debugCanary=${cfg.DEBUG_CANARY_ENABLED ? 'on' : 'off'}`,
      `canaryLatest=${JSON.stringify(state.debug?.canary?.latest || null)}`,
      formatMomentumFailDiag({ state, nowMs }),
      formatThroughputSummary({ counters, title: '📈 *Throughput* (cached in-memory snapshot)' }),
      `• preHot.liquidityThresholdActive=${Number.isFinite(preHotMinLiqActive) ? Math.round(preHotMinLiqActive) : 'n/a'}`,
      `• preHot: considered=${Number(counters?.watchlist?.preHotConsidered || 0)} passed=${Number(counters?.watchlist?.preHotPassed || 0)} failed=${Number(counters?.watchlist?.preHotFailed || 0)} liquidityFails=${Number(counters?.watchlist?.preHotFailedByReason?.liquidity || 0)} reasons=${Object.entries(counters?.watchlist?.preHotFailedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,10).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• preHot.missingFields: fetchAttempted=${Number(counters?.watchlist?.preHotMissingFetchAttempted || 0)} fetchSucceeded=${Number(counters?.watchlist?.preHotMissingFetchSucceeded || 0)} stillMissing=${Number(counters?.watchlist?.preHotMissingStillMissing || 0)}`,
      `• preRunner: tagged=${Number(counters?.watchlist?.preRunnerTagged || 0)} reachedMomentum=${Number(counters?.watchlist?.preRunnerReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.preRunnerReachedConfirm || 0)} reachedAttempt=${Number(counters?.watchlist?.preRunnerReachedAttempt || 0)} filled=${Number(counters?.watchlist?.preRunnerFilled || 0)} expired=${Number(counters?.watchlist?.preRunnerExpired || 0)} rejectedByReason=${Object.entries(counters?.watchlist?.preRunnerRejectedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• preRunner.last10=${(counters?.watchlist?.preRunnerLast10 || []).slice(-10).map((x)=>`${String(x?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(x?.liquidity||0))} txA=${Number(x?.txAccelRatio||0).toFixed(2)} wExp=${Number(x?.walletExpansionRatio||0).toFixed(2)} piExp=${Number(x?.priceImpactExpansionRatio||0).toFixed(2)} bsr=${Number(x?.buySellRatio||0).toFixed(2)} stage=${String(x?.finalStageReached||'tagged')}`).join(' | ') || 'none'}`,
      `• burst: tagged=${Number(counters?.watchlist?.burstTagged || 0)} reachedMomentum=${Number(counters?.watchlist?.burstReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.burstReachedConfirm || 0)} reachedAttempt=${Number(counters?.watchlist?.burstReachedAttempt || 0)} filled=${Number(counters?.watchlist?.burstFilled || 0)} expired=${Number(counters?.watchlist?.burstExpired || 0)} burstAvgTxAccel=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstTxAccelSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} burstAvgWalletExpansion=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstWalletExpansionSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} burstAvgBuySellRatio=${Number(counters?.watchlist?.burstTagged || 0) > 0 ? (Number(counters?.watchlist?.burstBuySellRatioSum || 0) / Number(counters?.watchlist?.burstTagged || 1)).toFixed(2) : '0.00'} rejectedByReason=${Object.entries(counters?.watchlist?.burstRejectedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• burst.last10=${(counters?.watchlist?.burstLast10 || []).slice(-10).map((x)=>`${String(x?.mint||'n/a').slice(0,6)} liq=${Math.round(Number(x?.liquidity||0))} txA=${Number(x?.txAccelRatio||0).toFixed(2)} wExp=${Number(x?.walletExpansionRatio||0).toFixed(2)} bsr=${Number(x?.buySellRatio||0).toFixed(2)} volExp=${Number(x?.volumeExpansionRatio||0).toFixed(2)} stage=${String(x?.finalStageReached||'tagged')}`).join(' | ') || 'none'}`,
      `• hot.mcapDeferred: missing=${Number(counters?.watchlist?.hotDeferredMissingMcap || 0)} recovered=${Number(counters?.watchlist?.hotDeferredRecovered || 0)} failed=${Number(counters?.watchlist?.hotDeferredFailed || 0)}`,
      `• hot.mcapNormalized: present=${Number(counters?.watchlist?.hotMcapNormalizedPresent || 0)} missing=${Number(counters?.watchlist?.hotMcapNormalizedMissing || 0)} sourceUsed=${Object.entries(counters?.watchlist?.hotMcapSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.mcapStaleRule: reject when freshnessMs > ${Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)}ms (non-fatal for liquidity-bypass stalking path)`,
      `• confirm.mcapStaleRule: reject when freshnessMs > ${Number(cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5000)}ms`,
      `• hot.enrichedRefresh: attempted=${Number(counters?.watchlist?.hotEnrichedRefreshAttempted || 0)} recovered=${Number(counters?.watchlist?.hotEnrichedRefreshRecovered || 0)} failed=${Number(counters?.watchlist?.hotEnrichedRefreshFailed || 0)} reasons=${Object.entries(counters?.watchlist?.hotEnrichedRefreshReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.enrichedRouteOnlyReachedMomentum=${Number(counters?.watchlist?.hotEnrichedRouteOnlyReachedMomentum || 0)}`,
      `• hot.liqMomentumBypass: allowed=${Number(counters?.watchlist?.hotLiqMomentumBypassAllowed || 0)} rejected=${Number(counters?.watchlist?.hotLiqMomentumBypassRejected || 0)} reachedMomentum=${Number(counters?.watchlist?.hotLiqBypassReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.hotLiqBypassReachedConfirm || 0)}`,
      `• hot.liqBypassPrimaryRejectReason=${Object.entries(counters?.watchlist?.hotLiqBypassPrimaryRejectReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,12).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.liqBypassSecondaryTags=${Object.entries(counters?.watchlist?.hotLiqBypassSecondaryTags || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,12).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.postBypassRejected: mcapMissing=${Number(counters?.watchlist?.hotPostBypassRejected?.mcapMissing || 0)} age=${Number(counters?.watchlist?.hotPostBypassRejected?.age || 0)} holders=${Number(counters?.watchlist?.hotPostBypassRejected?.holders || 0)} other=${Number(counters?.watchlist?.hotPostBypassRejected?.other || 0)} reachedMomentum=${Number(counters?.watchlist?.hotPostBypassReachedMomentum || 0)} reachedConfirm=${Number(counters?.watchlist?.hotPostBypassReachedConfirm || 0)} allowedStaleMcap=${Number(counters?.watchlist?.hotPostBypassAllowedStaleMcap || 0)}`,
      `• hot.liqBypassUnsafeCombos=${Object.entries(counters?.watchlist?.hotLiqBypassUnsafeCombo || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.bypassTrace.finalReasonCounts=${Object.entries(counters?.watchlist?.hotBypassTraceFinalReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,10).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• hot.bypassTrace.last10=${(counters?.watchlist?.hotBypassTraceLast10 || []).map(x=>`${x?.mint?.slice?.(0,6)||'n/a'}:${x?.decision||'n/a'}:${x?.next||'n/a'}:${x?.final||'ok'}`).join(' | ') || 'none'}`,
      `• momentum.breakoutRule=mature:3_of_4 early(<30m):2_of_3(priceBreak+buyPressure+paper)`,
      `• momentum.branchDecisionRule="early only if agePresent && ageMin<30; missing age uses strict/mature 3-of-4"`,
      `• momentum.earlyTokenMode=${Number(counters?.watchlist?.momentumEarlyTokenModeCount || 0)} momentum.matureTokenMode=${Number(counters?.watchlist?.momentumMatureTokenModeCount || 0)}`,
      `• momentum.agePresent=${Number(counters?.watchlist?.momentumAgePresent || 0)} momentum.ageMissing=${Number(counters?.watchlist?.momentumAgeMissing || 0)}`,
      `• momentum.ageSourceUsed=${Object.entries(counters?.watchlist?.momentumAgeSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.liqGuardrail=${Number(counters?.watchlist?.momentumLiqGuardrail || 60000)}`,
      `• momentum.liqCandidatesBelowGuardrail=${Number(counters?.watchlist?.momentumLiqCandidatesBelowGuardrail || 0)}`,
      `• momentum.liqCandidatesAboveGuardrail=${Number(counters?.watchlist?.momentumLiqCandidatesAboveGuardrail || 0)}`,
      `• momentum.breakoutSignalsPassed=${Number(counters?.watchlist?.momentumBreakoutSignalsPassed || 0)}`,
      `• momentum.breakoutSignalsFailed=${Number(counters?.watchlist?.momentumBreakoutSignalsFailed || 0)}`,
      `• momentum.inputCompleteness.present=${Number(counters?.watchlist?.momentumInputCompletenessPresent || 0)}`,
      `• momentum.inputCompleteness.missing=${Number(counters?.watchlist?.momentumInputCompletenessMissing || 0)}`,
      `• momentum.inputSourceUsed=${Object.entries(counters?.watchlist?.momentumInputSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.microFieldsPresent=${Number(counters?.watchlist?.momentumMicroFieldsPresent || 0)}`,
      `• momentum.microFieldsMissing=${Number(counters?.watchlist?.momentumMicroFieldsMissing || 0)}`,
      `• momentum.microSourceUsed=${Object.entries(counters?.watchlist?.momentumMicroSourceUsed || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.zeroSignalFallbackCount=${Number(counters?.watchlist?.momentumZeroSignalFallbackCount || 0)}`,
      `• momentum.failedChecksTop=${Object.entries(counters?.watchlist?.momentumFailedChecksTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,8).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.failedMintsTop=${Object.entries(counters?.watchlist?.momentumFailedMintsTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none'}`,
      `• momentum.failedCheckExamples=${(counters?.watchlist?.momentumFailedCheckExamples || []).slice(-3).map(x=>`${String(x?.mint||'n/a').slice(0,6)}[${Array.isArray(x?.checks)?x.checks.slice(0,3).join('|'):'none'}]`).join(' | ') || 'none'}`,
      `• momentum.inputDebugLast3=${(counters?.watchlist?.momentumInputDebugLast || []).slice(-3).map(x=>`${String(x?.mint||'n/a').slice(0,6)} raw(liq=${Number(x?.raw?.snapshot?.liquidityUsd ?? x?.raw?.latest?.liqUsd ?? 0)||0},mcap=${Number(x?.raw?.snapshot?.marketCapUsd ?? x?.raw?.latest?.mcapUsd ?? 0)||0}) norm(v5=${Number(x?.normalizedUsed?.volume5m||0)},bsr=${Number(x?.normalizedUsed?.buySellRatio||0)},tx1m=${Number(x?.normalizedUsed?.tx1m||0)},px=${Number(x?.normalizedUsed?.priceUsd||0)}) fail=[${Array.isArray(x?.failedChecks)?x.failedChecks.slice(0,3).join('|'):'none'}]`).join(' | ') || 'none'}`,
      `• momentum.repeatFailSuppressed=${Number(counters?.watchlist?.momentumRepeatFailSuppressed || 0)}`,
      `• momentum.repeatFailMintsTop=${Object.entries(counters?.watchlist?.momentumRepeatFailMintsTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${String(k).slice(0,6)}:${v}`).join(', ') || 'none'}`,
      `• momentum.repeatFailReasonTop=${Object.entries(counters?.watchlist?.momentumRepeatFailReasonTop || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• momentum.repeatFailWindowSec=180 (cooldownSec=120, escalation>=3 hits/900s => cooldownSec=900, improvementDelta>=0.05 on failed core checks)`,
      `• liqSafety.final: confirm.fullLiqRejected=${Number(counters?.watchlist?.confirmFullLiqRejected || 0)} confirm.mcapMissingRejected=${Number(counters?.watchlist?.confirmMcapMissingRejected || 0)} confirm.mcapStaleRejected=${Number(counters?.watchlist?.confirmMcapStaleRejected || 0)} confirm.ageMissingRejected=${Number(counters?.watchlist?.confirmAgeMissingRejected || 0)} attempt.fullLiqRejected=${Number(counters?.watchlist?.attemptFullLiqRejected || 0)}`,
      `• hot.progression: enq=${Number(counters?.watchlist?.hotEnqueued || 0)} cons=${Number(counters?.watchlist?.hotConsumed || 0)} momentum=${Number(wlFunnel.momentumPassed || 0)} confirm=${Number(wlFunnel.confirmPassed || 0)} attempt=${Number(wlFunnel.attempted || 0)} fill=${Number(wlFunnel.filled || 0)}`,
      `• watchlist.blockedTop(after-change)=${Object.entries(counters?.watchlist?.blockedByReason || {}).sort((a,b)=>Number(b[1]||0)-Number(a[1]||0)).slice(0,6).map(([k,v])=>`${k}:${v}`).join(', ') || 'none'}`,
      `• opportunities/day_preHotPassed est: ${preHotPassedPerDay.toFixed(1)}`,
      `• hotCap: evictions=${Number(counters?.watchlist?.capEvictions || 0)} rejectedDueToCap=${Number(counters?.watchlist?.rejectedDueToCap || 0)}`,
      '',
      formatMarketDataProviderSummary(state),
      formatBirdseyeLiteDiag({ birdseye, nowMs }) || '',
      '',
      formatWatchlistSummary({ state, counters, nowMs }),
      '',
      formatTrackerIngestionSummary({ cfg, state }),
      formatTrackerSamplingBreakdown({ state, nowMs }),
    ].join('\n');
    runtime.diagSnapshot = {
      updatedAtMs: nowMs,
      builtInMs: Math.max(0, Date.now() - startedAt),
      message: body,
    };
    try {
      state.runtime ||= {};
      state.runtime.diagCounters = JSON.parse(JSON.stringify(counters));
      state.runtime.diagSnapshot = {
        updatedAtMs: runtime.diagSnapshot.updatedAtMs,
        builtInMs: runtime.diagSnapshot.builtInMs,
        message: runtime.diagSnapshot.message,
      };
    } catch {}
    return runtime.diagSnapshot;
  };
}
