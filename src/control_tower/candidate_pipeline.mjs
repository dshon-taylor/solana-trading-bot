/**
 * candidate_pipeline.mjs
 *
 * Factory for the candidate source ingestion pipeline.
 * Owns the BirdEye / DexScreener / Jupiter token-list feed cache state and
 * provides fetchCandidateSources() for use each scan cycle.
 *
 * Usage:
 *   const { fetchCandidateSources } = createCandidatePipeline({ cfg, state, ... });
 *   const { boostedRaw, newDexCooldownUntil } = await fetchCandidateSources({
 *     t, scanPhase, solUsdNow, counters,
 *   });
 */
import { getBoostedTokens } from '../dexscreener.mjs';
import { fetchJupTokenList } from '../jup_tokenlist.mjs';
import { circuitClear, circuitHit } from '../circuit_breaker.mjs';
import { hitDex429, isDexScreener429 } from '../dex_cooldown.mjs';
import { hitJup429, isJup429 } from '../jup_cooldown.mjs';
import { pushDebug } from '../debug_buffer.mjs';
import { safeMsg } from '../ai.mjs';
import { nowIso } from '../logger.mjs';
import { toBaseUnits, DECIMALS } from '../trader.mjs';
import {
  mapWithConcurrency,
  bumpNoPairReason,
  getRouteQuoteWithFallback,
} from './route_control.mjs';

