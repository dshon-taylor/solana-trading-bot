import { snapshotFromBirdseye } from '../market_data/router.mjs';

function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export function isValidDecimals(decimals) {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18;
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  const ms = Number(timeoutMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

export async function resolveEntryAndStopForOpenPosition({
  mint,
  pair = null,
  snapshot = null,
  decimalsHint = null,
  stopAtEntryBufferPct = 0,
  birdeyeEnabled = false,
  getBirdseyeSnapshot = null,
  birdeyeFetchTimeoutMs = 2500,
  rpcUrl = null,
  getTokenSupply = null,
} = {}) {
  const out = {
    ok: false,
    reason: 'unknown',
    entryPriceUsd: null,
    stopPriceUsd: null,
    decimals: null,
    priceSource: null,
    decimalsSource: null,
    decimalsSourcesTried: [],
    mintResolvedForDecimals: null,
    pairBaseTokenAddress: null,
  };

  const mintResolved = mint || pair?.baseToken?.address || null;
  out.mintResolvedForDecimals = mintResolved || null;
  out.pairBaseTokenAddress = pair?.baseToken?.address || null;
  if (!mintResolved) {
    out.reason = 'missingMint';
    return out;
  }

  // 1) Resolve entry price.
  let entryPriceUsd = Number(snapshot?.priceUsd || pair?.priceUsd || 0);
  if (isFinitePositive(entryPriceUsd)) {
    out.priceSource = snapshot?.source || (pair ? 'dex' : 'unknown');
  } else {
    entryPriceUsd = null;
  }

  // 1b) If missing price, try Birdseye synchronously (bounded).
  if (!isFinitePositive(entryPriceUsd) && birdeyeEnabled && typeof getBirdseyeSnapshot === 'function') {
    try {
      const bird = await withTimeout(getBirdseyeSnapshot(mintResolved), birdeyeFetchTimeoutMs, 'birdeyeFetchTimeout');
      const birdSnap = snapshotFromBirdseye(bird, Date.now());
      if (birdSnap?.priceUsd && isFinitePositive(birdSnap.priceUsd)) {
        entryPriceUsd = Number(birdSnap.priceUsd);
        out.priceSource = birdSnap.source || 'bird';
      }
    } catch {
      // ignore; we handle failure below via guard reason
    }
  }

  if (!isFinitePositive(entryPriceUsd)) {
    out.reason = 'missingEntryPriceUsd';
    return out;
  }

  // 2) Resolve decimals with safe fallbacks.
  let decimals = (typeof decimalsHint === 'number') ? decimalsHint : null;
  out.decimalsSourcesTried.push({ source: 'decimalsHint', value: Number.isFinite(Number(decimalsHint)) ? Number(decimalsHint) : null, ok: isValidDecimals(decimals) });
  if (!isValidDecimals(decimals)) {
    const fromPair = pair?.baseToken?.decimals;
    out.decimalsSourcesTried.push({ source: 'pair.baseToken.decimals', value: Number.isFinite(Number(fromPair)) ? Number(fromPair) : null, ok: isValidDecimals(fromPair) });
    if (isValidDecimals(fromPair)) decimals = fromPair;
  }
  if (!isValidDecimals(decimals)) {
    const fromSnapshotRaw = snapshot?.raw?.decimals;
    out.decimalsSourcesTried.push({ source: 'snapshot.raw.decimals', value: Number.isFinite(Number(fromSnapshotRaw)) ? Number(fromSnapshotRaw) : null, ok: isValidDecimals(fromSnapshotRaw) });
    if (isValidDecimals(fromSnapshotRaw)) decimals = fromSnapshotRaw;
  }
  if (!isValidDecimals(decimals)) {
    const fromSnapshotPair = snapshot?.pair?.baseToken?.decimals;
    out.decimalsSourcesTried.push({ source: 'snapshot.pair.baseToken.decimals', value: Number.isFinite(Number(fromSnapshotPair)) ? Number(fromSnapshotPair) : null, ok: isValidDecimals(fromSnapshotPair) });
    if (isValidDecimals(fromSnapshotPair)) decimals = fromSnapshotPair;
  }

  if (!isValidDecimals(decimals) && rpcUrl && typeof getTokenSupply === 'function') {
    try {
      const supply = await getTokenSupply(rpcUrl, mintResolved);
      const rpcDec = supply?.value?.decimals;
      out.decimalsSourcesTried.push({
        source: 'rpc.getTokenSupply.value.decimals',
        targetMint: mintResolved,
        rpcSuccess: true,
        value: Number.isFinite(Number(rpcDec)) ? Number(rpcDec) : null,
        ok: isValidDecimals(rpcDec),
        parseReason: isValidDecimals(rpcDec) ? 'ok' : 'missing_or_invalid_decimals_field',
      });
      if (isValidDecimals(rpcDec)) decimals = rpcDec;
    } catch (e) {
      out.decimalsSourcesTried.push({
        source: 'rpc.getTokenSupply.value.decimals',
        targetMint: mintResolved,
        rpcSuccess: false,
        value: null,
        ok: false,
        error: String(e?.message || 'fetch_failed'),
      });
      // ignore; guard below
    }
  }

  if (!isValidDecimals(decimals)) {
    out.reason = 'missingDecimals';
    return out;
  }

  // 3) Compute stop.
  const stopPriceUsd = entryPriceUsd * (1 - Number(stopAtEntryBufferPct || 0));

  if (!isFinitePositive(stopPriceUsd)) {
    out.reason = 'invalidStopPriceUsd';
    return out;
  }

  out.ok = true;
  out.reason = 'ok';
  out.entryPriceUsd = entryPriceUsd;
  out.stopPriceUsd = stopPriceUsd;
  out.decimals = decimals;
  out.decimalsSource = (out.decimalsSourcesTried || []).slice().reverse().find((x) => x?.ok)?.source || 'unknown';
  return out;
}
