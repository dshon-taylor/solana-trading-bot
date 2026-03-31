import { estimateEquityUsd } from './stage_equity_estimation.mjs';

function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
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
