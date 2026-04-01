// Simple Jupiter price fetcher (USD).
// Falls back to null if token is not supported.

const API_KEY = process.env.JUPITER_API_KEY || '';

export async function jupPriceUsd(mint) {
  if (!mint) return null;

  // Current Jupiter Price API endpoints.
  // - lite-api: public/no-key access
  // - api: API-key protected access
  const endpoints = [
    { base: 'https://lite-api.jup.ag/price/v3' },
    ...(API_KEY ? [{ base: 'https://api.jup.ag/price/v3' }] : []),
  ];

  for (const ep of endpoints) {
    const url = new URL(ep.base);
    url.searchParams.set('ids', mint);

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
    const p = json?.[mint]?.usdPrice ?? json?.data?.[mint]?.usdPrice;
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }

  return null;
}
