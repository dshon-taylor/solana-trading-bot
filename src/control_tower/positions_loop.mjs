/**
 * positions_loop.mjs
 *
 * Factory for the positions enforcement loop.
 * Owns the in-flight guard and delegates to the caller's lastPosRef for cross-loop
 * timestamp coordination.
 *
 * Usage:
 *   const { runPositionsLoop } = createPositionsLoop({ ..., lastPosRef });
 *   startPositionsLoopTimer({ globalTimers, cfg, runPositionsLoop, lastPosRef }); // via runtime_timers.mjs
 */

export function createPositionsLoop({
  cfg,
  state,
  cache,
  conn,
  wallet,
  birdseye,
  lastPosRef,
  closePosition,
  updateStops,
  tgSend,
  saveState,
  pushDebug,
  nowIso,
  computePreTrailStopPrice,
  conservativeExitMark,
  isStopSnapshotUsable,
  tokenDisplayName,
  getMarketSnapshot,
  getTokenPairs,
  pickBestPair,
  safeErr,
}) {
  let _positionsLoopInFlight = false;

  async function runPositionsLoop(t) {
    if (_positionsLoopInFlight) return;
    _positionsLoopInFlight = true;
    lastPosRef.value = t;
    try {
      for (const [mint, pos] of Object.entries(state.positions)) {
        if (pos.status !== 'open') continue;

        // Streaming-first stop enforcement: use fresh BirdEye WS tick immediately.
        try {
          const ws = cache.get(`birdeye:ws:price:${mint}`) || null;
          const wsTs = Number(ws?.tsMs || 0);
          const wsPrice = Number(ws?.priceUsd || 0);
          const wsFresh = wsTs > 0 && (Date.now() - wsTs) <= 15_000;
          if (wsFresh && wsPrice > 0 && Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(wsPrice, pos, null, cfg) <= Number(pos.stopPriceUsd)) {
            const pairWs = { baseToken: { symbol: pos?.symbol || null }, priceUsd: wsPrice, url: pos?.pairUrl || null };
            const r = pos.trailingActive
              ? `trailing stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`
              : `stop hit @ ${wsPrice.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (ws)`;
            await closePosition(cfg, conn, wallet, state, mint, pairWs, r);
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch {}

        // Reconcile baseline stop policy for non-trailing positions.
        const e0 = Number(pos.entryPriceUsd || 0);
        const trailing0 = !!pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct));
        if (e0 > 0 && !trailing0) {
          const nowMs0 = Date.now();
          const entryAtMs0 = Date.parse(String(pos.entryAt || '')) || nowMs0;
          const targetStop0 = computePreTrailStopPrice({
            entryPriceUsd: e0,
            entryAtMs: entryAtMs0,
            nowMs: nowMs0,
            armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
            prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
            stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
          });
          if (!Number.isFinite(Number(pos.stopPriceUsd)) || Number(pos.stopPriceUsd) < targetStop0) {
            pos.stopPriceUsd = targetStop0;
            pos.lastStopUpdateAt = nowIso();
            pos.lastStopPrice = targetStop0;
            saveState(cfg.STATE_PATH, state);
          }
        }

        // Direct BirdEye reconcile pass for live positions (bypass router/LKG bias).
        try {
          const direct = await birdseye?.getTokenSnapshot?.(mint);
          const directPx = Number(direct?.priceUsd || 0);
          if (directPx > 0 && Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(directPx, pos, null, cfg) <= Number(pos.stopPriceUsd)) {
            const pairDirect = { baseToken: { symbol: pos?.symbol || null }, priceUsd: directPx, url: pos?.pairUrl || null };
            const rr = pos.trailingActive
              ? `trailing stop hit @ ${directPx.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (direct_birdeye)`
              : `stop hit @ ${directPx.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (direct_birdeye)`;
            await closePosition(cfg, conn, wallet, state, mint, pairDirect, rr);
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch (e) {
          console.warn('[direct_birdeye_reconcile] failed', mint, safeErr(e).message);
        }

        const snapshot = await getMarketSnapshot({
          state,
          mint,
          nowMs: t,
          maxAgeMs: cfg.PAIR_CACHE_MAX_AGE_MS,
          preferWsPrice: true,
          getTokenPairs,
          pickBestPair,
          birdeyeEnabled: birdseye?.enabled,
          getBirdseyeSnapshot: birdseye?.getTokenSnapshot,
        });

        let effectiveSnapshot = snapshot;
        if (!effectiveSnapshot?.priceUsd) {
          // Fallback: direct Dex fetch for open-position safety if router has no usable price.
          try {
            const pairsFallback = await getTokenPairs(mint);
            const bestFallback = pickBestPair(pairsFallback);
            const pxFallback = Number(bestFallback?.priceUsd || 0);
            if (pxFallback > 0) {
              effectiveSnapshot = {
                source: 'dex_fallback',
                confidence: 'low',
                freshnessMs: 0,
                priceUsd: pxFallback,
                pair: bestFallback,
              };
            }
          } catch {}
        }
        if (!effectiveSnapshot?.priceUsd) {
          pushDebug(state, {
            t: nowIso(),
            mint,
            symbol: pos?.symbol || null,
            reason: `positionsMarketData(skip_no_price src=${snapshot?.source || 'none'} conf=${snapshot?.confidence || 'none'} freshMs=${snapshot?.freshnessMs ?? 'n/a'})`,
          });
          continue;
        }

        const pair = effectiveSnapshot?.pair || { baseToken: { symbol: pos?.symbol || null }, priceUsd: effectiveSnapshot.priceUsd };
        const priceUsd = Number(effectiveSnapshot.priceUsd);

        // Stop has priority over time-stop labeling.
        if (Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= Number(pos.stopPriceUsd)) {
          const r = pos.trailingActive
            ? `trailing stop hit @ ${priceUsd.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (cycle_reconcile)`
            : `stop hit @ ${priceUsd.toFixed(6)} <= ${Number(pos.stopPriceUsd).toFixed(6)} (cycle_reconcile)`;
          await closePosition(cfg, conn, wallet, state, mint, pair, r);
          saveState(cfg.STATE_PATH, state);
          continue;
        }

        // Early failure kill: if still below entry after 60-90s, cut quickly.
        try {
          if (cfg.EARLY_FAILURE_KILL_ENABLED) {
            const entryTs = Date.parse(pos.entryAt) || 0;
            const entryPrice = Number(pos.entryPriceUsd || 0) || null;
            if (entryTs && entryPrice && entryPrice > 0) {
              if (!Number.isFinite(Number(pos.earlyFailureDeadlineMs))) {
                const minMs = Number(cfg.EARLY_FAILURE_KILL_MIN_MS || 60_000);
                const maxMs = Math.max(minMs, Number(cfg.EARLY_FAILURE_KILL_MAX_MS || 90_000));
                const jitterVal = Math.floor(minMs + (Math.random() * (maxMs - minMs)));
                pos.earlyFailureDeadlineMs = entryTs + jitterVal;
              }
              const deadlineMs = Number(pos.earlyFailureDeadlineMs || 0);
              if (deadlineMs > 0 && Date.now() >= deadlineMs && priceUsd < entryPrice) {
                await closePosition(cfg, conn, wallet, state, mint, pair, 'early-failure kill (below entry after 60-90s)');
                saveState(cfg.STATE_PATH, state);
                continue;
              }
            }
          }
        } catch (e) {
          // best-effort only; do not throw
        }

        // Secondary time-stop: after 4 minutes, if still weak (<+2%).
        try {
          const entryTs = Date.parse(pos.entryAt) || 0;
          const ageMs = Date.now() - entryTs;
          const entryPrice = Number(pos.entryPriceUsd || 0) || null;
          const profitPct = (entryPrice && entryPrice > 0) ? ((priceUsd - entryPrice) / entryPrice) : null;
          if (entryTs && ageMs >= (4 * 60_000) && (profitPct == null || profitPct < 0.02)) {
            await closePosition(cfg, conn, wallet, state, mint, pair, 'time-stop weak momentum');
            saveState(cfg.STATE_PATH, state);
            continue;
          }
        } catch (e) {
          // best-effort only; do not throw
        }

        // IMPORTANT: even if the snapshot is stale/low-confidence, we still want to enforce stops.
        // Otherwise, a rapid dump during data issues can bypass exits entirely.
        const usableForTrailing = isStopSnapshotUsable(effectiveSnapshot);
        if (!usableForTrailing) {
          pushDebug(state, {
            t: nowIso(),
            mint,
            symbol: pos?.symbol || null,
            reason: `positionsMarketData(stale_ok_for_stop src=${effectiveSnapshot?.source || 'none'} conf=${effectiveSnapshot?.confidence || 'none'} freshMs=${effectiveSnapshot?.freshnessMs ?? 'n/a'})`,
          });
          if (Number.isFinite(Number(pos.stopPriceUsd)) && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= Number(pos.stopPriceUsd)) {
            const r = pos.trailingActive ? 'trailing stop hit (stale snapshot)' : 'stop loss hit (stale snapshot)';
            await closePosition(cfg, conn, wallet, state, mint, pair, r);
            saveState(cfg.STATE_PATH, state);
          }
          continue;
        }

        // Repair missing entry/stop fields if we opened a position without a valid entry snapshot.
        if (!Number.isFinite(Number(pos.entryPriceUsd)) || Number(pos.entryPriceUsd) <= 0) {
          pos.entryPriceUsd = priceUsd;
          pos.peakPriceUsd = priceUsd;
          pos.lastSeenPriceUsd = priceUsd;
          pos.stopPriceUsd = priceUsd;
          pos.lastStopUpdateAt = nowIso();
          pos.note = (pos.note || '') + ` | repairedEntryPriceFromPriceFeed`;
          const label = tokenDisplayName({ name: pos?.tokenName, symbol: pos?.symbol, mint });
          await tgSend(cfg, `🛠️ Repaired missing entry price for ${label} using live price ${priceUsd.toFixed(6)}. New stop set to ${pos.stopPriceUsd.toFixed(6)}.`);
          saveState(cfg.STATE_PATH, state);
        }

        // Enforce trailing stop updates.
        const upd = await updateStops(cfg, state, mint, priceUsd);

        // Stop-loss exit.
        if (pos.stopPriceUsd && conservativeExitMark(priceUsd, pos, effectiveSnapshot, cfg) <= pos.stopPriceUsd) {
          await closePosition(cfg, conn, wallet, state, mint, pair, `stop hit @ ${priceUsd.toFixed(6)} <= ${pos.stopPriceUsd.toFixed(6)}`);
          saveState(cfg.STATE_PATH, state);
          continue;
        }

        // Optional: if we changed stop and want alerts, existing code handles elsewhere.
        if (upd?.changed) {
          // noop; position state already updated
        }
      }
    } catch (e) {
      console.warn('[positionsLoop] error', safeErr(e).message);
    } finally {
      _positionsLoopInFlight = false;
    }
  }

  return { runPositionsLoop };
}
