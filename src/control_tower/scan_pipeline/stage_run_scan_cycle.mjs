export async function runScanCycle({
  t,
  cfg,
  state,
  conn,
  pub,
  counters,
  lastScan,
  nextScanDelayMs,
  lastSolUsd,
  lastSolUsdAt,
  lastLowSolAlertAt,
  dexCooldownUntil,
  birdseye,
  nowIso,
  tgSend,
  appendJsonl,
  appendDiagEvent,
  saveState,
  safeMsg,
  pushDebug,
  bump,
  getSolUsdPrice,
  getSolBalanceLamports,
  hitDex429,
  computeAdaptiveScanDelayMs,
  createScanCompactEventPusher,
  createScanCycleState,
  fetchCandidateSources,
  runScanPipeline,
  runEntryDispatch,
  sleepMs,
}) {
  if (t - lastScan < nextScanDelayMs) {
    return {
      ran: false,
      continueLoop: false,
      lastScan,
      nextScanDelayMs,
      lastSolUsd,
      lastSolUsdAt,
      lastLowSolAlertAt,
      dexCooldownUntil,
      counters,
    };
  }

  let nextLastScan = t;
  let nextNextScanDelayMs = nextScanDelayMs;
  let nextLastSolUsd = lastSolUsd;
  let nextLastSolUsdAt = lastSolUsdAt;
  let nextLastLowSolAlertAt = lastLowSolAlertAt;
  let nextDexCooldownUntil = dexCooldownUntil;
  let nextCounters = counters;
  let continueLoop = false;

  nextCounters.scanCycles += 1;
  const scanCycleStartedAtMs = Date.now();
  const prevScanAtMs = Number(nextCounters.scanLastAtMs || 0);
  const scanIntervalMs = prevScanAtMs > 0 ? Math.max(0, t - prevScanAtMs) : null;
  nextCounters.scanLastAtMs = t;
  const scanWatchlistIngestStart = Number(nextCounters?.watchlist?.ingested || 0);
  const scanPairFetchStart = Number(nextCounters?.pairFetch?.started || 0);
  const scanRateLimitedStart = Number(nextCounters?.pairFetch?.rateLimited || 0) + Number(nextCounters?.reject?.noPairReasons?.rateLimited || 0);
  const scanBirdeyeReqStart = Number(state?.marketData?.providers?.birdeye?.requests || 0);
  const scanCycle = createScanCycleState({
    cfg,
    counters: nextCounters,
    state,
    scanWatchlistIngestStart,
    scanPairFetchStart,
    scanBirdeyeReqStart,
  });

  const scanPhase = scanCycle.scanPhase;
  nextNextScanDelayMs = computeAdaptiveScanDelayMs({
    state,
    nowMs: t,
    baseScanMs: cfg.SCAN_EVERY_MS,
    maxScanMs: cfg.SCAN_BACKOFF_MAX_MS,
  });

  const pushScanCompactEvent = createScanCompactEventPusher({
    counters: nextCounters,
    cfg,
    appendJsonl,
  });

  try {
    try {
      if (birdseye && typeof birdseye.getStats === 'function') {
        const bs = birdseye.getStats(t) || {};
        if (bs.cuGuardEnabled && bs.cuBudgetExceeded) {
          const oldDelay = nextNextScanDelayMs;
          nextNextScanDelayMs = Math.min(cfg.SCAN_BACKOFF_MAX_MS || (5 * 60_000), Math.max(nextNextScanDelayMs * 2, nextNextScanDelayMs + cfg.SCAN_EVERY_MS));
          pushDebug(state, { t: nowIso(), reason: 'birdeye_cu_guard', oldDelay, newDelay: nextNextScanDelayMs });
          console.warn(`[scan] BirdEye CU budget exceeded -> slowing scans ${oldDelay}ms -> ${nextNextScanDelayMs}ms (projectedDailyCu=${bs.projectedDailyCu})`);
        }
      }
    } catch {}

    if (!cfg.DATA_CAPTURE_ENABLED) {
      // Data capture disabled explicitly.
    } else if (!cfg.SCANNER_TRACKING_ENABLED && !cfg.SCANNER_ENTRIES_ENABLED) {
      // Scanner fully disabled.
    } else {
      if (t < nextDexCooldownUntil) {
        await sleepMs(250);
        continueLoop = true;
      }

      let solUsdNow = null;
      if (!continueLoop) {
        const SOLUSD_TTL_MS = 5 * 60_000;
        if (nextLastSolUsd && (t - nextLastSolUsdAt) < SOLUSD_TTL_MS) {
          solUsdNow = nextLastSolUsd;
        } else {
          try {
            const _tSol = Date.now();
            solUsdNow = (await getSolUsdPrice()).solUsd;
            scanCycle.markCallDuration(_tSol);
            nextLastSolUsd = solUsdNow;
            nextLastSolUsdAt = t;
          } catch (e) {
            pushDebug(state, { t: nowIso(), mint: 'SOL', symbol: 'SOL', reason: `solUsdFetch(${safeMsg(e)})` });
            if (nextLastSolUsd) {
              solUsdNow = nextLastSolUsd;
              await tgSend(cfg, '⚠️ SOLUSD fetch rate-limited. Using cached SOLUSD and continuing.');
            } else {
              await tgSend(cfg, '⚠️ SOLUSD fetch failed (DexScreener rate limit). Cooling down before retry.');
              const { cooldownUntilMs } = hitDex429({
                state,
                nowMs: t,
                baseMs: 2 * 60_000,
                reason: 'solUsdFetch(DEXSCREENER_429?)',
                persist: () => saveState(cfg.STATE_PATH, state),
              });
              nextDexCooldownUntil = cooldownUntilMs;
              continueLoop = true;
            }
          }
        }
      }

      if (!continueLoop && solUsdNow != null) {
        const _tBal = Date.now();
        scanCycle.scanRpcCalls += 1;
        const solLam = await getSolBalanceLamports(conn, pub);
        scanCycle.markCallDuration(_tBal, 'rpc');
        const sol = solLam / 1e9;

        state.flags ||= {};
        if (sol < cfg.MIN_SOL_FOR_FEES) {
          state.flags.lowSolPauseEntries = true;
          bump(nextCounters, 'reject.lowSolFees');
          if (t - nextLastLowSolAlertAt > 30 * 60_000) {
            nextLastLowSolAlertAt = t;
            await tgSend(cfg, `⚠️ Low SOL balance for fees: ${sol.toFixed(4)} SOL (< ${cfg.MIN_SOL_FOR_FEES.toFixed(4)} SOL reserve). Pausing new entries until balance recovers.`);
          }
        } else {
          if (state.flags.lowSolPauseEntries) {
            state.flags.lowSolPauseEntries = false;
            await tgSend(cfg, `✅ SOL fee reserve recovered (${sol.toFixed(4)} SOL). New entries resumed.`);
          }

          const {
            boostedRaw,
            boosted,
            newDexCooldownUntil,
          } = await fetchCandidateSources({ t, scanPhase, solUsdNow, counters: nextCounters });
          if (newDexCooldownUntil != null) nextDexCooldownUntil = newDexCooldownUntil;

          const scanPipelineResult = await runScanPipeline({
            t,
            solUsdNow,
            boostedRaw,
            boosted,
            counters: nextCounters,
            scanPhase,
            scanRateLimitedStart,
            scanState: {
              scanCandidatesFound: scanCycle.scanCandidatesFound,
              scanPairFetchConcurrency: scanCycle.scanPairFetchConcurrency,
              scanJupCooldownActive: scanCycle.scanJupCooldownActive,
              scanJupCooldownRemainingMs: scanCycle.scanJupCooldownRemainingMs,
              scanRoutePrefilterDegraded: scanCycle.scanRoutePrefilterDegraded,
              scanUsableSnapshotWithoutPairCount: scanCycle.scanUsableSnapshotWithoutPairCount,
              scanNoPairTempActiveCount: scanCycle.scanNoPairTempActiveCount,
              scanNoPairTempRevisitCount: scanCycle.scanNoPairTempRevisitCount,
            },
            pushScanCompactEvent,
          });

          if (scanPipelineResult?.scanState) {
            scanCycle.applyScanState(scanPipelineResult.scanState);
          }

          if (scanPipelineResult?.skipCycle) {
            continueLoop = true;
          }

          if (!continueLoop) {
            const {
              probeEnabled,
              probeShortlist,
              executionAllowed,
              executionAllowedReason,
              routeAvailableImmediateRows,
            } = scanPipelineResult;

            const entryDispatchResult = await runEntryDispatch({
              t,
              solUsdNow,
              sol,
              counters: nextCounters,
              scanPhase,
              probeShortlist,
              probeEnabled,
              executionAllowed,
              executionAllowedReason,
              routeAvailableImmediateRows,
            });
            if (entryDispatchResult?.continueCycle) continueLoop = true;
          }
        }
      }
    }
  } finally {
    scanCycle.finalize({
      scanCycleStartedAtMs,
      scanIntervalMs,
      nextScanDelayMs: nextNextScanDelayMs,
      appendDiagEvent,
      appendJsonl,
    });
  }

  return {
    ran: true,
    continueLoop,
    lastScan: nextLastScan,
    nextScanDelayMs: nextNextScanDelayMs,
    lastSolUsd: nextLastSolUsd,
    lastSolUsdAt: nextLastSolUsdAt,
    lastLowSolAlertAt: nextLastLowSolAlertAt,
    dexCooldownUntil: nextDexCooldownUntil,
    counters: nextCounters,
  };
}
