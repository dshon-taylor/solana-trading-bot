import { saveState } from '../../core/state.mjs';
export { announceBootStatus } from './stage_boot_announce.mjs';

export async function seedOpenPositionsOnBoot({ state, cfg, wsmgr, cache, birdseye, closePosition, conn, wallet }) {
  try {
    for (const [mint, pos] of Object.entries(state.positions || {})) {
      if (pos?.status !== 'open') continue;
      try {
        wsmgr.onFill(mint, {
          entryPrice: Number(pos.entryPriceUsd || 0) || null,
          stopPrice: Number(pos.stopPriceUsd || 0) || null,
          stopPct: null,
          trailingPct: Number(pos?.trailDistancePct || 0) || null,
        });
      } catch {}
      try {
        cache.set(`birdeye:sub:${mint}`, true, Math.ceil((cfg.BIRDEYE_LITE_CACHE_TTL_MS || 45000) / 1000));
      } catch {}

      try {
        const snap = await birdseye.getTokenSnapshot(mint);
        const px = Number(snap?.priceUsd || 0);
        const st = Number(pos?.stopPriceUsd || 0);
        if (px > 0 && st > 0 && px <= st) {
          const pairBoot = { baseToken: { symbol: pos?.symbol || null }, priceUsd: px, url: pos?.pairUrl || null };
          const rr = pos?.trailingActive
            ? `trailing stop hit @ ${px.toFixed(6)} <= ${st.toFixed(6)} (boot_reconcile)`
            : `stop hit @ ${px.toFixed(6)} <= ${st.toFixed(6)} (boot_reconcile)`;
          await closePosition(cfg, conn, wallet, state, mint, pairBoot, rr);
          saveState(cfg.STATE_PATH, state);
        }
      } catch {}
    }
  } catch {}
}

export async function resolveBootSolUsdWithRetry({ getSolUsdPrice, tgSend, cfg, safeMsg }) {
  let solUsd;
  let bootPriceWarned = false;
  while (!solUsd) {
    try {
      solUsd = (await getSolUsdPrice()).solUsd;
      if (!solUsd) {
        if (!bootPriceWarned) {
          bootPriceWarned = true;
          await tgSend(cfg, '⚠️ SOLUSD unavailable at boot (empty snapshot). Cooling down and retrying...');
        }
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } catch (e) {
      if (!bootPriceWarned) {
        bootPriceWarned = true;
        await tgSend(cfg, `⚠️ SOLUSD fetch failed at boot (${safeMsg(e)}). Cooling down and retrying...`);
      }
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
  return solUsd;
}

export async function sendBootBalancesMessage({ cfg, conn, pub, solUsd, getSolBalanceLamports, tgSend, fmtUsd }) {
  const solLamports = await getSolBalanceLamports(conn, pub);
  await tgSend(cfg, [
    '📊 *Balances*',
    '',
    `• SOL: ${(solLamports / 1e9).toFixed(4)}`,
    `• SOLUSD: $${solUsd.toFixed(2)}`,
    `• Equity≈: ${fmtUsd((solLamports / 1e9) * solUsd)}`,
  ].join('\n'));
}

export async function reconcileStartupState({ cfg, conn, pub, state, reconcilePositions, positionCount, syncExposureStateWithPositions, safeErr }) {
  try {
    const anyOpen = Object.values(state.positions || {}).some((p) => p?.status === 'open');
    if (anyOpen) {
      const reconcileSummary = await reconcilePositions({ cfg, conn, ownerPubkey: pub, state });
      saveState(cfg.STATE_PATH, state);
      console.log(`[startup] reconciled open positions: now open=${positionCount(state)} prunedClosed=${Number(reconcileSummary?.prunedClosedPositions || 0)} activeRunners=${Number(reconcileSummary?.activeRunnerCount || 0)}`);
    }
  } catch (e) {
    console.warn('[startup] reconcilePositions failed (continuing):', safeErr(e).message);
  }
  try {
    syncExposureStateWithPositions({ cfg, state });
  } catch {}
}
