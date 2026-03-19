export async function probePoolLiquidity(mint, { rpcClient = null } = {}) {
  // Minimal stub: in real impl this would query on-chain pools via RPC and compute liquidity USD.
  // Return shape: { liquidityUsd: number|null, source: 'onchain', timestampMs }
  return { liquidityUsd: null, source: 'onchain', timestampMs: Date.now() };
}
