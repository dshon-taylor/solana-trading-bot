import { getBoostedTokens } from '../../dexscreener.mjs';
import { circuitClear, circuitHit } from '../../circuit_breaker.mjs';
import { hitDex429, isDexScreener429 } from '../../dex_cooldown.mjs';
import { pushDebug } from '../../debug_buffer.mjs';
import { safeMsg } from '../../ai.mjs';
import { nowIso } from '../../logger.mjs';
import { bumpNoPairReason } from '../route_control.mjs';
import cache from '../../global_cache.mjs';

export async function runSourceDiscoveryStage({
  cfg,
  state,
  birdseye,
  streamingProvider,
  tgSend,
  saveState,
  markCallDuration,
  cacheState,
  t,
  scanPhase,
  counters,
}) {
  let newDexCooldownUntil = null;
  const _tCandidateDiscovery = Date.now();
  const _tSourcePolling = Date.now();
  let boostedRaw = [];
  globalThis.__lastBoostedRaw = globalThis.__lastBoostedRaw || [];
  globalThis.__lastBoostedAt = globalThis.__lastBoostedAt || 0;

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

      if (!Array.isArray(cacheState.trendingTokens) || !cacheState.trendingFetchedAt || (t - cacheState.trendingFetchedAt) > beRefreshMs) {
        const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
        const r = await fetch(`https://public-api.birdeye.so/defi/token_trending?${q.toString()}`, { headers: beHeaders });
        const j = await r.json().catch(() => ({}));
        cacheState.trendingTokens = parseBeRows(j);
        cacheState.trendingFetchedAt = t;
      }

      if (!Array.isArray(cacheState.marketTrendingTokens) || !cacheState.marketTrendingFetchedAt || (t - cacheState.marketTrendingFetchedAt) > beRefreshMs) {
        const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
        const r = await fetch(`https://public-api.birdeye.so/defi/token_market_trending?${q.toString()}`, { headers: beHeaders });
        const j = await r.json().catch(() => ({}));
        cacheState.marketTrendingTokens = parseBeRows(j);
        cacheState.marketTrendingFetchedAt = t;
      }

      if (!Array.isArray(cacheState.birdEyeBoostedTokens) || !cacheState.birdEyeBoostedFetchedAt || (t - cacheState.birdEyeBoostedFetchedAt) > beRefreshMs) {
        const q = new URLSearchParams({ sort_by: 'rank', sort_type: 'asc', limit: '30', offset: '0' });
        const r = await fetch(`https://public-api.birdeye.so/defi/token_boosted?${q.toString()}`, { headers: beHeaders });
        const j = await r.json().catch(() => ({}));
        cacheState.birdEyeBoostedTokens = parseBeRows(j);
        cacheState.birdEyeBoostedFetchedAt = t;
      }

      const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};
      const earlySubTtlSec = Math.max(30, Math.floor(Number(process.env.BIRDEYE_EARLY_SUB_TTL_MS || 90_000) / 1000));
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
          // Pre-subscribe to BirdEye WS early so data accumulates before momentum eval.
          try { cache.set(`birdeye:sub:${row.mint}`, true, earlySubTtlSec); } catch {}
        }
      };
      appendRows(cacheState.trendingTokens, 'trending', Number(cfg.SOURCE_QUALITY_TRENDING_SAMPLE_N || 10));
      appendRows(cacheState.marketTrendingTokens, 'market_trending', Number(process.env.SOURCE_QUALITY_MARKET_TRENDING_SAMPLE_N || 10));
      appendRows(cacheState.birdEyeBoostedTokens, 'birdseye_boosted', Number(process.env.SOURCE_QUALITY_BOOSTED_SAMPLE_N || 10));
    } catch (e) {
      pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'BE_DISCOVERY', reason: `birdseyeDiscoveryFeeds(${safeMsg(e)})` });
    }
  }

  try {
    const _tBoost = Date.now();
    const dexBoosted = [
      ...(await getBoostedTokens('latest')),
      ...(await getBoostedTokens('top')),
    ];
    if (typeof markCallDuration === 'function') markCallDuration(_tBoost);
    boostedRaw.push(...dexBoosted);
    globalThis.__lastBoostedRaw = dexBoosted;
    globalThis.__lastBoostedAt = t;
    circuitClear({ state, nowMs: t, dep: 'dex', persist: () => saveState(cfg.STATE_PATH, state) });
  } catch (e) {
    bumpNoPairReason(counters, isDexScreener429(e) ? 'rateLimited' : 'providerEmpty', 'dex');
    pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'DEX', reason: `dexscreenerBoosted(${safeMsg(e)})` });
    circuitHit({ state, nowMs: t, dep: 'dex', note: `boosted(${safeMsg(e)})`, persist: () => saveState(cfg.STATE_PATH, state) });
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
      newDexCooldownUntil = cooldownUntilMs;
      await tgSend(cfg, `⚠️ DexScreener rate-limited. Cooling down ${(waitMs/60_000).toFixed(1)}m before next scan; continuing with BirdEye/JUP sources.`);
    }
  }

  scanPhase.candidateSourcePollingMs += Math.max(0, Date.now() - _tSourcePolling);
  const _tSourceMerging = Date.now();
  const _tSourceTransforms = Date.now();
  boostedRaw = (boostedRaw || []).map((x) => ({ ...x, _source: x?._source || 'dex' }));
  scanPhase.candidateSourceTransformsMs += Math.max(0, Date.now() - _tSourceTransforms);

  const _tStreamDrain = Date.now();
  const streamed = streamingProvider?.drainCandidates?.(120) || [];
  scanPhase.candidateStreamDrainMs += Math.max(0, Date.now() - _tStreamDrain);
  if (streamed.length) boostedRaw.push(...streamed);
  scanPhase.candidateSourceMergingMs += Math.max(0, Date.now() - _tSourceMerging);
  scanPhase.candidateDiscoveryMs += Math.max(0, Date.now() - _tCandidateDiscovery);

  return { boostedRaw, newDexCooldownUntil };
}
