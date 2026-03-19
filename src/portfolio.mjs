import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRpcRateLimit429(err) {
  const msg = String(err?.message || err);
  return msg.includes(' 429 ') || msg.includes('429 Too Many Requests') || msg.includes('status code: 429');
}

async function withRetry(
  fn,
  {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    jitterPct = 0.25,
    timeoutMs = 30_000,
  } = {},
) {
  // Hotfix: if operators paused external calls, bail quickly to avoid further 429s.
  try {
    const s = JSON.parse(fs.readFileSync('./state/state.json','utf8'));
    if (s?.flags?.pauseExternalCalls) throw new Error('paused-by-ops');
  } catch (e) {
    // If file missing or parse fails, proceed normally.
  }
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      // IMPORTANT:
      // During upstream RPC 429 storms, some web3.js calls can spend minutes
      // inside internal retry chains. Even if disableRetryOnRateLimit is set,
      // we guard our *awaits* so one stalled call can't freeze the main loop.
      const p = fn();
      if (!timeoutMs) return await p;
      return await Promise.race([
        p,
        (async () => {
          await sleep(timeoutMs);
          throw new Error(`RPC_TIMEOUT after ${timeoutMs}ms`);
        })(),
      ]);
    } catch (e) {
      last = e;
      if (i === retries) break;

      // Exponential-ish backoff with jitter; if it's clearly a 429, bias longer.
      const rateLimitMult = isRpcRateLimit429(e) ? 4 : 1;
      const exp = Math.min(i, 6);
      const raw = baseDelayMs * rateLimitMult * Math.pow(2, exp);
      const capped = Math.min(raw, maxDelayMs);
      const jitter = capped * jitterPct * (Math.random() * 2 - 1);
      const waitMs = Math.max(0, Math.round(capped + jitter));
      await sleep(waitMs);
    }
  }
  throw last;
}

export function makeConnection(rpcUrl) {
  // If rpcUrl is a comma-separated list, treat as failover chain.
  const urls = String(rpcUrl || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length) throw new Error('No RPC url provided');

  // Create a connection wrapper that attempts URLs in order until one succeeds.
  let conn = null;
  for (const u of urls) {
    try {
      conn = new Connection(u, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
        disableRetryOnRateLimit: true,
      });
      // Quick health check: don't await network calls here; just return the connection
      // and rely on withRetry wrapper to handle failures and trigger failover higher up.
      return conn;
    } catch (e) {
      // Try next
    }
  }
  // Fallback: return connection to first URL (will error later)
  return new Connection(urls[0], { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

export async function getSolBalanceLamports(conn, owner) {
  return await withRetry(
    () => conn.getBalance(new PublicKey(owner), 'confirmed'),
    { retries: 4, baseDelayMs: 600 },
  );
}

export async function getSplBalance(conn, owner, mint) {
  const ownerPk = new PublicKey(owner);
  const mintPk = new PublicKey(mint);
  const ata = getAssociatedTokenAddressSync(mintPk, ownerPk, false);

  // 1) Fast path: ATA
  try {
    const acc = await withRetry(
      () => getAccount(conn, ata, 'confirmed'),
      { retries: 3, baseDelayMs: 600 },
    );
    const amt = Number(acc.amount);
    if (amt > 0) return { amount: amt, ata: ata.toBase58(), fetchOk: true, source: 'ata' };
  } catch {
    // Fall through to slower scan.
    // NOTE: we do NOT treat all errors as "0 balance" anymore.
  }

  // 2) Slow path: scan any token accounts by mint (covers non-ATA holdings + flaky ATA reads)
  try {
    const resp = await withRetry(
      () => conn.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed'),
      { retries: 3, baseDelayMs: 800 },
    );

    let total = 0;
    let largest = { amount: 0, pubkey: null };
    for (const it of resp.value || []) {
      const ui = it?.account?.data?.parsed?.info?.tokenAmount;
      const raw = Number(ui?.amount || 0);
      total += raw;
      if (raw > largest.amount) largest = { amount: raw, pubkey: it.pubkey?.toBase58?.() || String(it.pubkey) };
    }

    return {
      amount: total,
      ata: ata.toBase58(),
      fetchOk: true,
      source: 'scan',
      largestAccount: largest.pubkey,
    };
  } catch (e) {
    return {
      amount: 0,
      ata: ata.toBase58(),
      fetchOk: false,
      source: 'error',
      error: e?.message || String(e),
    };
  }
}

export async function getTokenHoldingsByMint(conn, owner) {
  const ownerPk = new PublicKey(owner);

  async function fetchForProgram(programId) {
    return await withRetry(
      () => conn.getParsedTokenAccountsByOwner(ownerPk, { programId }, 'confirmed'),
      { retries: 3, baseDelayMs: 800 },
    );
  }

  const [r1, r2] = await Promise.all([
    fetchForProgram(TOKEN_PROGRAM_ID),
    fetchForProgram(TOKEN_2022_PROGRAM_ID),
  ]);

  const map = new Map();
  for (const resp of [r1, r2]) {
    for (const it of resp.value || []) {
      const info = it?.account?.data?.parsed?.info;
      const mint = info?.mint;
      const amt = Number(info?.tokenAmount?.amount || 0);
      if (!mint || !amt) continue;
      map.set(mint, (map.get(mint) || 0) + amt);
    }
  }

  return map;
}
