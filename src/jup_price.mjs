// Simple Jupiter price fetcher (USD).
// Falls back to null if token is not supported.

const API_KEY = process.env.JUPITER_API_KEY || '';

export async function jupPriceUsd(mint) {
  if (!mint) return null;

  // Prefer current Price V3 endpoints; keep legacy fallbacks for resiliency.
  const endpoints = [
    { base: 'https://lite-api.jup.ag/price/v3', v3: true },
    { base: 'https://api.jup.ag/price/v3', v3: true },
    { base: 'https://price.jup.ag/v6/price', v3: false },
    { base: 'https://api.jup.ag/price/v2', v3: false },
  ];

  for (const ep of endpoints) {
    const url = new URL(ep.base);
    url.searchParams.set('ids', mint);
    if (!ep.v3) {
      // Legacy API shape expected this for stable USD output.
      url.searchParams.set('vsToken', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    }

    const headers = { accept: 'application/json' };
    if (API_KEY) headers['x-api-key'] = API_KEY;

    let res;
    try {
      res = await fetch(url, { headers });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const json = await res.json().catch(() => null);
    const p = ep.v3
      ? (json?.[mint]?.usdPrice ?? json?.data?.[mint]?.usdPrice)
      : json?.data?.[mint]?.price;
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }

  return null;
}
