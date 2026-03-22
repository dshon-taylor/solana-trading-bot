import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../src/config.mjs';
import {
  decideMomentumBranch,
  applySnapshotToLatest,
  buildNormalizedMomentumInput,
  pruneMomentumRepeatFailMap,
} from '../src/watchlist_eval_helpers.mjs';

const REQUIRED_ENV = {
  HELIUS_API_KEY: 'x',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_CHAT_ID: '1',
};

const ENV_KEYS = [
  'HELIUS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'PRE_RUNNER_ENABLED',
  'PRE_RUNNER_TX_ACCEL_MIN',
  'BURST_PROMOTION_ENABLED',
  'HOT_ALLOW_AGE_PENDING',
  'HOT_MOMENTUM_MIN_LIQ_USD',
  'MOMENTUM_MICRO_MAX_AGE_MS',
  'MOMENTUM_PASS_STREAK_REQUIRED',
  'MOMENTUM_SCORE_PASS_THRESHOLD',
  'MAX_TOP10_PCT',
];

let envSnapshot = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, REQUIRED_ENV);
  for (const key of ENV_KEYS) {
    if (!(key in REQUIRED_ENV)) delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('watchlist_eval_helpers', () => {
  it('exposes hot-path config values through getConfig', () => {
    process.env.PRE_RUNNER_ENABLED = 'false';
    process.env.PRE_RUNNER_TX_ACCEL_MIN = '1.7';
    process.env.BURST_PROMOTION_ENABLED = 'false';
    process.env.HOT_ALLOW_AGE_PENDING = 'false';
    process.env.HOT_MOMENTUM_MIN_LIQ_USD = '45000';
    process.env.MOMENTUM_MICRO_MAX_AGE_MS = '8000';
    process.env.MOMENTUM_PASS_STREAK_REQUIRED = '3';
    process.env.MOMENTUM_SCORE_PASS_THRESHOLD = '72';
    process.env.MAX_TOP10_PCT = '41';

    const cfg = getConfig();

    expect(cfg.PRE_RUNNER_ENABLED).toBe(false);
    expect(cfg.PRE_RUNNER_TX_ACCEL_MIN).toBe(1.7);
    expect(cfg.BURST_PROMOTION_ENABLED).toBe(false);
    expect(cfg.HOT_ALLOW_AGE_PENDING).toBe(false);
    expect(cfg.HOT_MOMENTUM_MIN_LIQ_USD).toBe(45000);
    expect(cfg.MOMENTUM_MICRO_MAX_AGE_MS).toBe(8000);
    expect(cfg.MOMENTUM_PASS_STREAK_REQUIRED).toBe(3);
    expect(cfg.MOMENTUM_SCORE_PASS_THRESHOLD).toBe(72);
    expect(cfg.MAX_TOP10_PCT).toBe(41);
  });

  it('prunes stale repeat-fail entries and keeps newest when capped', () => {
    const nowMs = 1_000_000;
    const map = {
      stale: { tMs: nowMs - 100_000 },
      oldButValid: { tMs: nowMs - 10_000 },
      newest: { tMs: nowMs - 1_000 },
      middle: { tMs: nowMs - 5_000 },
    };

    pruneMomentumRepeatFailMap(map, { nowMs, staleAfterMs: 30_000, maxEntries: 2 });

    expect(Object.keys(map).sort()).toEqual(['middle', 'newest']);
  });

  it('applies snapshot fields onto latest without fabricating zero micro values', () => {
    const row = {
      latest: { marketDataSource: 'pair' },
      pair: { baseToken: { decimals: 9 } },
    };
    const snapshot = {
      marketCapUsd: 250000,
      liquidityUsd: 50000,
      priceUsd: 0.123,
      freshnessMs: 1200,
      source: 'birdseye',
      pairCreatedAt: 1_700_000_000,
      tx_1m: 14,
      tx_5m_avg: 5,
      buySellRatio: 1.8,
      volume_5m: 12000,
      uniqueBuyers1m: 7,
      uniqueBuyers5m: 20,
      rolling_high_5m: 0,
    };

    applySnapshotToLatest({ row, snapshot });

    expect(row.latest.mcapUsd).toBe(250000);
    expect(row.latest.liqUsd).toBe(50000);
    expect(row.latest.priceUsd).toBe(0.123);
    expect(row.latest.marketDataFreshnessMs).toBe(1200);
    expect(row.latest.marketDataSource).toBe('birdseye');
    expect(row.latest.tx1m).toBe(14);
    expect(row.latest.tx5mAvg).toBe(5);
    expect(row.latest.buySellRatio).toBe(1.8);
    expect(row.latest.volume5m).toBe(12000);
    expect(row.latest.uniqueBuyers1m).toBe(7);
    expect(row.latest.rollingHigh5m).toBeUndefined();
  });

  it('builds normalized momentum input with latest-over-snapshot precedence for micro fields', () => {
    const pair = {
      priceUsd: 0.2,
      liquidity: { usd: 15000 },
      marketCap: 100000,
      volume: { h1: 5000, h4: 15000 },
      txns: { h1: { buys: 20, sells: 10 } },
      priceChange: { h1: 12, h4: 20 },
      birdeye: { volume_5m: 2000, tx_1m: 4 },
    };
    const latest = {
      priceUsd: 0.25,
      liqUsd: 18000,
      mcapUsd: 125000,
      volume5m: 9000,
      tx1m: 11,
      buySellRatio: 2.2,
    };
    const snapshot = {
      priceUsd: 0.22,
      liquidityUsd: 17000,
      marketCapUsd: 120000,
      volume_5m: 7000,
      tx_1m: 9,
      buySellRatio: 1.9,
    };

    const res = buildNormalizedMomentumInput({ snapshot, latest, pair });

    expect(res.normalized.priceUsd).toBe(0.22);
    expect(res.normalized.liquidity.usd).toBe(17000);
    expect(res.normalized.marketCap).toBe(120000);
    expect(res.normalized.birdeye.volume_5m).toBe(9000);
    expect(res.normalized.birdeye.tx_1m).toBe(11);
    expect(res.normalized.birdeye.buySellRatio).toBe(2.2);
    expect(res.sourceUsed).toBe('snapshot+merged');
    expect(res.microSourceUsed).toBe('latest');
    expect(res.presentFields).toBeGreaterThan(0);
  });

  it('classifies early, mature, and missing-age momentum branches', () => {
    expect(decideMomentumBranch(5)).toEqual({
      agePresent: true,
      matureTokenMode: false,
      earlyTokenMode: true,
      breakoutBranchUsed: 'early_2_of_3',
    });
    expect(decideMomentumBranch(45)).toEqual({
      agePresent: true,
      matureTokenMode: true,
      earlyTokenMode: false,
      breakoutBranchUsed: 'mature_3_of_4',
    });
    expect(decideMomentumBranch(null)).toEqual({
      agePresent: false,
      matureTokenMode: true,
      earlyTokenMode: false,
      breakoutBranchUsed: 'missingAge_strict_3_of_4',
    });
  });
});
