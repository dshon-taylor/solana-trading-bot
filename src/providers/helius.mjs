export async function heliusRpc(rpcUrl, method, params) {
  // If Helius API key is not configured, avoid throwing an uncaught assertion
  // upstream. Return null and let callers handle missing data gracefully.
  const heliusKey = String(process.env.HELIUS_API_KEY || '').trim();
  if (!heliusKey) {
    console.warn('[helius] HELIUS_API_KEY not set; skipping heliusRpc and returning null');
    return null;
  }

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': heliusKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Helius RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Helius RPC error: ${json.error.message}`);
  return json.result;
}

export async function getTokenSupply(rpcUrl, mint) {
  // Uses standard Solana RPC method; Helius handles it.
  try {
    return await heliusRpc(rpcUrl, 'getTokenSupply', [mint]);
  } catch (err) {
    console.error('[helius] getTokenSupply error', err?.message || err);
    return null;
  }
}
