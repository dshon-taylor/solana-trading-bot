import 'dotenv/config';
import { getConfig } from '../src/config.mjs';
import { loadKeypairFromSopsFile, loadKeypairFromEnv } from '../src/wallet.mjs';
import { makeConnection } from '../src/portfolio.mjs';
import { executeSwap, toBaseUnits, DECIMALS } from '../src/trader.mjs';
import { appendTradingLog, nowIso } from '../src/logger.mjs';
import { tgSend } from '../src/telegram.mjs';
import { getTokenPairs, pickBestPair } from '../src/dexscreener.mjs';

async function getSolUsd() {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const pairs = await getTokenPairs('solana', SOL_MINT);
  const best = pickBestPair(pairs);
  const price = Number(best?.priceUsd || 0);
  if (!price) throw new Error('SOLUSD unavailable');
  return price;
}

async function main() {
  // Mitigate ALT-related simulation failures on some RPCs during sanity runs.
  if (!process.env.JUPITER_AS_LEGACY_TRANSACTION) process.env.JUPITER_AS_LEGACY_TRANSACTION = 'true';

  const cfg = getConfig();
  const wallet = process.env.SOPS_WALLET_FILE
    ? loadKeypairFromSopsFile(process.env.SOPS_WALLET_FILE)
    : loadKeypairFromEnv();
  const conn = makeConnection(cfg.SOLANA_RPC_URL);

  const solUsd = await getSolUsd();
  const solAmount = 0.01;
  const lamports = toBaseUnits(solAmount, DECIMALS[cfg.SOL_MINT] ?? 9);
  const usd = solAmount * solUsd;

  await tgSend(cfg, `⚙️ Live sanity swap starting\n• size: ${solAmount.toFixed(4)} SOL (~$${usd.toFixed(2)})`);

  const buy = await executeSwap({
    conn,
    wallet,
    inputMint: cfg.SOL_MINT,
    outputMint: cfg.USDC_MINT,
    inAmountBaseUnits: lamports,
    slippageBps: 50,
    maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
  });

  const usdcOut = Number(buy.route?.routePlan?.[0]?.swapInfo?.outAmount || buy.route?.outAmount || 0);
  appendTradingLog(cfg.TRADING_LOG_PATH, `\n## MANUAL BUY\n- time: ${nowIso()}\n- solAmount: ${solAmount}\n- tx: ${buy.signature}\n`);
  await tgSend(cfg, `🟢 Manual buy complete\nTx: https://solscan.io/tx/${buy.signature}`);

  if (!usdcOut) throw new Error('USDC out missing');

  const sell = await executeSwap({
    conn,
    wallet,
    inputMint: cfg.USDC_MINT,
    outputMint: cfg.SOL_MINT,
    inAmountBaseUnits: Math.floor(usdcOut),
    slippageBps: 50,
    maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
  });

  appendTradingLog(cfg.TRADING_LOG_PATH, `\n## MANUAL SELL\n- time: ${nowIso()}\n- usdcAmount: ${usdcOut}\n- tx: ${sell.signature}\n`);
  await tgSend(cfg, `🔴 Manual sell complete\nTx: https://solscan.io/tx/${sell.signature}`);
  await tgSend(cfg, '✅ Manual sanity swap finished (round-trip).');
}

main().catch(async (err) => {
  console.error(err);
  try {
    const cfg = getConfig();
    await tgSend(cfg, `⚠️ Manual sanity swap failed: ${err.message}`);
  } catch {}
  process.exit(1);
});
