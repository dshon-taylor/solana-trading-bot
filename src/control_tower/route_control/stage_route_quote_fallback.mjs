import { jupQuote } from '../../jupiter.mjs';
import { getTokenPairs, pickBestPair } from '../../dexscreener.mjs';
import { getRaydiumPools, pickBestRaydiumPool } from '../../raydium.mjs';
import { isDexScreener429 } from '../../dex_cooldown.mjs';
import { isJup429 } from '../../jup_cooldown.mjs';

export function parseJupQuoteFailure(err) {
  const msg = String(err?.message || '').toUpperCase();
  if (err?.status === 429 || msg.includes('JUPITER_429') || msg.includes(' 429')) return 'rateLimited';
  if (
    msg.includes('TOKEN_NOT_TRADABLE')
    || msg.includes('TOKEN NOT TRADABLE')
    || msg.includes('COULD_NOT_FIND_ANY_ROUTE')
    || msg.includes('NO_ROUTES_FOUND')
    || msg.includes('ROUTE NOT FOUND')
    || msg.includes('MINT_NOT_FOUND')
    || msg.includes('INVALID_MINT')
    || msg.includes('TOKEN HAS NO MARKET')
  ) return 'nonTradableMint';
  if (err?.status === 400 || err?.status === 404) return 'routeNotFound';
  return 'providerEmpty';
}

function isRouteQuoteable({ quote, maxPriceImpactPct }) {
  if (!quote?.routePlan?.length) return false;
  const pi = Number(quote?.priceImpactPct || 0);
  return (!pi || pi <= Number(maxPriceImpactPct || 0));
}

function isSolLikeQuoteToken(token) {
  const symbol = String(token?.symbol || '').toUpperCase();
  const addr = String(token?.address || '');
  return symbol === 'SOL' || symbol === 'WSOL' || addr === 'So11111111111111111111111111111111111111112';
}

function isUsdcLikeQuoteToken(token) {
  const symbol = String(token?.symbol || '').toUpperCase();
  const addr = String(token?.address || '');
  return symbol === 'USDC' || addr === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
}

function buildAlternativeRouteQuote({ mint, amountLamports, slippageBps, pair, estimatedPriceImpactPct }) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: mint,
    inAmount: String(Math.max(0, Math.floor(Number(amountLamports || 0)))),
    outAmount: null,
    slippageBps: Number(slippageBps || 0),
    priceImpactPct: Number(estimatedPriceImpactPct || 0),
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: `DexScreenerAlt:${String(pair?.dexId || 'unknown')}`,
          ammKey: String(pair?.pairAddress || ''),
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: mint,
        },
      },
    ],
    synthetic: true,
    provider: 'dexscreener-alt',
  };
}

function isRaydiumPoolSupported(pool, targetMint) {
  if (!pool) return false;
  const mintA = pool.mintA;
  const mintB = pool.mintB;
  const aIsTarget = mintA?.address === targetMint;
  const bIsTarget = mintB?.address === targetMint;
  if (aIsTarget) return isSolLikeQuoteToken(mintB) || isUsdcLikeQuoteToken(mintB);
  if (bIsTarget) return isSolLikeQuoteToken(mintA) || isUsdcLikeQuoteToken(mintA);
  return false;
}

function buildRaydiumRouteQuote({ mint, amountLamports, slippageBps, pool, estimatedPriceImpactPct }) {
  return {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: mint,
    inAmount: String(Math.max(0, Math.floor(Number(amountLamports || 0)))),
    outAmount: null,
    slippageBps: Number(slippageBps || 0),
    priceImpactPct: Number(estimatedPriceImpactPct || 0),
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: `RaydiumAlt:${String(pool?.type || 'Standard')}`,
          ammKey: String(pool?.id || ''),
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: mint,
        },
      },
    ],
    synthetic: true,
    provider: 'raydium-alt',
  };
}

