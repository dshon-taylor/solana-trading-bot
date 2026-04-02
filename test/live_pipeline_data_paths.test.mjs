import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { buildNormalizedMomentumInput } from '../src/control_tower/watchlist_pipeline/watchlist_eval_helpers.mjs';
import { evaluateMomentumSignal } from '../src/trading/strategy.mjs';
import { resolveConfirmTxMetrics } from '../src/control_tower/confirm_helpers/index.mjs';

const POPULAR_MINTS = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
];

async function fetchBirdEyeOverview(mint) {
  const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
    headers: {
      'x-api-key': process.env.BIRDEYE_API_KEY,
      'x-chain': 'solana',
      accept: 'application/json',
    },
  });
  expect(r.ok).toBe(true);
  const j = await r.json();
  expect(j?.success).toBe(true);
  expect(j?.data).toBeTruthy();
  return j.data;
}

async function fetchDexPair(mint) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  const pair = (j?.pairs || [])
    .filter((p) => String(p?.chainId || '').toLowerCase() === 'solana')
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))[0];
  return pair || null;
}

function snapshotFromOverview(data, dexPair = null) {
  return {
    source: 'birdeye',
    priceUsd: Number(data?.price || dexPair?.priceUsd || 0),
    liquidityUsd: Number(data?.liquidity || dexPair?.liquidity?.usd || 0),
    marketCapUsd: Number(data?.marketCap || data?.fdv || dexPair?.marketCap || dexPair?.fdv || 0),
    volume_5m: Number(data?.v5mUSD || data?.v5m || 0),
    volume_30m_avg: Number(data?.v30mUSD || data?.v30m || 0) / 6,
    raw: data,
  };
}

describe('live pipeline metric paths (BirdEye -> momentum/confirm)', () => {
  it('hydrates non-zero core metrics for 5 popular Solana mints', async () => {
    if (!process.env.BIRDEYE_API_KEY) {
      throw new Error('BIRDEYE_API_KEY required for live pipeline data path test');
    }

    for (const coin of POPULAR_MINTS) {
      const [overview, dexPair] = await Promise.all([
        fetchBirdEyeOverview(coin.mint),
        fetchDexPair(coin.mint),
      ]);
      const snapshot = snapshotFromOverview(overview, dexPair);
      const pair = {
        baseToken: { address: coin.mint, symbol: coin.symbol },
        liquidity: { usd: Number(snapshot.liquidityUsd || 0) },
        marketCap: Number(snapshot.marketCapUsd || 0),
        birdeye: {},
      };

      const { normalized } = buildNormalizedMomentumInput({ snapshot, latest: {}, pair });
      const sig = evaluateMomentumSignal(normalized, { profile: 'normal', strict: false });
      const r = sig.reasons || {};

      const momentumMetrics = {
        liqUsd: Number(r.liqUsd || 0),
        mcapUsd: Number(r.mcapUsd || 0),
        volume5m: Number(r.volume5m || 0),
        volume30mAvg: Number(r.volume_30m_avg || 0),
        buySellRatio: Number(r.buySellRatio || 0),
        tx1m: Number(r.tx_1m || 0),
        tx5mAvg: Number(r.tx_5m_avg || 0),
        tx30mAvg: Number(r.tx_30m_avg || 0),
        tx1h: Number(r.tx_1h || 0),
        rollingHigh5m: Number(r.rolling_high_5m || 0),
      };

      for (const [name, value] of Object.entries(momentumMetrics)) {
        expect(Number.isFinite(value), `${coin.symbol} ${name} should be finite`).toBe(true);
        expect(value, `${coin.symbol} ${name} should be > 0 (avoid avoidable zero path)`).toBeGreaterThan(0);
      }

      const row = {
        latest: {
          tx1m: momentumMetrics.tx1m,
          tx5mAvg: momentumMetrics.tx5mAvg,
          tx30mAvg: momentumMetrics.tx30mAvg,
          buySellRatio: momentumMetrics.buySellRatio,
        },
      };
      const state = { watchlist: { mints: {} }, runtime: {} };
      const confirmTx = await resolveConfirmTxMetrics({
        state,
        row,
        snapshot,
        pair,
        mint: coin.mint,
        birdseye: null,
        snapshotFromBirdseye: (x) => x,
      });

      expect(Number(confirmTx.tx1m || 0), `${coin.symbol} confirm tx1m should be > 0`).toBeGreaterThan(0);
      expect(Number(confirmTx.tx5mAvg || 0), `${coin.symbol} confirm tx5mAvg should be > 0`).toBeGreaterThan(0);
      expect(Number(confirmTx.tx30mAvg || 0), `${coin.symbol} confirm tx30mAvg should be > 0`).toBeGreaterThan(0);
      expect(Number(confirmTx.buySellRatio || 0), `${coin.symbol} confirm buySellRatio should be > 0`).toBeGreaterThan(0);
    }
  }, 120_000);
});
