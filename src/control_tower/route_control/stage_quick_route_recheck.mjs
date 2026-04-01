import { toBaseUnits, DECIMALS } from '../../trading/trader.mjs';
import { getRouteQuoteWithFallback } from './stage_route_quote_fallback.mjs';

export async function quickRouteRecheck({ cfg, mint, solUsdNow, slippageBps, attempts, delayMs, passes = 1, passDelayMs = 80 }) {
  const maxAttempts = Math.max(1, Math.min(8, Number(attempts || 1)));
  const waitMs = Math.max(20, Number(delayMs || 120));
  const maxPasses = Math.max(1, Math.min(4, Number(passes || 1)));
  const interPassWaitMs = Math.max(10, Number(passDelayMs || 80));
  let totalAttempts = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, interPassWaitMs));
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, waitMs));
      totalAttempts += 1;
      try {
        const lam = toBaseUnits((cfg.JUP_PREFILTER_AMOUNT_USD / solUsdNow), DECIMALS[cfg.SOL_MINT] ?? 9);
        const route = await getRouteQuoteWithFallback({
          cfg,
          mint,
          amountLamports: lam,
          slippageBps,
          solUsdNow,
          source: 'quick-recheck',
        });
        if (route.routeAvailable) return { recovered: true, attempts: totalAttempts, pass: pass + 1 };
        if (route.rateLimited) return { recovered: false, attempts: totalAttempts, pass: pass + 1, rateLimited: true };
      } catch {}
    }
  }
  return { recovered: false, attempts: totalAttempts, pass: maxPasses };
}
