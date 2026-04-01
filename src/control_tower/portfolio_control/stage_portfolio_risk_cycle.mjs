import { enforcePortfolioStopGate } from './stage_enforce_portfolio_stop.mjs';

export async function runPortfolioRiskCycle({
  t,
  cfg,
  conn,
  pub,
  state,
  nowIso,
  tgSend,
  shouldStopPortfolio,
  circuitClear,
  circuitHit,
  recordPlaybookError,
  saveState,
  safeErr,
  lastRpcAlertRef,
  getSolUsdPrice,
}) {
  let solPrice;
  try {
    solPrice = (await getSolUsdPrice()).solUsd;
  } catch {
    solPrice = null;
  }

  const portfolioGate = await enforcePortfolioStopGate({
    cfg,
    conn,
    pub,
    state,
    solPrice,
    nowMs: t,
    nowIso,
    tgSend,
    shouldStopPortfolio,
    circuitClear,
    circuitHit,
    recordPlaybookError,
    saveState,
    safeErr,
    lastRpcAlertRef,
  });

  return {
    halted: !!portfolioGate?.halted,
    solPrice,
  };
}