export async function getRouteQuoteWithFallback({ cfg, mint, amountLamports, slippageBps, solUsdNow, source = 'unknown' }) {
  let jupErrorKind = null;
  let rateLimited = false;
  try {
    const quote = await jupQuote({ inputMint: cfg.SOL_MINT, outputMint: mint, amount: amountLamports, slippageBps });
    return {
      routeAvailable: isRouteQuoteable({ quote, maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT }),
      quote,
      provider: 'jupiter',
      rateLimited: false,
      routeErrorKind: null,
    };
  } catch (e) {
    jupErrorKind = parseJupQuoteFailure(e);
    rateLimited = jupErrorKind === 'rateLimited' || isJup429(e);
    if (!cfg.ROUTE_ALT_ENABLED) {
      return {
        routeAvailable: false,
        quote: null,
        provider: 'jupiter',
        rateLimited,
        routeErrorKind: jupErrorKind,
      };
    }
  }

  const notionalUsd = (Number(amountLamports || 0) / 1e9) * Math.max(0, Number(solUsdNow || 0));
  const minLiq = Number(cfg.ROUTE_ALT_MIN_LIQ_USD || 0);
  const maxImpact = Number(cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT || 4);

  const dexTask = (async () => {
    const pairs = await getTokenPairs('solana', mint);
    const best = pickBestPair(pairs);
    const liqUsd = Number(best?.liquidity?.usd || 0);
    const quoteToken = best?.quoteToken || null;
    const quoteTokenSupported = isSolLikeQuoteToken(quoteToken) || isUsdcLikeQuoteToken(quoteToken);
    const impactPct = liqUsd > 0 && notionalUsd > 0
      ? Math.max(0, Math.min(99, (notionalUsd / Math.max(1, liqUsd)) * 130))
      : maxImpact;
    if (!best || !quoteTokenSupported || liqUsd < minLiq || impactPct > maxImpact) return null;
    return {
      routeAvailable: true,
      quote: buildAlternativeRouteQuote({ mint, amountLamports, slippageBps, pair: best, estimatedPriceImpactPct: impactPct }),
      provider: 'dexscreener-alt',
      rateLimited,
      routeErrorKind: jupErrorKind,
      meta: { source, liquidityUsd: liqUsd, impactPct },
    };
  })();

  const raydiumTask = cfg.ROUTE_ALT_RAYDIUM_ENABLED
    ? (async () => {
        const pools = await getRaydiumPools(mint);
        const best = pickBestRaydiumPool(pools);
        const tvl = Number(best?.tvl || 0);
        const impactPct = tvl > 0 && notionalUsd > 0
          ? Math.max(0, Math.min(99, (notionalUsd / Math.max(1, tvl)) * 130))
          : maxImpact;
        if (!best || !isRaydiumPoolSupported(best, mint) || tvl < minLiq || impactPct > maxImpact) return null;
        return {
          routeAvailable: true,
          quote: buildRaydiumRouteQuote({ mint, amountLamports, slippageBps, pool: best, estimatedPriceImpactPct: impactPct }),
          provider: 'raydium-alt',
          rateLimited,
          routeErrorKind: jupErrorKind,
          meta: { source, liquidityUsd: tvl, impactPct },
        };
      })()
    : Promise.resolve(null);

  const [dexSettled, raydiumSettled] = await Promise.allSettled([dexTask, raydiumTask]);

  const raydiumResult = raydiumSettled.status === 'fulfilled' ? raydiumSettled.value : null;
  const dexResult = dexSettled.status === 'fulfilled' ? dexSettled.value : null;
  const winner = raydiumResult || dexResult;

  if (winner) return winner;

  const anyRateLimited =
    (dexSettled.status === 'rejected' && isDexScreener429(dexSettled.reason)) ||
    (raydiumSettled.status === 'rejected' && raydiumSettled.reason?.status === 429);
  return {
    routeAvailable: false,
    quote: null,
    provider: 'alt',
    rateLimited: rateLimited || anyRateLimited,
    routeErrorKind: jupErrorKind || (anyRateLimited ? 'rateLimited' : 'routeNotFound'),
  };
}
