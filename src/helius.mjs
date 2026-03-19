export async function heliusRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Helius RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Helius RPC error: ${json.error.message}`);
  return json.result;
}

export async function getTokenSupply(rpcUrl, mint) {
  // Uses standard Solana RPC method; Helius handles it.
  return await heliusRpc(rpcUrl, 'getTokenSupply', [mint]);
}
