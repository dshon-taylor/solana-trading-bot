// Simple Jupiter price fetcher (USD).
// Falls back to null if token is not supported.

export async function jupPriceUsd(mint) {
  if (!mint) return null;

  // Jupiter has moved domains before; keep a small fallback list to avoid total outages.
  const urls = [
    'https://price.jup.ag/v6/price',
    'https://api.jup.ag/price/v2',
  ];

  for (const base of urls) {
    const url = new URL(base);
    url.searchParams.set('ids', mint);
    // ask for vsToken=USDC explicitly for stability
    url.searchParams.set('vsToken', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const json = await res.json().catch(() => null);
    const p = json?.data?.[mint]?.price;
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) continue;
    return n;
  }

  return null;
}
