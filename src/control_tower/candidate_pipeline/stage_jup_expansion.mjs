import { pushDebug } from '../../observability/debug_buffer.mjs';
import { safeMsg } from '../../analytics/ai.mjs';
import { nowIso } from '../../observability/logger.mjs';

export async function runJupExpansionStage({
  cfg,
  state,
  birdseye,
  tgSend,
  saveState,
  cacheState,
  t,
  scanPhase,
  solUsdNow,
  boostedRaw,
}) {
  const _tSourceMerging = Date.now();
  const _tJupExpand = Date.now();
  const MIN_WL = Number(cfg.MIN_LIQ_USD || 20_000);
  const boostMints = new Set((boostedRaw || []).map((x) => String(x?.tokenAddress || x?.mint || '').trim()).filter(Boolean));
  let addedFromJup = 0;

  try {
    const jupTtl = Number(process.env.JUP_TOKENS_CACHE_MS || 15 * 60_000);
    if (!cacheState.jupTokens || !cacheState.jupTokensAt || (t - cacheState.jupTokensAt) > jupTtl) {
      const hasListFn = typeof birdseye?.listJupiterTokens === 'function';
      cacheState.jupTokens = hasListFn ? await birdseye.listJupiterTokens() : [];
      cacheState.jupTokensAt = t;
    }
    const jupTokens = Array.isArray(cacheState.jupTokens) ? cacheState.jupTokens : [];
    const sourceSet = (cacheState.trendingTokens || []).map((x) => ({ mint: x.mint, source: 'trending' }))
      .concat((cacheState.marketTrendingTokens || []).map((x) => ({ mint: x.mint, source: 'market_trending' })))
      .concat((cacheState.birdEyeBoostedTokens || []).map((x) => ({ mint: x.mint, source: 'birdseye_boosted' })));
    const wlMints = state?.watchlist?.mints && typeof state.watchlist.mints === 'object' ? state.watchlist.mints : {};

    const _tJupSourceMap = Date.now();
    const sourceMap = new Map(sourceSet.map((x) => [x.mint, x.source]));
    const sourceMints = new Set(sourceSet.map((x) => x.mint));
    scanPhase.candidateJupSourceMapMs += Math.max(0, Date.now() - _tJupSourceMap);

    const _tJupFilter = Date.now();
    const filteredJup = jupTokens.filter((j) => {
      const mint = String(j?.address || '').trim();
      if (!mint || !sourceMints.has(mint)) return false;
      if (wlMints[mint]) return false;
      const liqSol = Number(j?.liquidity || 0);
      const liqUsd = Number.isFinite(liqSol) ? liqSol * Number(solUsdNow || 0) : 0;
      if (!(liqUsd >= MIN_WL)) return false;
      if (boostMints.has(mint)) return false;
      return true;
    });
    scanPhase.candidateJupFilterMs += Math.max(0, Date.now() - _tJupFilter);

    const _tJupMap = Date.now();
    for (const j of filteredJup) {
      const mint = String(j.address || '').trim();
      const liqSol = Number(j.liquidity || 0);
      const liqUsd = Number.isFinite(liqSol) ? liqSol * Number(solUsdNow || 0) : 0;
      boostedRaw.push({
        tokenAddress: mint,
        tokenSymbol: j.symbol || null,
        liquidityUsd: liqUsd,
        volume24hUsd: Number(j.volume24h || 0),
        rank: Number(j.rank || 0),
        _source: sourceMap.get(mint) || 'jup',
      });
      addedFromJup += 1;
    }
    scanPhase.candidateJupMapMs += Math.max(0, Date.now() - _tJupMap);
  } catch (e) {
    pushDebug(state, { t: nowIso(), mint: 'N/A', symbol: 'JUP_EXPAND', reason: `jupExpand(${safeMsg(e)})` });
    await tgSend(cfg, `⚠️ JUP expansion skipped: ${safeMsg(e)}`);
    saveState(cfg.STATE_PATH, state);
  }

  if (addedFromJup > 0) {
    await tgSend(cfg, `🔎 Candidate expansion: +${addedFromJup} from JUP token list (BirdEye seeds)`);
  }
  scanPhase.candidateJupExpandMs += Math.max(0, Date.now() - _tJupExpand);
  scanPhase.candidateSourceMergingMs += Math.max(0, Date.now() - _tSourceMerging);

  return boostedRaw;
}
