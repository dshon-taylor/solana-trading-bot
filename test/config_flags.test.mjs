import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../src/config.mjs';

const REQUIRED = {
  HELIUS_API_KEY: 'x',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_CHAT_ID: '1',
};

const ENV_KEYS = [
  'HELIUS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'DATA_CAPTURE_ENABLED',
  'EXECUTION_ENABLED',
  'SIM_TRACKING_ENABLED',
  'TRACK_ENABLED',
  'FORCE_TRADING_ENABLED',
  'SOURCE_MODE',
  'SOURCE_QUALITY_JUP_SAMPLE_N',
  'SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE',
  'ROUTE_ALT_ENABLED',
  'ROUTE_ALT_MIN_LIQ_USD',
  'ROUTE_ALT_MAX_PRICE_IMPACT_PCT',
  'ROUTE_ALT_RAYDIUM_ENABLED',
  'BIRDEYE_LITE_ENABLED',
  'BIRDEYE_API_KEY',
  'BIRDEYE_LITE_MAX_RPS',
  'AGGRESSIVE_MODE',
  'LIVE_CONVERSION_PROFILE_ENABLED',
  'LIVE_PARALLEL_QUOTE_FANOUT_N',
  'LIVE_CANDIDATE_SHORTLIST_N',
  'LIVE_REJECT_RECHECK_PASSES',
  'LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED',
  'MOMENTUM_PROFILE',
  'PAPER_USE_LIVE_PROCESS',
  'PAPER_ENTRY_RET_15M_PCT',
  'PAPER_ENTRY_RET_5M_PCT',
  'PAPER_ENTRY_GREEN_LAST5',
  'PAPER_ENTRY_COOLDOWN_MS',
  'MOMENTUM_FALLBACK_ENABLED',
  'WATCHLIST_EVICT_MAX_AGE_HOURS',
  'WATCHLIST_EVICT_STALE_CYCLES',
  'DEBUG_CANARY_ENABLED',
  'DEBUG_CANARY_VERBOSE',
  'DEBUG_CANARY_COOLDOWN_MS',
  'LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS',
  'LIVE_FAST_STOP_REENTRY_WINDOW_MS',
  'LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH',
  'LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS',
  'LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS',
];

let snapshot = {};

beforeEach(() => {
  snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, REQUIRED);
  delete process.env.DATA_CAPTURE_ENABLED;
  delete process.env.EXECUTION_ENABLED;
  delete process.env.SIM_TRACKING_ENABLED;
  delete process.env.TRACK_ENABLED;
  delete process.env.FORCE_TRADING_ENABLED;
});

