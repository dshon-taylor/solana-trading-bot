const TOKENLIST_ALL = 'https://token.jup.ag/all';

export async function fetchJupTokenList(url = TOKENLIST_ALL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter token list failed: ${res.status}`);
  const arr = await res.json();
  // Normalize to minimal shape
  return (arr || []).map(t => ({
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    tags: t.tags || [],
    chainId: t.chainId,
  })).filter(t => !!t.address);
}
