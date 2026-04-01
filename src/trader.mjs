import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { jupQuote, jupSwap } from './providers/jupiter/client.mjs';

export const DECIMALS = {
  // Solana mainnet USDC
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
  So11111111111111111111111111111111111111112: 9,
};

const DEFAULT_CONFIRM_OPTS = {
  commitment: 'confirmed',
  wsTimeoutMs: 12_000,
  pollMaxMs: 45_000,
  pollStartMs: 600,
  pollMaxIntervalMs: 4_000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenDeltaForOwner(tx, ownerBase58, mint) {
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const toKey = (v) => `${v?.accountIndex ?? 'x'}:${String(v?.mint || '')}`;
  const preMap = new Map(pre.map((b) => [toKey(b), b]));
  const postMap = new Map(post.map((b) => [toKey(b), b]));
  let deltaRaw = 0;
  let decimals = null;

  for (const b of post) {
    const owner = String(b?.owner || '');
    const m = String(b?.mint || '');
    if (owner !== ownerBase58 || m !== mint) continue;
    const key = toKey(b);
    const preB = preMap.get(key);
    const postAmt = Number(b?.uiTokenAmount?.amount || 0);
    const preAmt = Number(preB?.uiTokenAmount?.amount || 0);
    deltaRaw += (postAmt - preAmt);
    decimals = Number.isFinite(Number(b?.uiTokenAmount?.decimals)) ? Number(b.uiTokenAmount.decimals) : decimals;
  }

  for (const b of pre) {
    const owner = String(b?.owner || '');
    const m = String(b?.mint || '');
    if (owner !== ownerBase58 || m !== mint) continue;
    const key = toKey(b);
    if (postMap.has(key)) continue;
    const preAmt = Number(b?.uiTokenAmount?.amount || 0);
    deltaRaw -= preAmt;
    decimals = Number.isFinite(Number(b?.uiTokenAmount?.decimals)) ? Number(b.uiTokenAmount.decimals) : decimals;
  }

  return { deltaRaw, decimals };
}

function solDeltaForOwner(tx, ownerBase58) {
  const keys = tx?.transaction?.message?.staticAccountKeys || tx?.transaction?.message?.accountKeys || [];
  const pre = tx?.meta?.preBalances || [];
  const post = tx?.meta?.postBalances || [];
  let idx = -1;
  for (let i = 0; i < keys.length; i += 1) {
    const k = (typeof keys[i] === 'string') ? keys[i] : keys[i]?.toBase58?.();
    if (k === ownerBase58) { idx = i; break; }
  }
  if (idx < 0) return null;
  const preLamports = Number(pre[idx] || 0);
  const postLamports = Number(post[idx] || 0);
  return { deltaLamports: postLamports - preLamports };
}

async function fetchSwapFillFromChain(conn, signature, { ownerBase58, inputMint, outputMint }) {
  try {
    const tx = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return null;

    const feeLamports = Number(tx.meta.fee || 0);
    let inAmountRaw = null;
    let outAmountRaw = null;
    let inDecimals = DECIMALS[inputMint] ?? null;
    let outDecimals = DECIMALS[outputMint] ?? null;

    const solMint = 'So11111111111111111111111111111111111111112';

    if (inputMint === solMint) {
      const sol = solDeltaForOwner(tx, ownerBase58);
      if (sol) {
        // SOL delta includes fee; swap input approximated by absolute negative delta minus fee.
        inAmountRaw = Math.max(0, Math.round(Math.abs(Math.min(0, sol.deltaLamports)) - feeLamports));
        inDecimals = 9;
      }
    } else {
      const d = tokenDeltaForOwner(tx, ownerBase58, inputMint);
      inAmountRaw = Math.max(0, Math.round(Math.abs(Math.min(0, Number(d?.deltaRaw || 0)))));
      if (Number.isFinite(Number(d?.decimals))) inDecimals = Number(d.decimals);
    }

    if (outputMint === solMint) {
      const sol = solDeltaForOwner(tx, ownerBase58);
      if (sol) {
        // On sell-to-SOL, received SOL is positive owner delta.
        outAmountRaw = Math.max(0, Math.round(Math.max(0, sol.deltaLamports)));
        outDecimals = 9;
      }
    } else {
      const d = tokenDeltaForOwner(tx, ownerBase58, outputMint);
      outAmountRaw = Math.max(0, Math.round(Math.max(0, Number(d?.deltaRaw || 0))));
      if (Number.isFinite(Number(d?.decimals))) outDecimals = Number(d.decimals);
    }

    return {
      signature,
      feeLamports,
      inAmountRaw,
      outAmountRaw,
      inDecimals,
      outDecimals,
      ok: tx?.meta?.err == null,
      err: tx?.meta?.err || null,
    };
  } catch {
    return null;
  }
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function confirmSignatureRobust(conn, signature, opts = {}) {
  const {
    commitment,
    wsTimeoutMs,
    pollMaxMs,
    pollStartMs,
    pollMaxIntervalMs,
  } = { ...DEFAULT_CONFIRM_OPTS, ...opts };

  let lastError = null;

  try {
    const wsRes = await withTimeout(
      conn.confirmTransaction(signature, commitment),
      wsTimeoutMs,
      'websocket confirm timeout',
    );

    if (wsRes?.value?.err) {
      return {
        ok: false,
        signature,
        reason: 'websocket_err',
        error: JSON.stringify(wsRes.value.err),
      };
    }

    if (wsRes?.value) {
      return { ok: true, signature, reason: 'websocket_confirmed' };
    }
  } catch (e) {
    lastError = e;
  }

  const deadline = Date.now() + pollMaxMs;
  let intervalMs = pollStartMs;

  while (Date.now() < deadline) {
    try {
      const statusRes = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = statusRes?.value?.[0] || null;

      if (status?.err) {
        return {
          ok: false,
          signature,
          reason: 'http_status_err',
          error: JSON.stringify(status.err),
        };
      }

      if (status && status.confirmationStatus && status.confirmationStatus !== 'processed') {
        return { ok: true, signature, reason: 'http_status_confirmed' };
      }

      if (status && status.confirmations !== undefined && status.confirmations !== null) {
        return { ok: true, signature, reason: 'http_status_confirmed' };
      }
    } catch (e) {
      lastError = e;
    }

    try {
      const tx = await conn.getTransaction(signature, {
        commitment,
        maxSupportedTransactionVersion: 0,
      });

      if (tx?.meta?.err) {
        return {
          ok: false,
          signature,
          reason: 'http_tx_err',
          error: JSON.stringify(tx.meta.err),
        };
      }

      if (tx) {
        return { ok: true, signature, reason: 'http_tx_found' };
      }
    } catch (e) {
      lastError = e;
    }

    await sleep(intervalMs);
    intervalMs = Math.min(Math.floor(intervalMs * 1.7), pollMaxIntervalMs);
  }

  // Last-chance late check before declaring timeout (some RPCs lag status propagation).
  try {
    const lateStatus = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = lateStatus?.value?.[0] || null;
    if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized' || s.confirmations != null)) {
      return { ok: true, signature, reason: 'late_status_confirmed' };
    }
    if (s?.err) {
      return { ok: false, signature, reason: 'late_status_err', error: JSON.stringify(s.err) };
    }
  } catch (e) {
    lastError = e;
  }

  try {
    const lateTx = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (lateTx?.meta?.err) {
      return { ok: false, signature, reason: 'late_tx_err', error: JSON.stringify(lateTx.meta.err) };
    }
    if (lateTx) {
      return { ok: true, signature, reason: 'late_tx_found' };
    }
  } catch (e) {
    lastError = e;
  }

  return {
    ok: false,
    signature,
    reason: 'http_timeout',
    error: lastError ? (lastError.message || String(lastError)) : null,
  };
}

export function toBaseUnits(amount, decimals) {
  return Math.round(amount * (10 ** decimals));
}

export async function executeSwap({
  conn,
  wallet,
  inputMint,
  outputMint,
  inAmountBaseUnits,
  slippageBps,
  maxPriceImpactPct,
  expectedOutAmount,
  expectedInAmount,
  maxQuoteDegradePct,
  twoStageSlippageRetryEnabled = false,
  twoStageSlippageRetryBps = 80,
  twoStageSlippageMaxBps = 400,
}) {
  const userPublicKey = wallet.publicKey.toBase58();

  const quote = await jupQuote({
    inputMint,
    outputMint,
    amount: inAmountBaseUnits,
    slippageBps,
  });

  const route = quote;
  if (!route) throw new Error('No Jupiter route returned');

  if (typeof maxPriceImpactPct === 'number') {
    const pi = Number(route?.priceImpactPct || 0);
    if (pi && pi > maxPriceImpactPct) {
      throw new Error(`Quote priceImpact too high: ${pi}% > ${maxPriceImpactPct}%`);
    }
  }

  if (expectedOutAmount != null && typeof maxQuoteDegradePct === 'number') {
    const expected = Number(expectedOutAmount);
    const outNow = Number(route?.outAmount || 0);
    const expectedIn = Number(expectedInAmount || 0);
    const routeIn = Number(route?.inAmount || inAmountBaseUnits || 0);
    const inMismatch = expectedIn > 0 && routeIn > 0 && (Math.abs(routeIn - expectedIn) / Math.max(1, expectedIn)) > 0.02;
    if (!inMismatch && expected > 0 && outNow > 0) {
      const minOut = expected * (1 - maxQuoteDegradePct);
      if (outNow < minOut) {
        throw new Error(`Quote degraded: out ${outNow} < min ${Math.floor(minOut)} (expectedOut=${Math.floor(expected)} expectedIn=${Math.floor(expectedIn || 0)} routeIn=${Math.floor(routeIn || 0)} slippageBps=${Number(slippageBps || 0)} routeLabel=${String(route?.routePlan?.[0]?.swapInfo?.label || 'unknown')})`);
      }
    }
  }

  let swap = null;
  let retryMeta = { attempted: false, succeeded: false, reason: null, slippageBps: null };
  try {
    swap = await jupSwap({ quoteResponse: route, userPublicKey });
  } catch (e) {
    retryMeta.reason = `primarySwapError:${e?.message || 'unknown'}`;
    swap = null;
  }

  // Optional two-stage retry: only after we already have a route/quote but swap tx build failed.
  if (!swap?.swapTransaction && twoStageSlippageRetryEnabled && route?.routePlan?.length) {
    retryMeta.attempted = true;
    try {
      const fallbackSlippage = Math.min((slippageBps || 250) + Number(twoStageSlippageRetryBps || 80), Number(twoStageSlippageMaxBps || 400));
      retryMeta.slippageBps = fallbackSlippage;
      const fallbackQuote = await jupQuote({ inputMint, outputMint, amount: inAmountBaseUnits, slippageBps: fallbackSlippage });
      if (fallbackQuote?.routePlan?.length) {
        swap = await jupSwap({ quoteResponse: fallbackQuote, userPublicKey });
        retryMeta.succeeded = !!swap?.swapTransaction;
        retryMeta.reason = retryMeta.succeeded ? 'retry_swap_tx_built' : 'retry_swap_tx_missing';
      } else {
        retryMeta.reason = 'retry_quote_no_route';
      }
    } catch (e) {
      retryMeta.reason = `retry_error:${e?.message || 'unknown'}`;
    }
  }

  if (!swap?.swapTransaction) {
    const suffix = retryMeta.attempted ? ` (retry=${retryMeta.reason || 'failed'})` : '';
    throw new Error(`Jupiter swapTransaction missing${suffix}`);
  }

  const txBuf = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  let sig;
  try {
    sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    const msg = String(e?.message || '');
    const preflightUnsupported = /preflight check is not supported/i.test(msg) || /running preflight check is not supported/i.test(msg);
    if (!preflightUnsupported) throw e;
    // Fallback: some RPC providers/endpoints do not support preflight simulation.
    sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    retryMeta ||= {};
    retryMeta.preflightFallback = true;
  }
  const confirmation = await confirmSignatureRobust(conn, sig);

  if (!confirmation.ok) {
    throw new Error(`Transaction confirmation failed (${confirmation.reason}): ${sig}${confirmation.error ? ` :: ${confirmation.error}` : ''}`);
  }

  const fill = await fetchSwapFillFromChain(conn, sig, {
    ownerBase58: userPublicKey,
    inputMint,
    outputMint,
  });

  return {
    signature: sig,
    confirmationReason: confirmation.reason,
    route,
    inputMint,
    outputMint,
    swapMeta: retryMeta,
    fill,
  };
}

export function assertNotSelfMint(mint) {
  const m = new PublicKey(mint);
  if (!m) throw new Error('Invalid mint');
}
