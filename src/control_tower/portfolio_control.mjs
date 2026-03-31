import { getSolBalanceLamports, getSplBalance, getTokenHoldingsByMint } from '../portfolio.mjs';
import { getTokenPairs, pickBestPair } from '../dexscreener.mjs';
import { nowIso } from '../logger.mjs';
import { applyMomentumDefaultsToPosition } from './position_policy.mjs';

function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function syncExposureStateWithPositions({ cfg, state }) {
  state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
  const openCount = Object.values(state.positions || {}).filter((p) => p?.status === 'open').length;
  const maxActive = Math.max(1, Number(cfg?.MAX_ACTIVE_RUNNERS || 3));
  state.exposure.activeRunnerCount = Math.max(0, Math.min(openCount, maxActive));
  return { openCount, activeRunnerCount: state.exposure.activeRunnerCount };
}

export async function estimateEquityUsd(cfg, conn, owner, state, solUsd) {
  const solLamports = await getSolBalanceLamports(conn, owner);
  const sol = solLamports / 1e9;
  let equityUsd = sol * solUsd;

  for (const [mint, pos] of Object.entries(state.positions || {})) {
    if (pos.status !== 'open') continue;
    try {
      const tokenBal = await getSplBalance(conn, owner, mint);
      const amt = tokenBal.amount;
      if (!amt || amt <= 0) continue;

      const pairs = await getTokenPairs('solana', mint);
      const pair = pickBestPair(pairs);
      const priceUsd = Number(pair?.priceUsd || 0);
      const decimals = typeof pos.decimals === 'number' ? pos.decimals : (pair?.baseToken?.decimals ?? null);

      if (typeof decimals !== 'number') continue;
      const ui = amt / (10 ** decimals);
      equityUsd += ui * priceUsd;
    } catch {}
  }

  return { equityUsd, solLamports };
}

export async function shouldStopPortfolio(cfg, conn, owner, state, solUsd) {
  const { equityUsd } = await estimateEquityUsd(cfg, conn, owner, state, solUsd);

  if (cfg.PORTFOLIO_STOP_USDC <= 0 && cfg.MAX_DRAWDOWN_PCT >= 1) {
    return { stop: false, reason: 'portfolio guards disabled', equityUsd };
  }

  state.portfolio.maxEquityUsd = Math.max(state.portfolio.maxEquityUsd || equityUsd, equityUsd);
  const maxEquity = state.portfolio.maxEquityUsd;

  if (equityUsd < cfg.PORTFOLIO_STOP_USDC) {
    return { stop: true, reason: `portfolio stop: equity ${fmtUsd(equityUsd)} < ${fmtUsd(cfg.PORTFOLIO_STOP_USDC)}`, equityUsd };
  }

  const drawdown = maxEquity > 0 ? (maxEquity - equityUsd) / maxEquity : 0;
  if (drawdown >= cfg.MAX_DRAWDOWN_PCT) {
    return { stop: true, reason: `max drawdown hit: ${(drawdown * 100).toFixed(1)}%`, equityUsd };
  }

  return { stop: false, reason: 'ok', equityUsd };
}

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
    } else {
      if (pos.status === 'open') {
        pos.status = 'closed';
        pos.exitAt = nowIso();
        pos.exitReason = 'reconciled: no on-chain token holdings';
      }
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
