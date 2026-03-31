import { getSolBalanceLamports, getSplBalance } from '../../portfolio.mjs';
import { getTokenPairs, pickBestPair } from '../../dexscreener.mjs';

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
