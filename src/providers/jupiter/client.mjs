import { fetchJsonWithRetry } from '../../lib/network/fetch_retry.mjs';

const API_KEY = process.env.JUPITER_API_KEY || '';
const API_BASE = API_KEY ? 'https://api.jup.ag/swap/v1' : 'https://lite-api.jup.ag/swap/v1';
const QUOTE = `${API_BASE}/quote`;
const SWAP = `${API_BASE}/swap`;

function authHeaders(extra = {}) {
  return API_KEY
    ? {
        'x-api-key': API_KEY,
        ...extra,
      }
    : { ...extra };
}

export async function jupQuote({ inputMint, outputMint, amount, slippageBps }) {
  const url = new URL(QUOTE);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  // Allow forcing direct-only routes via env or prefer direct routes on devnet.
  const preferDirect = (process.env.JUPITER_ONLY_DIRECT === 'true') || (process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL.includes('devnet'));
  const asLegacyTransaction = (process.env.JUPITER_AS_LEGACY_TRANSACTION || 'false') === 'true';
  url.searchParams.set('onlyDirectRoutes', preferDirect ? 'true' : 'false');
  if (asLegacyTransaction) url.searchParams.set('asLegacyTransaction', 'true');

  return await fetchJsonWithRetry(url, {
    headers: authHeaders({ accept: 'application/json' }),
    tag: 'JUPITER',
    retries: Number(process.env.JUPITER_HTTP_RETRIES || 3),
    baseDelayMs: Number(process.env.JUPITER_HTTP_BASE_DELAY_MS || 600),
    maxDelayMs: Number(process.env.JUPITER_HTTP_MAX_DELAY_MS || 10_000),
  });
}

export async function jupSwap({ quoteResponse, userPublicKey, wrapAndUnwrapSol = true }) {
  const asLegacyTransaction = (process.env.JUPITER_AS_LEGACY_TRANSACTION || 'false') === 'true';
  return await fetchJsonWithRetry(SWAP, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      asLegacyTransaction,
      // We'll handle priority fees later.
      dynamicComputeUnitLimit: true,
    }),
    tag: 'JUPITER',
    retries: Number(process.env.JUPITER_HTTP_RETRIES || 3),
    baseDelayMs: Number(process.env.JUPITER_HTTP_BASE_DELAY_MS || 600),
    maxDelayMs: Number(process.env.JUPITER_HTTP_MAX_DELAY_MS || 10_000),
  });
}

// Perform a lightweight preflight check to verify Jupiter API headers and basic reachability.
export async function jupiterPreflight() {
  try {
    const url = new URL(QUOTE);
    // use a harmless parameter set (amount small) — we only check headers/response status
    url.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112');
    url.searchParams.set('outputMint', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    url.searchParams.set('amount', '1');
    url.searchParams.set('slippageBps', '100');

    const res = await fetchJsonWithRetry(url, {
      headers: authHeaders({ accept: 'application/json' }),
      tag: 'JUPITER_PREFLIGHT',
      retries: 1,
      baseDelayMs: 100,
      maxDelayMs: 500,
    });

    if (!res || res?.status === 'error') {
      return { ok: false, reason: res?.message || 'jupiter preflight returned error' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

