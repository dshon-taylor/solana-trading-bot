import { getTokenHoldingsByMint } from '../../trading/portfolio.mjs';
import { nowIso } from '../../observability/logger.mjs';
import { applyMomentumDefaultsToPosition } from '../position_policy.mjs';
import { syncExposureStateWithPositions } from './stage_exposure_sync.mjs';

export async function reconcilePositions({ cfg, conn, ownerPubkey, state }) {
  const holdings = await getTokenHoldingsByMint(conn, ownerPubkey);

  for (const [mint, pos] of Object.entries(state.positions || {})) {
    const amt = holdings.get(mint) || 0;

    if (amt > 0) {
      if (pos.status !== 'open') {
        pos.status = 'open';
        delete pos.exitAt;
        delete pos.exitReason;
        delete pos.exitTx;
      }
      applyMomentumDefaultsToPosition(cfg, pos);
    } else if (pos.status === 'open') {
      pos.status = 'closed';
      pos.exitAt = nowIso();
      pos.exitReason = 'reconciled: no on-chain token holdings';
    }
  }

  if (Object.keys(state.positions || {}).length) {
    for (const [mint, amt] of holdings.entries()) {
      if (!state.positions[mint]) {
        state.positions[mint] = {
          status: 'open',
          mint,
          symbol: null,
          decimals: null,
          pairUrl: null,
          entryAt: nowIso(),
          entryPriceUsd: null,
          peakPriceUsd: null,
          trailingActive: false,
          stopAtEntry: true,
          stopPriceUsd: null,
          trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
          trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
          lastStopUpdateAt: nowIso(),
          lastSeenPriceUsd: null,
          note: `reconciled: found on-chain balance=${amt}`,
          exitPending: true,
        };
      }
    }
  }

  const retentionDays = Math.max(1, Number(process.env.CLOSED_POSITION_RETENTION_DAYS || 14));
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60_000);
  let prunedClosedPositions = 0;
  for (const [mint, pos] of Object.entries(state.positions || {})) {
    if (!pos || pos.status !== 'closed') continue;
    if (pos.exitPending === true) continue;
    if (Number(holdings.get(mint) || 0) > 0) continue;
    const exitAtMs = Date.parse(String(pos.exitAt || ''));
    if (!Number.isFinite(exitAtMs) || exitAtMs <= 0) continue;
    if (exitAtMs > cutoffMs) continue;
    delete state.positions[mint];
    prunedClosedPositions += 1;
  }

  const exposure = syncExposureStateWithPositions({ cfg, state });
  return {
    prunedClosedPositions,
    openCount: exposure.openCount,
    activeRunnerCount: exposure.activeRunnerCount,
  };
}