afterEach(() => {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('pass1 config flags', () => {
  it('uses sane defaults', () => {
    const cfg = getConfig();
    expect(cfg.DATA_CAPTURE_ENABLED).toBe(true);
    expect(cfg.EXECUTION_ENABLED).toBe(false);
    expect(cfg.SIM_TRACKING_ENABLED).toBe(true);
    expect(cfg.CAPITAL_SOFT_RESERVE_SOL).toBe(0.01);
    expect(cfg.MAX_NEW_ENTRIES_PER_HOUR).toBe(0);
    expect(cfg.PLAYBOOK_ENABLED).toBe(true);
    expect(cfg.SOURCE_MODE).toBe('mixed');
    expect(cfg.SOURCE_QUALITY_JUP_SAMPLE_N).toBe(8);
    expect(cfg.SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE).toBe(true);
    expect(cfg.ROUTE_ALT_ENABLED).toBe(true);
    expect(cfg.ROUTE_ALT_MIN_LIQ_USD).toBe(18000);
    expect(cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT).toBe(4);
    expect(cfg.ROUTE_ALT_RAYDIUM_ENABLED).toBe(true);
    expect(cfg.BIRDEYE_LITE_ENABLED).toBe(false);
    expect(cfg.BIRDEYE_LITE_MAX_RPS).toBe(12);
    expect(cfg.AGGRESSIVE_MODE).toBe(false);
    expect(cfg.LIVE_CONVERSION_PROFILE_ENABLED).toBe(false);
    expect(cfg.LIVE_PARALLEL_QUOTE_FANOUT_N).toBe(0);
    expect(cfg.LIVE_CANDIDATE_SHORTLIST_N).toBe(18);
    expect(cfg.LIVE_REJECT_RECHECK_PASSES).toBe(1);
    expect(cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED).toBe(false);
    expect(cfg.WATCHLIST_EVICT_MAX_AGE_HOURS).toBe(48);
    expect(cfg.WATCHLIST_EVICT_STALE_CYCLES).toBe(24);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_ENABLED).toBe(true);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MODE).toBe('standard');
    expect(cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE).toBe(true);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD).toBe(15000);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_TX1H).toBe(12);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD).toBe(100);
    expect(cfg.MOMENTUM_PROFILE).toBe('normal');
    expect(cfg.PAPER_USE_LIVE_PROCESS).toBe(true);
    expect(cfg.MOMENTUM_FALLBACK_ENABLED).toBe(false);
    expect(cfg.PAPER_ENTRY_RET_15M_PCT).toBe(0.12);
    expect(cfg.PAPER_ENTRY_RET_5M_PCT).toBe(0.04);
    expect(cfg.PAPER_ENTRY_GREEN_LAST5).toBe(4);
    expect(cfg.DEBUG_CANARY_ENABLED).toBe(false);
    expect(cfg.DEBUG_CANARY_VERBOSE).toBe(true);
    expect(cfg.DEBUG_CANARY_COOLDOWN_MS).toBe(60_000);
    expect(cfg.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS).toBe(45_000);
    expect(cfg.LIVE_FAST_STOP_REENTRY_WINDOW_MS).toBe(180_000);
    expect(cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH).toBe(true);
    expect(cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS).toBe(true);
    expect(cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS).toBe(2);
  });

  it('aggressive mode applies high-throughput overrides with single-toggle rollback', () => {
    process.env.AGGRESSIVE_MODE = 'true';
    const cfg = getConfig();
    expect(cfg.AGGRESSIVE_MODE).toBe(true);
    expect(cfg.LIVE_CONVERSION_PROFILE_ENABLED).toBe(true);
    expect(cfg.LIVE_PARALLEL_QUOTE_FANOUT_N).toBeGreaterThanOrEqual(6);
    expect(cfg.LIVE_CANDIDATE_SHORTLIST_N).toBeGreaterThanOrEqual(30);
    expect(cfg.LIVE_REJECT_RECHECK_PASSES).toBeGreaterThanOrEqual(3);
    expect(cfg.WATCHLIST_EVICT_MAX_AGE_HOURS).toBe(24);
    expect(cfg.WATCHLIST_EVICT_STALE_CYCLES).toBe(12);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MODE).toBe('minimal');
    expect(cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE).toBe(true);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD).toBe(1200);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_TX1H).toBe(1);
    expect(cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD).toBe(5);
    expect(cfg.MOMENTUM_PROFILE).toBe('aggressive');
    expect(cfg.PAPER_ENTRY_RET_15M_PCT).toBeLessThan(0.12);
    expect(cfg.PAPER_ENTRY_RET_5M_PCT).toBeLessThan(0.04);
    expect(cfg.PAPER_ENTRY_GREEN_LAST5).toBeLessThan(4);
    expect(cfg.PAPER_ENTRY_COOLDOWN_MS).toBeLessThan(30 * 60_000);
  });

  it('keeps backward compatibility for FORCE_TRADING_ENABLED and TRACK_ENABLED', () => {
    process.env.FORCE_TRADING_ENABLED = 'true';
    process.env.TRACK_ENABLED = 'false';
    const cfg = getConfig();
    expect(cfg.EXECUTION_ENABLED).toBe(true);
    expect(cfg.SIM_TRACKING_ENABLED).toBe(false);
  });

  it('supports debug canary feature flags', () => {
    process.env.DEBUG_CANARY_ENABLED = 'true';
    process.env.DEBUG_CANARY_VERBOSE = 'false';
    process.env.DEBUG_CANARY_COOLDOWN_MS = '9000';
    const cfg = getConfig();
    expect(cfg.DEBUG_CANARY_ENABLED).toBe(true);
    expect(cfg.DEBUG_CANARY_VERBOSE).toBe(false);
    expect(cfg.DEBUG_CANARY_COOLDOWN_MS).toBe(9000);
  });

  it('supports fast-stop reentry flags', () => {
    process.env.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS = '60000';
    process.env.LIVE_FAST_STOP_REENTRY_WINDOW_MS = '240000';
    process.env.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH = 'false';
    process.env.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS = 'false';
    process.env.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS = '4';
    const cfg = getConfig();
    expect(cfg.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS).toBe(60_000);
    expect(cfg.LIVE_FAST_STOP_REENTRY_WINDOW_MS).toBe(240_000);
    expect(cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH).toBe(false);
    expect(cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS).toBe(false);
    expect(cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS).toBe(4);
  });

  it('supports route alternative flags', () => {
    process.env.ROUTE_ALT_ENABLED = 'false';
    process.env.ROUTE_ALT_MIN_LIQ_USD = '25000';
    process.env.ROUTE_ALT_MAX_PRICE_IMPACT_PCT = '5.5';
    process.env.ROUTE_ALT_RAYDIUM_ENABLED = 'false';
    const cfg = getConfig();
    expect(cfg.ROUTE_ALT_ENABLED).toBe(false);
    expect(cfg.ROUTE_ALT_MIN_LIQ_USD).toBe(25_000);
    expect(cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT).toBe(5.5);
    expect(cfg.ROUTE_ALT_RAYDIUM_ENABLED).toBe(false);
  });

  it('supports paper/live process parity flag', () => {
    process.env.PAPER_USE_LIVE_PROCESS = 'false';
    const cfg = getConfig();
    expect(cfg.PAPER_USE_LIVE_PROCESS).toBe(false);
  });

  it('validates SOURCE_MODE values', () => {
    process.env.SOURCE_MODE = 'bad_mode';
    expect(() => getConfig()).toThrow(/SOURCE_MODE/);
  });

  it('requires Birdseye key when Birdseye is enabled', () => {
    process.env.BIRDEYE_LITE_ENABLED = 'true';
    delete process.env.BIRDEYE_API_KEY;
    expect(() => getConfig()).toThrow(/BIRDEYE_API_KEY/);
  });
});
