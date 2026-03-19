const BASE = 'https://api.dexscreener.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithRetry(url, { retries = 3, baseDelayMs = 600 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited: back off.
        throw new Error('DEXSCREENER_429');
      }
      if (!res.ok) throw new Error(`DexScreener failed: ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i === retries) break;
      // Exponential-ish backoff.
      await sleep(baseDelayMs * (i + 1) * (String(e?.message || '').includes('429') ? 3 : 1));
    }
  }
  throw last;
}

export async function getBoostedTokens(kind = 'latest') {
  const url = kind === 'top'
    ? `${BASE}/token-boosts/top/v1`
    : `${BASE}/token-boosts/latest/v1`;
  const arr = await fetchJsonWithRetry(url, { retries: 2, baseDelayMs: 800 });
  return (arr || []).filter(x => x.chainId === 'solana');
}

export async function getTokenPairs(chainId, tokenAddress) {
  const url = `${BASE}/token-pairs/v1/${chainId}/${tokenAddress}`;
  return await fetchJsonWithRetry(url, { retries: 2, baseDelayMs: 800 });
}

export function pickBestPair(pairs) {
  if (!pairs?.length) return null;
  // Prefer USDC/SOL liquid pairs
  const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return sorted[0];
}
