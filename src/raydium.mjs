// Raydium v3 API — pool data for alternative routeability checks.
// Used as a fallback when Jupiter is rate-limited or returns no route.
// NOTE: This module is for routeability heuristics only. Swap execution
// always goes through Jupiter directly.

const BASE = 'https://api-v3.raydium.io';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, { retries = 2, baseDelayMs = 800 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const e = new Error('RAYDIUM_429');
        e.status = 429;
        throw e;
      }
      if (!res.ok) {
        const e = new Error(`Raydium API failed: ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const json = await res.json();
      if (!json?.success) throw new Error('Raydium API returned success=false');
      return json;
    } catch (e) {
      last = e;
      if (i === retries) break;
      await sleep(baseDelayMs * (i + 1) * (e?.status === 429 ? 3 : 1));
    }
  }
  throw last;
}

/**
 * Fetch all Raydium pools that include `mint`, sorted by TVL descending.
 * Returns an array of pool objects (may be empty).
 */
export async function getRaydiumPools(mint) {
  const url = `${BASE}/pools/info/mint?mint1=${encodeURIComponent(mint)}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1`;
  const data = await fetchJson(url);
  return data?.data?.data || [];
}

/**
 * Pick the highest-TVL pool from a list of Raydium pool objects.
 */
export function pickBestRaydiumPool(pools) {
  if (!pools?.length) return null;
  return [...pools].sort((a, b) => Number(b.tvl || 0) - Number(a.tvl || 0))[0] || null;
}