export function createCandidatePipeline({
  cfg,
  state,
  birdseye,
  streamingProvider,
  tgSend,
  saveState,
}) {
  // Per-pipeline feed cache — survives across scan cycles
  let jupTokens = null;
  let jupTokensAt = 0;
  let trendingTokens = [];
  let trendingFetchedAt = 0;
  let marketTrendingTokens = [];
  let marketTrendingFetchedAt = 0;
  let birdEyeBoostedTokens = [];
  let birdEyeBoostedFetchedAt = 0;

  /**
   * Fetch and merge candidate sources for one scan cycle.
   * @param {number} t - current timestamp (Date.now())
   * @param {object} scanPhase - per-cycle phase timing counters (mutated in place)
   * @param {number} solUsdNow - current SOL/USD price
   * @param {object} counters - metrics counters object
   * @returns {{ boostedRaw: object[], newDexCooldownUntil: number|null }}
   */
  async function fetchCandidateSources({ t, scanPhase, solUsdNow, counters }) {
    let _newDexCooldownUntil = null;
    // Pull DexScreener boosted candidates
    const _tCandidateDiscovery = Date.now();
    const _tSourcePolling = Date.now();
    let boostedRaw = [];
    globalThis.__lastBoostedRaw = globalThis.__lastBoostedRaw || [];
    globalThis.__lastBoostedAt = globalThis.__lastBoostedAt || 0;

    // Primary discovery feeds (BirdEye): token_trending, token_market_trending, token_boosted
    if (cfg.BIRDEYE_API_KEY) {
      try {
        const beRefreshMs = Number(cfg.TRENDING_REFRESH_MS || 90_000);
        const parseBeRows = (j) => {
          const rows = Array.isArray(j?.data?.tokens) ? j.data.tokens
            : (Array.isArray(j?.data?.items) ? j.data.items
              : (Array.isArray(j?.data) ? j.data
                : (Array.isArray(j?.tokens) ? j.tokens : [])));
          return rows.map((x) => ({
            mint: String(x?.address || x?.mint || x?.tokenAddress || '').trim(),
            liquidity: Number(x?.liquidity ?? x?.liquidityUsd ?? x?.liquidity_usd ?? 0),
            volume24hUsd: Number(x?.volume24hUSD ?? x?.v24hUSD ?? x?.volume24h ?? x?.volume_24h_usd ?? 0),
            rank: Number(x?.rank ?? x?.trendingRank ?? 0),
            symbol: String(x?.symbol || ''),
          })).filter((x) => !!x.mint);
        };
        const beHeaders = {
          accept: 'application/json',
          'x-chain': 'solana',
          'X-API-KEY': String(cfg.BIRDEYE_API_KEY || ''),
        };

        if (!Array.isArray(trendingTokens) || !trendingFetchedAt || (t - trendingFetchedAt) > beRefreshMs) {
          const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
          const r = await fetch(`https://public-api.birdeye.so/defi/token_trending?${q.toString()}`, { headers: beHeaders });
          const j = await r.json().catch(() => ({}));
          trendingTokens = parseBeRows(j);
          trendingFetchedAt = t;
        }

        if (!Array.isArray(marketTrendingTokens) || !marketTrendingFetchedAt || (t - marketTrendingFetchedAt) > beRefreshMs) {
          const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
          const r = await fetch(`https://public-api.birdeye.so/defi/token_market_trending?${q.toString()}`, { headers: beHeaders });
          const j = await r.json().catch(() => ({}));
          marketTrendingTokens = parseBeRows(j);
          marketTrendingFetchedAt = t;
        }

        if (!Array.isArray(birdEyeBoostedTokens) || !birdEyeBoostedFetchedAt || (t - birdEyeBoostedFetchedAt) > beRefreshMs) {
          const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
          const r = await fetch(`https://public-api.birdeye.so/defi/token_boosted?${q.toString()}`, { headers: beHeaders });
          const j = await r.json().catch(() => ({}));
          birdEyeBoostedTokens = parseBeRows(j);
          birdEyeBoostedFetchedAt = t;
        }

        const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};
        const appendRows = (rows, source, sampleN) => {
          const n = Math.max(0, Math.min(Number(sampleN || 0), Number(rows?.length || 0)));
          for (const row of (rows || []).slice(0, n)) {
            if (wlMints[row.mint]) continue;
            boostedRaw.push({
              tokenAddress: row.mint,
              tokenSymbol: row.symbol || null,
              liquidityUsd: Number(row.liquidity || 0),
              volume24hUsd: Number(row.volume24hUsd || 0),
              rank: Number(row.rank || 0),
              _source: source,
            });
          }
        };
        appendRows(trendingTokens, 'trending', Number(cfg.SOURCE_QUALITY_TRENDING_SAMPLE_N || 10));
        appendRows(marketTrendingTokens, 'market_trending', Number(process.env.SOURCE_QUALITY_MARKET_TRENDING_SAMPLE_N || 10));
        appendRows(birdEyeBoostedTokens, 'birdseye_boosted', Number(process.env.SOURCE_QUALITY_BOOSTED_SAMPLE_N || 10));
      } catch (e) {
        pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'BE_DISCOVERY', reason: `birdseyeDiscoveryFeeds(${safeMsg(e)})` });
      }
    }

    // Secondary discovery feed: DexScreener boosted candidates
    try {
      const _tBoost = Date.now();
      const dexBoosted = [
        ...(await getBoostedTokens('latest')),
        ...(await getBoostedTokens('top')),
      ];
      markCallDuration(_tBoost);
      boostedRaw.push(...dexBoosted);
      globalThis.__lastBoostedRaw = dexBoosted;
      globalThis.__lastBoostedAt = t;
      circuitClear({ state, nowMs: t, dep: 'dex', persist: () => saveState(cfg.STATE_PATH, state) });
    } catch (e) {
      // DexScreener rate limit or temporary failure.
      bumpNoPairReason(counters, isDexScreener429(e) ? 'rateLimited' : 'providerEmpty', 'dex');
      pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'DEX', reason: `dexscreenerBoosted(${safeMsg(e)})` });
      circuitHit({ state, nowMs: t, dep: 'dex', note: `boosted(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
      // Fall back to last known DexScreener boosted list (up to 10m old)
      if (globalThis.__lastBoostedRaw?.length && (t - globalThis.__lastBoostedAt) < 10 * 60_000) {
        boostedRaw.push(...globalThis.__lastBoostedRaw);
      } else {
        const { waitMs, cooldownUntilMs } = hitDex429({
          state,
          nowMs: t,
          baseMs: 2 * 60_000,
          reason: 'dexscreenerBoosted(429?)',
          persist: () => saveState(cfg.STATE_PATH, state),
        });
        _newDexCooldownUntil = cooldownUntilMs;
        await tgSend(cfg, `⚠️ DexScreener rate-limited. Cooling down ${(waitMs/60_000).toFixed(1)}m before next scan; continuing with BirdEye/JUP sources.`);
      }
    }

    scanPhase.candidateSourcePollingMs += Math.max(0, Date.now() - _tSourcePolling);
    const _tSourceMerging = Date.now();
    const _tSourceTransforms = Date.now();
    boostedRaw = (boostedRaw || []).map((x) => ({ ...x, _source: x?._source || 'dex' }));
    scanPhase.candidateSourceTransformsMs += Math.max(0, Date.now() - _tSourceTransforms);

    // Optional staging stream feed (laserstream-devnet).
    const _tStreamDrain = Date.now();
    const streamed = streamingProvider?.drainCandidates?.(120) || [];
    scanPhase.candidateStreamDrainMs += Math.max(0, Date.now() - _tStreamDrain);
    if (streamed.length) boostedRaw.push(...streamed);
    scanPhase.candidateSourceMergingMs += Math.max(0, Date.now() - _tSourceMerging);

    // BirdEye discovery feeds are pulled earlier as primary source inputs:
    // token_trending, token_market_trending, token_boosted.

    // Expand universe using Jupiter token list (non-boosted pool)
    if (cfg.JUP_TOKENLIST_ENABLED) {
      try {
        if (!jupTokens || (t - jupTokensAt) > cfg.JUP_TOKENLIST_CACHE_MS) {
          const _tTokenFetch = Date.now();
          jupTokens = await fetchJupTokenList(cfg.JUP_TOKENLIST_URL);
          scanPhase.candidateTokenlistFetchMs += Math.max(0, Date.now() - _tTokenFetch);
          jupTokensAt = t;
          circuitClear({ state, nowMs: t, dep: 'jup', persist: () => saveState(cfg.STATE_PATH, state) });
        }

        const _tTokenPool = Date.now();
        const pool = (jupTokens || []).filter(x => x.address && x.address !== cfg.SOL_MINT);
        scanPhase.candidateTokenlistPoolBuildMs += Math.max(0, Date.now() - _tTokenPool);
        const qualityFirst = cfg.SOURCE_MODE === 'quality_first';
        const sampleN = Math.max(0, Math.min(qualityFirst ? cfg.SOURCE_QUALITY_JUP_SAMPLE_N : cfg.JUP_TOKENLIST_SAMPLE_N, pool.length));

        if (!qualityFirst || !cfg.SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE) {
          const _tTokenSampling = Date.now();
          for (let i = 0; i < sampleN; i++) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!pick?.address) continue;
            boostedRaw.push({
              tokenAddress: pick.address,
              tokenSymbol: pick.symbol,
              _source: 'jup',
            });
          }
          scanPhase.candidateTokenlistSamplingMs += Math.max(0, Date.now() - _tTokenSampling);
        } else {
          const maxAttempts = Math.max(sampleN, sampleN * 4);
          const picked = new Set();
          const picks = [];
          const _tTokenSampling = Date.now();
          for (let i = 0; i < maxAttempts && picks.length < maxAttempts; i++) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            if (!pick?.address || picked.has(pick.address)) continue;
            picked.add(pick.address);
            picks.push(pick);
          }
          scanPhase.candidateTokenlistSamplingMs += Math.max(0, Date.now() - _tTokenSampling);

          state.runtime ||= {};
          state.runtime.tokenlistQuoteCache ||= {};
          state.runtime.tokenlistLiqCache ||= {};
          const quoteCache = state.runtime.tokenlistQuoteCache;
          const liqCache = state.runtime.tokenlistLiqCache;
          const quoteCacheTtlMs = Math.max(15_000, Number(process.env.TOKENLIST_QUOTE_CACHE_TTL_MS || 180_000));
          const liqCacheTtlMs = Math.max(15_000, Number(process.env.TOKENLIST_LIQ_CACHE_TTL_MS || 90_000));
          const quoteCheckConcurrency = Math.max(1, Math.min(8, Number(process.env.TOKENLIST_QUOTE_CHECK_CONCURRENCY || 4)));
          const hotFloorForTokenlist = Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40_000);
          const nowCache = Date.now();
          for (const [m, e] of Object.entries(quoteCache)) {
            if ((nowCache - Number(e?.atMs || 0)) > quoteCacheTtlMs) delete quoteCache[m];
          }
          for (const [m, e] of Object.entries(liqCache)) {
            if ((nowCache - Number(e?.atMs || 0)) > liqCacheTtlMs) delete liqCache[m];
          }

          const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
          let hitRateLimit = false;
          const resolved = [];
          await mapWithConcurrency(picks, quoteCheckConcurrency, async (pick) => {
            const mint = String(pick?.address || '');
            if (!mint) return;

            let liqUsd = Number(pick?.liquidityUsd || pick?.liquidity || 0);
            if (!(liqUsd > 0)) {
              const liqCached = liqCache[mint];
              if (liqCached && (Date.now() - Number(liqCached?.atMs || 0)) <= liqCacheTtlMs) {
                liqUsd = Number(liqCached?.liqUsd || 0);
              }
            }
            if (!(liqUsd > 0) && birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
              try {
                const snap = await birdseye.getTokenSnapshot(mint);
                liqUsd = Number(snap?.liquidityUsd || snap?.pair?.liquidity?.usd || 0);
                const _tLiqWrite = Date.now();
                liqCache[mint] = { atMs: Date.now(), liqUsd };
                scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tLiqWrite);
              } catch {}
            }

            if (!(liqUsd >= hotFloorForTokenlist)) {
              scanPhase.tokenlistCandidatesFilteredByLiquidity += 1;
              scanPhase.tokenlistQuoteChecksSkipped += 1;
              resolved.push({ pick, routeable: false, liquidityFiltered: true });
              return;
            }

            const _tCacheRead = Date.now();
            const cached = quoteCache[mint];
            scanPhase.candidateCacheReadsMs += Math.max(0, Date.now() - _tCacheRead);
            if (cached && (Date.now() - Number(cached?.atMs || 0)) <= quoteCacheTtlMs) {
              resolved.push({ pick, routeable: !!cached.routeable });
              return;
            }
            const _tQuoteable = Date.now();
            scanPhase.tokenlistQuoteChecksPerformed += 1;
            try {
              const q = await getRouteQuoteWithFallback({
                cfg,
                mint,
                amountLamports: lam,
                slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                solUsdNow,
                source: 'tokenlist-quality-gate',
              });
              scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
              const routeable = !!q?.routeAvailable;
              const _tCacheWrite = Date.now();
              quoteCache[mint] = { atMs: Date.now(), routeable };
              scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tCacheWrite);
              resolved.push({ pick, routeable });
            } catch (e) {
              scanPhase.candidateTokenlistQuoteabilityChecksMs += Math.max(0, Date.now() - _tQuoteable);
              if (isJup429(e) || isDexScreener429(e)) hitRateLimit = true;
              const _tCacheWrite = Date.now();
              quoteCache[mint] = { atMs: Date.now(), routeable: false };
              scanPhase.candidateCacheWritesMs += Math.max(0, Date.now() - _tCacheWrite);
              resolved.push({ pick, routeable: false });
            }
          });

          if (hitRateLimit) {
            hitJup429({ state, nowMs: t, baseMs: 15_000, reason: 'qualitySourceJupGate(429)', persist: () => saveState(cfg.STATE_PATH, state) });
          }

          let accepted = 0;
          for (const r of resolved) {
            if (!r?.routeable) continue;
            boostedRaw.push({ tokenAddress: r.pick.address, tokenSymbol: r.pick.symbol, _source: 'jup' });
            accepted += 1;
            if (accepted >= sampleN) break;
          }
        }
      } catch (e) {
        pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'JUP', reason: `jupTokenList(${safeMsg(e)})` });
        circuitHit({ state, nowMs: t, dep: 'jup', note: `tokenlist(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
        if (!globalThis.__lastJupFailPingAt || (t - globalThis.__lastJupFailPingAt) > 30 * 60_000) {
          globalThis.__lastJupFailPingAt = t;
          await tgSend(cfg, '⚠️ Jupiter token list fetch is failing right now, so we are not getting JUP-sourced candidates yet.');
        }
      }
    }

    // Dedupe by mint and build a candidate list first, then rank.
    const _tDedupe = Date.now();
    const _tIteration = Date.now();
    const seen = new Set();
    const boosted = [];
    for (const tok of boostedRaw) {
      const m = tok?.tokenAddress;
      if (!m || seen.has(m)) continue;
      seen.add(m);
      boosted.push(tok);
      if (boosted.length >= 80) break;
    }
    scanPhase.candidateDedupeMs += Math.max(0, Date.now() - _tDedupe);
    scanPhase.candidateIterationMs += Math.max(0, Date.now() - _tIteration);
    scanPhase.candidateDiscoveryMs += Math.max(0, Date.now() - _tCandidateDiscovery);

    return { boostedRaw, boosted, newDexCooldownUntil: _newDexCooldownUntil };
  }

  return { fetchCandidateSources };
}
