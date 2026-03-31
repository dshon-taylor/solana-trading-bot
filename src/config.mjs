import assert from 'node:assert/strict';
import { getPaperRulesFromMomentumRules } from './rules.mjs';

function assertFiniteNumber(x, msg) {
  if (!Number.isFinite(Number(x))) throw new Error(msg);
}

function validateConfig(cfg) {
  // Catch the most common production foot-guns early.
  assert(cfg.HELIUS_API_KEY, 'Missing HELIUS_API_KEY');
  assert(cfg.TELEGRAM_BOT_TOKEN, 'Missing TELEGRAM_BOT_TOKEN');
  assert(cfg.TELEGRAM_CHAT_ID, 'Missing TELEGRAM_CHAT_ID');

  // Basic numeric sanity.
  for (const [k, v] of Object.entries(cfg)) {
    if (k.endsWith('_MS') || k.endsWith('_BPS') || k.endsWith('_PCT') || k.endsWith('_USD') || k.endsWith('_USDC')) {
      // Most of our numeric envs follow these suffix conventions.
      // We allow 0 in some cases (e.g. PORTFOLIO_STOP_USDC=0 disables stop).
      if (typeof v === 'number') assertFiniteNumber(v, `Invalid number for ${k}`);
    }
  }

  if (cfg.LIVE_MOMO_SIZE_MODE && !['usd', 'percent'].includes(cfg.LIVE_MOMO_SIZE_MODE)) {
    throw new Error(`Invalid LIVE_MOMO_SIZE_MODE='${cfg.LIVE_MOMO_SIZE_MODE}' (expected 'usd'|'percent')`);
  }
  if (cfg.SOURCE_MODE && !['mixed', 'quality_first'].includes(cfg.SOURCE_MODE)) {
    throw new Error(`Invalid SOURCE_MODE='${cfg.SOURCE_MODE}' (expected 'mixed'|'quality_first')`);
  }
  if (cfg.MOMENTUM_PROFILE && !['normal', 'aggressive'].includes(cfg.MOMENTUM_PROFILE)) {
    throw new Error(`Invalid MOMENTUM_PROFILE='${cfg.MOMENTUM_PROFILE}' (expected 'normal'|'aggressive')`);
  }
  if (cfg.BIRDEYE_LITE_ENABLED && !cfg.BIRDEYE_API_KEY) {
    throw new Error('BIRDEYE_LITE_ENABLED=true requires BIRDEYE_API_KEY');
  }
  if (cfg.STREAMING_PROVIDER_MODE && !['existing', 'laserstream-devnet'].includes(cfg.STREAMING_PROVIDER_MODE)) {
    throw new Error(`Invalid STREAMING_PROVIDER_MODE='${cfg.STREAMING_PROVIDER_MODE}' (expected 'existing'|'laserstream-devnet')`);
  }
  if (cfg.EARLY_SHORTLIST_PREFILTER_MODE && !['off', 'minimal', 'standard'].includes(cfg.EARLY_SHORTLIST_PREFILTER_MODE)) {
    throw new Error(`Invalid EARLY_SHORTLIST_PREFILTER_MODE='${cfg.EARLY_SHORTLIST_PREFILTER_MODE}' (expected 'off'|'minimal'|'standard')`);
  }

  // Cadence and loop sanity.
  if (cfg.SCAN_EVERY_MS <= 0) throw new Error('SCAN_EVERY_MS must be > 0');
  if (cfg.SCAN_BACKOFF_MAX_MS < cfg.SCAN_EVERY_MS) throw new Error('SCAN_BACKOFF_MAX_MS must be >= SCAN_EVERY_MS');
  if (cfg.PAIR_CACHE_MAX_AGE_MS <= 0) throw new Error('PAIR_CACHE_MAX_AGE_MS must be > 0');
  if (cfg.WATCHLIST_MAX_SIZE < 10) throw new Error('WATCHLIST_MAX_SIZE must be >= 10');
  if (cfg.WATCHLIST_EVAL_EVERY_MS <= 200) throw new Error('WATCHLIST_EVAL_EVERY_MS must be > 200');
  if (!Number.isInteger(cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE) || cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE < 0 || cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE > 24) {
    throw new Error('WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE must be an integer between 0 and 24');
  }
  if (cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS < 0) throw new Error('WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS must be >= 0');
  if (cfg.WATCHLIST_MINT_TTL_MS <= 0) throw new Error('WATCHLIST_MINT_TTL_MS must be > 0');
  if (cfg.WATCHLIST_EVICT_MAX_AGE_HOURS <= 0) throw new Error('WATCHLIST_EVICT_MAX_AGE_HOURS must be > 0');
  if (!Number.isInteger(cfg.WATCHLIST_EVICT_STALE_CYCLES) || cfg.WATCHLIST_EVICT_STALE_CYCLES < 1) {
    throw new Error('WATCHLIST_EVICT_STALE_CYCLES must be an integer >= 1');
  }
  if (!Number.isInteger(cfg.WATCHLIST_HOT_QUEUE_MAX) || cfg.WATCHLIST_HOT_QUEUE_MAX < 8 || cfg.WATCHLIST_HOT_QUEUE_MAX > cfg.WATCHLIST_MAX_SIZE) {
    throw new Error('WATCHLIST_HOT_QUEUE_MAX must be an integer between 8 and WATCHLIST_MAX_SIZE');
  }
  if (cfg.ROUTE_CACHE_TTL_MS <= 0) throw new Error('ROUTE_CACHE_TTL_MS must be > 0');
  if (!Number.isInteger(cfg.ROUTE_CACHE_MAX_SIZE) || cfg.ROUTE_CACHE_MAX_SIZE < 8) {
    throw new Error('ROUTE_CACHE_MAX_SIZE must be an integer >= 8');
  }
  if (cfg.POSITIONS_EVERY_MS <= 0) throw new Error('POSITIONS_EVERY_MS must be > 0');
  if (cfg.HEARTBEAT_EVERY_MS <= 0) throw new Error('HEARTBEAT_EVERY_MS must be > 0');
  if (cfg.TELEGRAM_POLL_EVERY_MS <= 0) throw new Error('TELEGRAM_POLL_EVERY_MS must be > 0');

  // Common range checks (avoid silent nonsense).
  if (cfg.MAX_POSITIONS < 0 || !Number.isInteger(cfg.MAX_POSITIONS)) throw new Error('MAX_POSITIONS must be an integer >= 0');
  if (cfg.STARTING_CAPITAL_USDC <= 0) throw new Error('STARTING_CAPITAL_USDC must be > 0');
  if (cfg.MAX_POSITION_USDC <= 0) throw new Error('MAX_POSITION_USDC must be > 0');
  if (cfg.MAX_POSITION_USDC > cfg.STARTING_CAPITAL_USDC) throw new Error('MAX_POSITION_USDC must be <= STARTING_CAPITAL_USDC');

  if (cfg.MAX_DRAWDOWN_PCT < 0 || cfg.MAX_DRAWDOWN_PCT > 1) throw new Error('MAX_DRAWDOWN_PCT must be between 0 and 1');
  if (cfg.PORTFOLIO_STOP_USDC < 0) throw new Error('PORTFOLIO_STOP_USDC must be >= 0');
  if (cfg.MIN_SOL_FOR_FEES < 0) throw new Error('MIN_SOL_FOR_FEES must be >= 0');
  if (cfg.CAPITAL_SOFT_RESERVE_SOL < 0) throw new Error('CAPITAL_SOFT_RESERVE_SOL must be >= 0');
  if (cfg.CAPITAL_RETRY_BUFFER_PCT < 0 || cfg.CAPITAL_RETRY_BUFFER_PCT > 1) throw new Error('CAPITAL_RETRY_BUFFER_PCT must be between 0 and 1');
  if (cfg.MAX_NEW_ENTRIES_PER_HOUR < 0) throw new Error('MAX_NEW_ENTRIES_PER_HOUR must be >= 0');

  if (cfg.MIN_LIQUIDITY_FLOOR_USD < 0) throw new Error('MIN_LIQUIDITY_FLOOR_USD must be >= 0');
  if (cfg.MIN_MCAP_USD < 0) throw new Error('MIN_MCAP_USD must be >= 0');
  if (cfg.MIN_TOKEN_AGE_HOURS < 0) throw new Error('MIN_TOKEN_AGE_HOURS must be >= 0');

  if (cfg.PAIR_FETCH_CONCURRENCY < 1 || cfg.PAIR_FETCH_CONCURRENCY > 8) throw new Error('PAIR_FETCH_CONCURRENCY must be between 1 and 8');
  if (cfg.LIVE_PARALLEL_QUOTE_FANOUT_N < 0 || cfg.LIVE_PARALLEL_QUOTE_FANOUT_N > 8) throw new Error('LIVE_PARALLEL_QUOTE_FANOUT_N must be between 0 and 8');
  if (cfg.LIVE_REJECT_RECHECK_BURST_ATTEMPTS < 1 || cfg.LIVE_REJECT_RECHECK_BURST_ATTEMPTS > 8) throw new Error('LIVE_REJECT_RECHECK_BURST_ATTEMPTS must be between 1 and 8');
  if (cfg.LIVE_REJECT_RECHECK_BURST_DELAY_MS < 50) throw new Error('LIVE_REJECT_RECHECK_BURST_DELAY_MS must be >= 50');
  if (cfg.LIVE_CANDIDATE_SHORTLIST_N < 6 || cfg.LIVE_CANDIDATE_SHORTLIST_N > 48) throw new Error('LIVE_CANDIDATE_SHORTLIST_N must be between 6 and 48');
  if (cfg.LIVE_REJECT_RECHECK_PASSES < 1 || cfg.LIVE_REJECT_RECHECK_PASSES > 4) throw new Error('LIVE_REJECT_RECHECK_PASSES must be between 1 and 4');
  if (cfg.LIVE_REJECT_RECHECK_PASS_DELAY_MS < 10 || cfg.LIVE_REJECT_RECHECK_PASS_DELAY_MS > 1000) throw new Error('LIVE_REJECT_RECHECK_PASS_DELAY_MS must be between 10 and 1000');
  if (cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS < 10 || cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS > 400) throw new Error('LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS must be between 10 and 400');
  if (cfg.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS < 50 || cfg.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS > 2000) throw new Error('LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS must be between 50 and 2000');
  if (cfg.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS < cfg.DEFAULT_SLIPPAGE_BPS) throw new Error('LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS must be >= DEFAULT_SLIPPAGE_BPS');
  if (cfg.LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT < 0.1 || cfg.LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT > 8) throw new Error('LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT must be between 0.1 and 8');
  if (cfg.AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT < 0.1 || cfg.AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT > 8) throw new Error('AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT must be between 0.1 and 8');
  if (cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS < 1_000) throw new Error('FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS must be >= 1000');
  if (cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR < 1 || cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR > 60) {
    throw new Error('FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR must be between 1 and 60');
  }
  if (cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE < 1 || cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE > 120) {
    throw new Error('FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE must be between 1 and 120');
  }

  if (cfg.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD < 0) throw new Error('EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD must be >= 0');
  if (cfg.EARLY_SHORTLIST_PREFILTER_MIN_TX1H < 0) throw new Error('EARLY_SHORTLIST_PREFILTER_MIN_TX1H must be >= 0');
  if (cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD < 0) throw new Error('EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD must be >= 0');
  if (cfg.ROUTE_ALT_MIN_LIQ_USD < 0) throw new Error('ROUTE_ALT_MIN_LIQ_USD must be >= 0');
  if (cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT < 0.1 || cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT > 25) {
    throw new Error('ROUTE_ALT_MAX_PRICE_IMPACT_PCT must be between 0.1 and 25');
  }

  if (cfg.LIQUIDITY_TO_MCAP_RATIO < 0 || cfg.LIQUIDITY_TO_MCAP_RATIO > 1) {
    throw new Error('LIQUIDITY_TO_MCAP_RATIO must be between 0 and 1');
  }

  // Live execution guard: if live swaps are enabled, require an explicit opt-in.
  if (cfg.LIVE_MOMO_ENABLED && !cfg.FORCE_TRADING_ENABLED) {
    throw new Error('LIVE_MOMO_ENABLED=true requires FORCE_TRADING_ENABLED=true (explicit operator opt-in)');
  }

  if (cfg.PLAYBOOK_RESTART_THRESHOLD < 0 || cfg.PLAYBOOK_ERROR_THRESHOLD < 0) throw new Error('PLAYBOOK thresholds must be >= 0');
  if (cfg.PLAYBOOK_RESTART_WINDOW_MS <= 0 || cfg.PLAYBOOK_ERROR_WINDOW_MS <= 0) throw new Error('PLAYBOOK windows must be > 0');
  if (cfg.PLAYBOOK_STABLE_RECOVERY_MS <= 0) throw new Error('PLAYBOOK_STABLE_RECOVERY_MS must be > 0');

  return cfg;
}

export function summarizeConfigForBoot(cfg) {
  // Intentionally omit secrets.
  const lines = [];
  lines.push('[config] effective');
  lines.push(`  rpc=${cfg.SOLANA_RPC_URL ? 'set' : 'missing'}`);
  lines.push(`  modes: data_capture=${cfg.DATA_CAPTURE_ENABLED} execution=${cfg.EXECUTION_ENABLED} sim_tracking=${cfg.SIM_TRACKING_ENABLED} live_momo=${cfg.LIVE_MOMO_ENABLED} tracker_live_exec=${cfg.TRACKER_LIVE_EXECUTION_ENABLED} paper=${cfg.PAPER_ENABLED} scanner_entries=${cfg.SCANNER_ENTRIES_ENABLED} tracking=${cfg.SCANNER_TRACKING_ENABLED} trackResultAlerts=${cfg.TRACK_RESULT_ALERTS_ENABLED}`);
  lines.push(`  cadence: scanEveryMs=${cfg.SCAN_EVERY_MS} positionsEveryMs=${cfg.POSITIONS_EVERY_MS} heartbeatEveryMs=${cfg.HEARTBEAT_EVERY_MS}`);
  lines.push(`  diag: retentionDays=${cfg.DIAG_RETENTION_DAYS} retentionMs=${cfg.DIAG_RETENTION_MS}`);
  lines.push(`  watchlist: mode=${cfg.WATCHLIST_TRIGGER_MODE} maxSize=${cfg.WATCHLIST_MAX_SIZE} hotQueueMax=${cfg.WATCHLIST_HOT_QUEUE_MAX} hotTtlMs=${cfg.HOT_TTL_MS} eval(cold=${cfg.COLD_EVAL_MIN_MS}-${cfg.COLD_EVAL_MAX_MS}ms hot=${cfg.HOT_EVAL_MIN_MS}-${cfg.HOT_EVAL_MAX_MS}ms confirm=${cfg.CONFIRM_DELAY_MIN_MS}-${cfg.CONFIRM_DELAY_MAX_MS}ms) evalEveryMs=${cfg.WATCHLIST_EVAL_EVERY_MS} immediateMaxPerCycle=${cfg.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE} immediateDedupMs=${cfg.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS} mintTtlMs=${cfg.WATCHLIST_MINT_TTL_MS} evictMaxAgeHours=${cfg.WATCHLIST_EVICT_MAX_AGE_HOURS} staleCycles=${cfg.WATCHLIST_EVICT_STALE_CYCLES} rollback=WATCHLIST_TRIGGER_MODE=false`);
  lines.push(`  debugCanary: enabled=${cfg.DEBUG_CANARY_ENABLED} verbose=${cfg.DEBUG_CANARY_VERBOSE} cooldownMs=${cfg.DEBUG_CANARY_COOLDOWN_MS}`);
  lines.push(`  conversionCanary: mode=${cfg.CONVERSION_CANARY_MODE} cooldownMs=${cfg.CONVERSION_CANARY_COOLDOWN_MS} tracePath=${cfg.CONVERSION_CANARY_TRACE_PATH} bypassMomentum=${cfg.CANARY_BYPASS_MOMENTUM ? 'on' : 'off'} until=${cfg.CANARY_BYPASS_MOMENTUM_UNTIL_ISO || 'n/a'} momoSamplePerMin=${cfg.CANARY_MOMO_FAIL_SAMPLE_PER_MIN} momoDiagWindowMin=${cfg.MOMENTUM_DIAG_WINDOW_MIN}`);
  lines.push(`  routeCache: enabled=${cfg.ROUTE_CACHE_ENABLED} ttlMs=${cfg.ROUTE_CACHE_TTL_MS} maxSize=${cfg.ROUTE_CACHE_MAX_SIZE}`);
  lines.push(`  reliability: pairCacheMaxAgeMs=${cfg.PAIR_CACHE_MAX_AGE_MS} adaptiveScanMaxMs=${cfg.SCAN_BACKOFF_MAX_MS}`);
  lines.push(`  sources: mode=${cfg.SOURCE_MODE} qualityJupSampleN=${cfg.SOURCE_QUALITY_JUP_SAMPLE_N} qualityTrendingSampleN=${cfg.SOURCE_QUALITY_TRENDING_SAMPLE_N} qualityRequireQuoteable=${cfg.SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE} trendingEnabled=${cfg.TRENDING_ENABLED} trendingRefreshMs=${cfg.TRENDING_REFRESH_MS} birdeye=${cfg.BIRDEYE_LITE_ENABLED} rps=${cfg.BIRDEYE_LITE_MAX_RPS}`);
  lines.push(`  streaming: provider=${cfg.STREAMING_PROVIDER_MODE} laserEnabled=${cfg.LASERSTREAM_ENABLED} staging=${cfg.LASERSTREAM_STAGING_MODE} rollback=LASERSTREAM_ENABLED=false STREAMING_PROVIDER_MODE=existing`);
  lines.push(`  jup: tokenlist=${cfg.JUP_TOKENLIST_ENABLED} prefilter=${cfg.JUP_PREFILTER_ENABLED} amountUsd=${cfg.JUP_PREFILTER_AMOUNT_USD} altRoute(enabled=${cfg.ROUTE_ALT_ENABLED} minLiqUsd=${cfg.ROUTE_ALT_MIN_LIQ_USD} maxPiPct=${cfg.ROUTE_ALT_MAX_PRICE_IMPACT_PCT})`);
  lines.push(`  circuit: enabled=${cfg.CIRCUIT_BREAKER_ENABLED} cooldownMs=${cfg.CIRCUIT_COOLDOWN_MS} fails(dex=${cfg.CIRCUIT_FAILS_DEX}, rpc=${cfg.CIRCUIT_FAILS_RPC}, jup=${cfg.CIRCUIT_FAILS_JUP})`);
  lines.push(`  risk: stopAtEntry=${cfg.LIVE_MOMO_STOP_AT_ENTRY} bufferPct=${cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT} stopArmDelayMs=${cfg.LIVE_STOP_ARM_DELAY_MS} prearmCatStopPct=${cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT} trailActivatePct=${cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT} trailDistancePct=${cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT} fastStop(maxAgeMs=${cfg.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS}, blockMs=${cfg.LIVE_FAST_STOP_REENTRY_WINDOW_MS}, requireNewHigh=${cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH}, requireTradeUpticks=${cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS}, minUpticks=${cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS})`);
  lines.push(`  feeReserveSol=${cfg.MIN_SOL_FOR_FEES} softReserveSol=${cfg.CAPITAL_SOFT_RESERVE_SOL} retryBufferPct=${cfg.CAPITAL_RETRY_BUFFER_PCT} maxNewEntriesPerHour=${cfg.MAX_NEW_ENTRIES_PER_HOUR}`);
  lines.push(`  playbook: enabled=${cfg.PLAYBOOK_ENABLED} restart(threshold=${cfg.PLAYBOOK_RESTART_THRESHOLD},windowMs=${cfg.PLAYBOOK_RESTART_WINDOW_MS}) error(threshold=${cfg.PLAYBOOK_ERROR_THRESHOLD},windowMs=${cfg.PLAYBOOK_ERROR_WINDOW_MS}) stableRecoveryMs=${cfg.PLAYBOOK_STABLE_RECOVERY_MS}`);
  lines.push(`  slippageBps=${cfg.DEFAULT_SLIPPAGE_BPS} maxPriceImpactPct=${cfg.MAX_PRICE_IMPACT_PCT}`);
  lines.push(`  profile: aggressive=${cfg.AGGRESSIVE_MODE} momentum=${cfg.MOMENTUM_PROFILE} rollback=AGGRESSIVE_MODE=false MOMENTUM_PROFILE=normal MOMENTUM_FALLBACK_ENABLED=false`);
  lines.push(`  confirm: maxPriceImpactPct=${cfg.EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT} maxSnapshotAgeMs=${cfg.CONFIRM_SNAPSHOT_MAX_AGE_MS} requireTxAccelAndBuyDom=${cfg.CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM} txAccelMin=${cfg.CONFIRM_TX_ACCEL_MIN} buySellMin=${cfg.CONFIRM_BUY_SELL_MIN} (base=${cfg.LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT} aggressive=${cfg.AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT})`);
  lines.push(`  riskKills: earlyFailure=${cfg.EARLY_FAILURE_KILL_ENABLED} (${cfg.EARLY_FAILURE_KILL_MIN_MS}-${cfg.EARLY_FAILURE_KILL_MAX_MS}ms belowEntry) hardStopCooldown=${cfg.HARD_STOP_COOLDOWN_ENABLED} x${cfg.HARD_STOP_COOLDOWN_TRIGGER_COUNT}/${cfg.HARD_STOP_COOLDOWN_WINDOW_MS}ms => pause ${cfg.HARD_STOP_COOLDOWN_PAUSE_MS}ms`);
  lines.push(`  holdersGate: new<=${cfg.HOLDER_TIER_NEW_MAX_AGE_SEC}s min=${cfg.HOLDER_TIER_MIN_NEW} mature min=${cfg.HOLDER_TIER_MIN_MATURE} missingSoftAllow=${cfg.HOLDER_MISSING_SOFT_ALLOW}`);
  lines.push(`  forceAttemptOnConfirmPass: enabled=${cfg.FORCE_ATTEMPT_POLICY_ACTIVE} cooldownMs=${cfg.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS} mintCapPerHour=${cfg.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR} globalCapPerMin=${cfg.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE} rollback=FORCE_ATTEMPT_ON_CONFIRM_PASS=false`);
  lines.push(`  momentum: ret15=${cfg.PAPER_ENTRY_RET_15M_PCT} ret5=${cfg.PAPER_ENTRY_RET_5M_PCT} greens=${cfg.PAPER_ENTRY_GREEN_LAST5} cooldownMs=${cfg.PAPER_ENTRY_COOLDOWN_MS}`);
  lines.push(`  fallback: enabled=${cfg.MOMENTUM_FALLBACK_ENABLED} tolerance=${cfg.MOMENTUM_FALLBACK_TOLERANCE} minLiqUsd=${cfg.MOMENTUM_FALLBACK_MIN_LIQ_USD} minTx1h=${cfg.MOMENTUM_FALLBACK_MIN_TX1H}`);
  lines.push(`  conversionProfile: enabled=${cfg.LIVE_CONVERSION_PROFILE_ENABLED} pairFetchConcurrency=${cfg.PAIR_FETCH_CONCURRENCY} fanoutN=${cfg.LIVE_PARALLEL_QUOTE_FANOUT_N} shortlistN=${cfg.LIVE_CANDIDATE_SHORTLIST_N} recheckBurst=${cfg.LIVE_REJECT_RECHECK_BURST_ENABLED} recheckPasses=${cfg.LIVE_REJECT_RECHECK_PASSES} slippageRetry=${cfg.LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED} probeConfirm=${cfg.LIVE_PROBE_CONFIRM_ENABLED}`);
  lines.push(`  shortlistPrefilter: mode=${cfg.EARLY_SHORTLIST_PREFILTER_MODE} enabled=${cfg.EARLY_SHORTLIST_PREFILTER_ACTIVE} minLiqUsd=${cfg.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD} minTx1h=${cfg.EARLY_SHORTLIST_PREFILTER_MIN_TX1H} minBoostUsd=${cfg.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD}`);
  lines.push(`  paths: state=${cfg.STATE_PATH} tradesLedger=${cfg.TRADES_LEDGER_PATH} costLedger=${cfg.LEDGER_PATH}`);
  return lines.join('\n');
}

export function getConfig() {
  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  assert(HELIUS_API_KEY, 'Missing HELIUS_API_KEY');

  const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  assert(TELEGRAM_BOT_TOKEN, 'Missing TELEGRAM_BOT_TOKEN');
  assert(TELEGRAM_CHAT_ID, 'Missing TELEGRAM_CHAT_ID');

  // Trading rules
  const STARTING_CAPITAL_USDC = Number(process.env.STARTING_CAPITAL_USDC || 100);
  const MAX_POSITION_USDC = Number(process.env.MAX_POSITION_USDC || 20);
  const MAX_POSITIONS = Number(process.env.MAX_POSITIONS || 2);
  const MIN_LIQUIDITY_FLOOR_USD = Number(process.env.MIN_LIQUIDITY_FLOOR_USD || 100_000);
  const LIQUIDITY_TO_MCAP_RATIO = Number(process.env.LIQUIDITY_TO_MCAP_RATIO || 0.33);
  const MIN_MCAP_USD = Number(process.env.MIN_MCAP_USD || 300_000);
  const MIN_TOKEN_AGE_HOURS = Number(process.env.MIN_TOKEN_AGE_HOURS || 24);

  // Portfolio safety controls (set PORTFOLIO_STOP_USDC=0 and MAX_DRAWDOWN_PCT=1 to effectively disable)
  const PORTFOLIO_STOP_USDC = Number(process.env.PORTFOLIO_STOP_USDC ?? 75);
  const MAX_DRAWDOWN_PCT = Number(process.env.MAX_DRAWDOWN_PCT ?? 0.25);
  const MIN_SOL_FOR_FEES = Number(process.env.MIN_SOL_FOR_FEES ?? 0.06);
  const CAPITAL_SOFT_RESERVE_SOL = Number(process.env.CAPITAL_SOFT_RESERVE_SOL ?? 0.01);
  const CAPITAL_RETRY_BUFFER_PCT = Number(process.env.CAPITAL_RETRY_BUFFER_PCT ?? 0.10);
  const MAX_NEW_ENTRIES_PER_HOUR = Number(process.env.MAX_NEW_ENTRIES_PER_HOUR ?? 0);

  const DEFAULT_SLIPPAGE_BPS = 250; // 2.5%

  const SCAN_EVERY_MS = Number(process.env.SCAN_EVERY_MS || 20_000);
  const SCAN_BACKOFF_MAX_MS = Number(process.env.SCAN_BACKOFF_MAX_MS || 5 * 60_000);
  const PAIR_CACHE_MAX_AGE_MS = Number(process.env.PAIR_CACHE_MAX_AGE_MS || 7 * 60_000);
  const WATCHLIST_TRIGGER_MODE = (process.env.WATCHLIST_TRIGGER_MODE ?? 'false') === 'true';
  const WATCHLIST_MAX_SIZE = Math.max(10, Number(process.env.WATCHLIST_MAX_SIZE || 300));
  const WATCHLIST_EVAL_EVERY_MS = Math.max(250, Number(process.env.WATCHLIST_EVAL_EVERY_MS || 3000));
  const WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE = Math.max(0, Math.min(24, Math.floor(Number(process.env.WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE ?? 4))));
  const WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS = Math.max(0, Number(process.env.WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS ?? 15_000));
  const WATCHLIST_MINT_TTL_MS = Math.max(60_000, Number(process.env.WATCHLIST_MINT_TTL_MS || (45 * 60_000)));
  const watchlistAggressiveDefaults = (process.env.AGGRESSIVE_MODE ?? 'false') === 'true';
  const WATCHLIST_EVICT_MAX_AGE_HOURS = Math.max(0.25, Number(process.env.WATCHLIST_EVICT_MAX_AGE_HOURS || (watchlistAggressiveDefaults ? 24 : 48)));
  const WATCHLIST_EVICT_STALE_CYCLES = Math.max(1, Math.floor(Number(process.env.WATCHLIST_EVICT_STALE_CYCLES || (watchlistAggressiveDefaults ? 12 : 24))));
  const WATCHLIST_HOT_QUEUE_MAX = Math.max(8, Number(process.env.WATCHLIST_HOT_QUEUE_MAX || Math.min(WATCHLIST_MAX_SIZE, 72)));
  const HOT_TTL_MS = Math.max(300_000, Number(process.env.HOT_TTL_MS || 600_000));
  const HOT_EVAL_MIN_MS = Math.max(500, Number(process.env.HOT_EVAL_MIN_MS || 500));
  const HOT_EVAL_MAX_MS = Math.max(HOT_EVAL_MIN_MS, Number(process.env.HOT_EVAL_MAX_MS || 1000));
  const COLD_EVAL_MIN_MS = Math.max(15_000, Number(process.env.COLD_EVAL_MIN_MS || 15000));
  const COLD_EVAL_MAX_MS = Math.max(COLD_EVAL_MIN_MS, Number(process.env.COLD_EVAL_MAX_MS || 30000));
  const CONFIRM_DELAY_MIN_MS = Math.max(200, Number(process.env.CONFIRM_DELAY_MIN_MS || 200));
  const CONFIRM_DELAY_MAX_MS = Math.max(CONFIRM_DELAY_MIN_MS, Number(process.env.CONFIRM_DELAY_MAX_MS || 400));
  const ROUTE_CACHE_ENABLED = (process.env.ROUTE_CACHE_ENABLED ?? 'true') === 'true';
  const ROUTE_CACHE_TTL_MS = Math.max(500, Number(process.env.ROUTE_CACHE_TTL_MS || 12_000));
  const ROUTE_CACHE_MAX_SIZE = Math.max(8, Number(process.env.ROUTE_CACHE_MAX_SIZE || 512));
  const DEBUG_CANARY_ENABLED = (process.env.DEBUG_CANARY_ENABLED ?? 'false') === 'true';
  const DEBUG_CANARY_VERBOSE = (process.env.DEBUG_CANARY_VERBOSE ?? 'true') === 'true';
  const DEBUG_CANARY_COOLDOWN_MS = Math.max(1_000, Number(process.env.DEBUG_CANARY_COOLDOWN_MS ?? 60_000));
  const CONVERSION_CANARY_MODE = (process.env.CONVERSION_CANARY_MODE ?? 'false') === 'true';
  const CONVERSION_CANARY_COOLDOWN_MS = Math.max(1_000, Number(process.env.CONVERSION_CANARY_COOLDOWN_MS ?? DEBUG_CANARY_COOLDOWN_MS));
  const CONVERSION_CANARY_TRACE_PATH = process.env.CONVERSION_CANARY_TRACE_PATH || './analysis/canary_trace.jsonl';

  const CANARY_BYPASS_MOMENTUM = (process.env.CANARY_BYPASS_MOMENTUM ?? 'false') === 'true';
  const CANARY_BYPASS_MOMENTUM_UNTIL_ISO = process.env.CANARY_BYPASS_MOMENTUM_UNTIL_ISO || null;
  // Canary momentum failure diagnostics (low-noise). 0 = unlimited.
  const CANARY_MOMO_FAIL_SAMPLE_PER_MIN = Math.max(0, Number(process.env.CANARY_MOMO_FAIL_SAMPLE_PER_MIN ?? 6));
  const MOMENTUM_DIAG_WINDOW_MIN = Math.max(1, Number(process.env.MOMENTUM_DIAG_WINDOW_MIN ?? 30));
  const PRE_RUNNER_ENABLED = (process.env.PRE_RUNNER_ENABLED ?? 'true') === 'true';
  const PRE_RUNNER_TX_ACCEL_MIN = Math.max(0, Number(process.env.PRE_RUNNER_TX_ACCEL_MIN || 1.2));
  const PRE_RUNNER_WALLET_EXPANSION_MIN = Math.max(0, Number(process.env.PRE_RUNNER_WALLET_EXPANSION_MIN || 1.25));
  const PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN = Math.max(0, Number(process.env.PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN || 1.5));
  const PRE_RUNNER_FAST_WINDOW_MS = Math.max(30_000, Number(process.env.PRE_RUNNER_FAST_WINDOW_MS || 60_000));
  const PRE_RUNNER_EVAL_MIN_MS = Math.max(500, Number(process.env.PRE_RUNNER_EVAL_MIN_MS || 500));
  const PRE_RUNNER_EVAL_MAX_MS = Math.max(PRE_RUNNER_EVAL_MIN_MS, Number(process.env.PRE_RUNNER_EVAL_MAX_MS || 1000));
  const BURST_PROMOTION_ENABLED = (process.env.BURST_PROMOTION_ENABLED ?? 'true') === 'true';
  const BURST_TX_ACCEL_MIN = Math.max(0, Number(process.env.BURST_TX_ACCEL_MIN || 1.1));
  const BURST_WALLET_EXPANSION_MIN = Math.max(0, Number(process.env.BURST_WALLET_EXPANSION_MIN || 1.1));
  const BURST_VOLUME_EXPANSION_MIN = Math.max(0, Number(process.env.BURST_VOLUME_EXPANSION_MIN || 1.0));
  const BURST_FAST_WINDOW_MS = Math.max(30_000, Number(process.env.BURST_FAST_WINDOW_MS || 45_000));
  const BURST_EVAL_MIN_MS = Math.max(500, Number(process.env.BURST_EVAL_MIN_MS || 500));
  const BURST_EVAL_MAX_MS = Math.max(BURST_EVAL_MIN_MS, Number(process.env.BURST_EVAL_MAX_MS || 1000));
  const HOT_MIN_ABS_TX1H_HEALTHY = Math.max(0, Number(process.env.HOT_MIN_ABS_TX1H_HEALTHY || 120));
  const HOT_MIN_ABS_VOLUME_5M_HEALTHY = Math.max(0, Number(process.env.HOT_MIN_ABS_VOLUME_5M_HEALTHY || 15000));
  const HOT_MOMENTUM_MIN_LIQ_USD = Math.max(0, Number(process.env.HOT_MOMENTUM_MIN_LIQ_USD || 40_000));
  const HOT_MCAP_REFRESH_RETRIES = Math.max(1, Math.min(2, Number(process.env.HOT_MCAP_REFRESH_RETRIES || 2)));
  const HOT_MCAP_REFRESH_DELAY_MS = Math.max(100, Math.min(800, Number(process.env.HOT_MCAP_REFRESH_DELAY_MS || 220)));
  const HOT_MCAP_REFRESH_WINDOW_MS = Math.max(500, Math.min(5000, Number(process.env.HOT_MCAP_REFRESH_WINDOW_MS || 1800)));
  const HOT_ALLOW_AGE_PENDING = (process.env.HOT_ALLOW_AGE_PENDING ?? 'true') === 'true';
  const HOT_AGE_PENDING_MAX_EVALS = Math.max(1, Number(process.env.HOT_AGE_PENDING_MAX_EVALS || 3));
  const HOT_AGE_PENDING_MAX_MS = Math.max(1, Number(process.env.HOT_AGE_PENDING_MAX_MS || 180000));
  const HOT_AGE_PENDING_COOLDOWN_MS = Math.max(1, Number(process.env.HOT_AGE_PENDING_COOLDOWN_MS || 300000));
  const MINT_AGE_LOOKUP_RETRY_MS = Math.max(5_000, Number(process.env.MINT_AGE_LOOKUP_RETRY_MS || 30_000));
  const MOMENTUM_MICRO_MAX_AGE_MS = Math.max(1000, Number(process.env.MOMENTUM_MICRO_MAX_AGE_MS || 10_000));
  const MOMENTUM_REQUIRE_FRESH_MICRO = (process.env.MOMENTUM_REQUIRE_FRESH_MICRO ?? 'true') === 'true';
  const MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE = Math.max(1, Number(process.env.MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE || 3));
  const MOMENTUM_PASS_STREAK_REQUIRED = Math.max(1, Number(process.env.MOMENTUM_PASS_STREAK_REQUIRED || 1));
  const MOMENTUM_PASS_STREAK_RESET_MS = Math.max(30_000, Number(process.env.MOMENTUM_PASS_STREAK_RESET_MS || (10 * 60_000)));
  const MOMENTUM_TX_ACCEL_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_TX_ACCEL_MIN_RATIO || 1.0));
  const MOMENTUM_VOLUME_EXPANSION_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_VOLUME_EXPANSION_MIN_RATIO || 1.0));
  const MOMENTUM_WALLET_EXPANSION_MIN_RATIO = Math.max(0, Number(process.env.MOMENTUM_WALLET_EXPANSION_MIN_RATIO || 1.25));
  const MOMENTUM_SCORE_PASS_THRESHOLD = Math.max(0, Number(process.env.MOMENTUM_SCORE_PASS_THRESHOLD || 60));
  const MAX_TOP10_PCT = Number(process.env.MAX_TOP10_PCT || 38);
  const MAX_TOP_HOLDER_PCT = Number(process.env.MAX_TOP_HOLDER_PCT || 3.5);
  const MAX_BUNDLE_CLUSTER_PCT = Number(process.env.MAX_BUNDLE_CLUSTER_PCT || 15);
  const POSITIONS_EVERY_MS = 10_000;
  const HEARTBEAT_EVERY_MS = 300_000;
  const DEBUG_REJECTIONS = (process.env.DEBUG_REJECTIONS || 'false').toLowerCase() === 'true';
  const DEBUG_REJECTIONS_EVERY_MS = Number(process.env.DEBUG_REJECTIONS_EVERY_MS || 300_000);

  const STATE_PATH = process.env.STATE_PATH || './state/state.json';
  const TRADING_LOG_PATH = process.env.TRADING_LOG_PATH || './trading.md';
  const LEDGER_PATH = process.env.LEDGER_PATH || './state/cost.jsonl';

  const TELEGRAM_POLL_EVERY_MS = Number(process.env.TELEGRAM_POLL_EVERY_MS || 3000);

  // Telegram visibility pings (scan cycle + candidate sources). Useful for debugging, noisy in steady-state.
  const TG_VISIBILITY_PINGS = (process.env.TG_VISIBILITY_PINGS ?? 'true') === 'true';

  // Entry engines
  const SCANNER_ENTRIES_ENABLED = (process.env.SCANNER_ENTRIES_ENABLED ?? 'true') === 'true';
  const SCANNER_TRACKING_ENABLED = (process.env.SCANNER_TRACKING_ENABLED ?? 'true') === 'true';

  const AUTO_TUNE_ENABLED = (process.env.AUTO_TUNE_ENABLED || 'true').toLowerCase() === 'true';
  const AUTO_TUNE_EVERY_MS = Number(process.env.AUTO_TUNE_EVERY_MS || 3600000);

  const HOURLY_DIAG_ENABLED = (process.env.HOURLY_DIAG_ENABLED || 'true').toLowerCase() === 'true';
  const HOURLY_DIAG_EVERY_MS = Number(process.env.HOURLY_DIAG_EVERY_MS || 3600000);
  const DIAG_RETENTION_DAYS = Math.max(1, Number(process.env.DIAG_RETENTION_DAYS || 90));
  const DIAG_RETENTION_MS = Math.max(
    60 * 60_000,
    Number(process.env.DIAG_MAX_WINDOW_MS || (DIAG_RETENTION_DAYS * 24 * 60 * 60_000))
  );

  // Filter gates (turn off anything not in the current strategy)
  const REQUIRE_SOCIAL_META = (process.env.REQUIRE_SOCIAL_META ?? 'false') === 'true';
  const AI_PIPELINE_ENABLED = (process.env.AI_PIPELINE_ENABLED ?? 'false') === 'true';
  const MOMENTUM_FILTER_ENABLED = (process.env.MOMENTUM_FILTER_ENABLED ?? 'true') === 'true';
  const RUGCHECK_ENABLED = (process.env.RUGCHECK_ENABLED ?? 'true') === 'true';
  const BASE_FILTERS_ENABLED = (process.env.BASE_FILTERS_ENABLED ?? 'true') === 'true';
  const MCAP_FILTER_ENABLED = (process.env.MCAP_FILTER_ENABLED ?? 'true') === 'true';
  const LIQ_RATIO_FILTER_ENABLED = (process.env.LIQ_RATIO_FILTER_ENABLED ?? 'true') === 'true';
  const FORCE_TRADING_ENABLED = (process.env.FORCE_TRADING_ENABLED ?? 'false') === 'true';
  const DATA_CAPTURE_ENABLED = (process.env.DATA_CAPTURE_ENABLED ?? 'true') === 'true';
  const EXECUTION_ENABLED = (process.env.EXECUTION_ENABLED ?? process.env.FORCE_TRADING_ENABLED ?? 'false') === 'true';
  const SIM_TRACKING_ENABLED = (process.env.SIM_TRACKING_ENABLED ?? process.env.TRACK_ENABLED ?? 'true') === 'true';

  const MAX_PRICE_IMPACT_PCT = Number(process.env.MAX_PRICE_IMPACT_PCT || 2.5);
  const MAX_QUOTE_DEGRADE_PCT = Number(process.env.MAX_QUOTE_DEGRADE_PCT || 0.10);

  // Aggressive entry profile: single toggle that expands attempt throughput.
  const AGGRESSIVE_MODE = (process.env.AGGRESSIVE_MODE ?? 'false') === 'true';

  // High-conversion live profile (feature flagged; default off)
  const LIVE_CONVERSION_PROFILE_ENABLED_RAW = (process.env.LIVE_CONVERSION_PROFILE_ENABLED ?? 'false') === 'true';
  const LIVE_PARALLEL_QUOTE_FANOUT_N_RAW = Math.max(0, Math.min(8, Number(process.env.LIVE_PARALLEL_QUOTE_FANOUT_N ?? 0)));
  const LIVE_REJECT_RECHECK_BURST_ENABLED_RAW = (process.env.LIVE_REJECT_RECHECK_BURST_ENABLED ?? 'false') === 'true';
  const LIVE_REJECT_RECHECK_BURST_ATTEMPTS_RAW = Math.max(1, Math.min(8, Number(process.env.LIVE_REJECT_RECHECK_BURST_ATTEMPTS ?? 2)));
  const LIVE_REJECT_RECHECK_BURST_DELAY_MS_RAW = Math.max(50, Math.min(2000, Number(process.env.LIVE_REJECT_RECHECK_BURST_DELAY_MS ?? 140)));
  const LIVE_CANDIDATE_SHORTLIST_N_RAW = Math.max(6, Math.min(48, Number(process.env.LIVE_CANDIDATE_SHORTLIST_N ?? 18)));
  const LIVE_REJECT_RECHECK_PASSES_RAW = Math.max(1, Math.min(4, Number(process.env.LIVE_REJECT_RECHECK_PASSES ?? 1)));
  const LIVE_REJECT_RECHECK_PASS_DELAY_MS_RAW = Math.max(10, Math.min(1000, Number(process.env.LIVE_REJECT_RECHECK_PASS_DELAY_MS ?? 80)));

  const LIVE_CONVERSION_PROFILE_ENABLED = LIVE_CONVERSION_PROFILE_ENABLED_RAW || AGGRESSIVE_MODE;
  const PAIR_FETCH_CONCURRENCY_RAW = Math.max(1, Math.min(8, Number(process.env.PAIR_FETCH_CONCURRENCY ?? 2)));
  const PAIR_FETCH_CONCURRENCY = AGGRESSIVE_MODE ? Math.max(PAIR_FETCH_CONCURRENCY_RAW, 5) : PAIR_FETCH_CONCURRENCY_RAW;
  const LIVE_PARALLEL_QUOTE_FANOUT_N = AGGRESSIVE_MODE ? Math.max(LIVE_PARALLEL_QUOTE_FANOUT_N_RAW, 6) : LIVE_PARALLEL_QUOTE_FANOUT_N_RAW;
  const LIVE_REJECT_RECHECK_BURST_ENABLED = LIVE_REJECT_RECHECK_BURST_ENABLED_RAW || AGGRESSIVE_MODE;
  const LIVE_REJECT_RECHECK_BURST_ATTEMPTS = AGGRESSIVE_MODE ? Math.max(LIVE_REJECT_RECHECK_BURST_ATTEMPTS_RAW, 4) : LIVE_REJECT_RECHECK_BURST_ATTEMPTS_RAW;
  const LIVE_REJECT_RECHECK_BURST_DELAY_MS = AGGRESSIVE_MODE ? Math.min(LIVE_REJECT_RECHECK_BURST_DELAY_MS_RAW, 90) : LIVE_REJECT_RECHECK_BURST_DELAY_MS_RAW;
  const LIVE_CANDIDATE_SHORTLIST_N = AGGRESSIVE_MODE ? Math.max(LIVE_CANDIDATE_SHORTLIST_N_RAW, 30) : LIVE_CANDIDATE_SHORTLIST_N_RAW;
  const LIVE_REJECT_RECHECK_PASSES = AGGRESSIVE_MODE ? Math.max(LIVE_REJECT_RECHECK_PASSES_RAW, 3) : LIVE_REJECT_RECHECK_PASSES_RAW;
  const LIVE_REJECT_RECHECK_PASS_DELAY_MS = AGGRESSIVE_MODE ? Math.min(LIVE_REJECT_RECHECK_PASS_DELAY_MS_RAW, 60) : LIVE_REJECT_RECHECK_PASS_DELAY_MS_RAW;
  const LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED = (process.env.LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED ?? 'false') === 'true';
  const LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS = Math.max(10, Math.min(400, Number(process.env.LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS ?? 80)));
  const LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS = Math.max(50, Math.min(2000, Number(process.env.LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS ?? 400)));
  const LIVE_PROBE_CONFIRM_ENABLED = (process.env.LIVE_PROBE_CONFIRM_ENABLED ?? 'false') === 'true';
  const LIVE_PROBE_MAX_CANDIDATES = Math.max(1, Math.min(30, Number(process.env.LIVE_PROBE_MAX_CANDIDATES ?? 12)));
  const LIVE_PROBE_MIN_LIQ_USD = Math.max(0, Number(process.env.LIVE_PROBE_MIN_LIQ_USD ?? 8000));
  const LIVE_PROBE_MIN_TX1H = Math.max(0, Number(process.env.LIVE_PROBE_MIN_TX1H ?? 8));
  const LIVE_CONFIRM_MIN_LIQ_USD = Math.max(0, Number(process.env.LIVE_CONFIRM_MIN_LIQ_USD ?? 10000));
  const LIVE_ATTEMPT_MIN_LIQ_USD = Math.max(0, Number(process.env.LIVE_ATTEMPT_MIN_LIQ_USD ?? LIVE_CONFIRM_MIN_LIQ_USD));
  const ENTRY_MIN_MCAP_USD = Math.max(0, Number(process.env.ENTRY_MIN_MCAP_USD ?? 120000));
  const ENTRY_MIN_LIQUIDITY_USD = Math.max(0, Number(process.env.ENTRY_MIN_LIQUIDITY_USD ?? 30000));
  const LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT = Math.max(0.1, Math.min(8, Number(process.env.LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT ?? 2.5)));
  const AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT = Math.max(0.1, Math.min(8, Number(process.env.AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT ?? 4.0)));
  const EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT = AGGRESSIVE_MODE
    ? Math.max(LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT, AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT)
    : LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT;
  const LOW_LIQ_STRICT_MOMENTUM_UNDER_USD = Number(process.env.LOW_LIQ_STRICT_MOMENTUM_UNDER_USD || 25000);

  const EARLY_SHORTLIST_PREFILTER_ENABLED = (process.env.EARLY_SHORTLIST_PREFILTER_ENABLED ?? 'true') === 'true';
  const AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD = Math.max(0, Number(process.env.AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD ?? 1200));
  const AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_TX1H = Math.max(0, Number(process.env.AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_TX1H ?? 1));
  const AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD = Math.max(0, Number(process.env.AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD ?? 5));
  const EARLY_SHORTLIST_PREFILTER_MODE_RAW = String(process.env.EARLY_SHORTLIST_PREFILTER_MODE || '').trim().toLowerCase();
  const AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MODE_RAW = String(process.env.AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MODE || '').trim().toLowerCase();
  const EARLY_SHORTLIST_PREFILTER_MODE = (
    (AGGRESSIVE_MODE && AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MODE_RAW) ? AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MODE_RAW : EARLY_SHORTLIST_PREFILTER_MODE_RAW
  ) || (AGGRESSIVE_MODE ? 'minimal' : 'standard');
  const EARLY_SHORTLIST_PREFILTER_ACTIVE = EARLY_SHORTLIST_PREFILTER_MODE === 'off' ? false : EARLY_SHORTLIST_PREFILTER_ENABLED;
  const EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD = Math.max(0, Number(process.env.EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD ?? (AGGRESSIVE_MODE ? AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD : 15000)));
  const EARLY_SHORTLIST_PREFILTER_MIN_TX1H = Math.max(0, Number(process.env.EARLY_SHORTLIST_PREFILTER_MIN_TX1H ?? (AGGRESSIVE_MODE ? AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_TX1H : 12)));
  const EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD = Math.max(0, Number(process.env.EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD ?? (AGGRESSIVE_MODE ? AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD : 100)));

  const SOURCE_MODE = (process.env.SOURCE_MODE || 'mixed').toLowerCase(); // mixed|quality_first
  const SOURCE_QUALITY_JUP_SAMPLE_N = Number(process.env.SOURCE_QUALITY_JUP_SAMPLE_N || 8);
  const SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE = (process.env.SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE ?? 'true') === 'true';
  const BIRDEYE_LITE_ENABLED = (process.env.BIRDEYE_LITE_ENABLED ?? 'false') === 'true';
  const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
  const BIRDEYE_LITE_MAX_RPS = Math.max(1, Math.min(15, Number(process.env.BIRDEYE_LITE_MAX_RPS ?? 12)));
  const BIRDEYE_LITE_CHAIN = String(process.env.BIRDEYE_LITE_CHAIN || 'solana').trim().toLowerCase() || 'solana';
  // Birdseye Lite CU/request control (per mint)
  // BirdEye lite caching and per-mint minimum interval (migration defaults)
  const BIRDEYE_LITE_CACHE_TTL_MS = Math.max(0, Number(process.env.BIRDEYE_LITE_CACHE_TTL_MS ?? 45_000));
  const BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS = Math.max(0, Number(process.env.BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS ?? 25_000));
  // Used for synchronous (bounded) entry price hydration when an otherwise-eligible entry is missing a safe snapshot.
  const BIRDEYE_ENTRY_FETCH_TIMEOUT_MS = Math.max(250, Number(process.env.BIRDEYE_ENTRY_FETCH_TIMEOUT_MS || 2500));

  // Staging-only stream provider abstraction (existing polling vs laserstream-devnet).
  const STREAMING_PROVIDER_MODE = (process.env.STREAMING_PROVIDER_MODE || 'existing').toLowerCase(); // existing|laserstream-devnet
  const LASERSTREAM_ENABLED = (process.env.LASERSTREAM_ENABLED ?? 'false') === 'true';
  const LASERSTREAM_STAGING_MODE = (process.env.LASERSTREAM_STAGING_MODE ?? 'false') === 'true';
  const LASERSTREAM_DEVNET_WS_URL = process.env.LASERSTREAM_DEVNET_WS_URL || `wss://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const LASERSTREAM_DEVNET_RPC_URL = process.env.LASERSTREAM_DEVNET_RPC_URL || `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const LASERSTREAM_PROGRAM_IDS = String(process.env.LASERSTREAM_PROGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const LASERSTREAM_RECONNECT_BASE_MS = Number(process.env.LASERSTREAM_RECONNECT_BASE_MS || 1_000);
  const LASERSTREAM_RECONNECT_MAX_MS = Number(process.env.LASERSTREAM_RECONNECT_MAX_MS || 15_000);
  const LASERSTREAM_REPLAY_LOOKBACK_SECONDS = Number(process.env.LASERSTREAM_REPLAY_LOOKBACK_SECONDS || 120);
  const LASERSTREAM_HEARTBEAT_STALE_MS = Number(process.env.LASERSTREAM_HEARTBEAT_STALE_MS || 15_000);
  const LASERSTREAM_BUFFER_MAX = Number(process.env.LASERSTREAM_BUFFER_MAX || 2_000);

  const TRENDING_ENABLED = (process.env.TRENDING_ENABLED ?? 'true') === 'true';
  const TRENDING_REFRESH_MS = Number(process.env.TRENDING_REFRESH_MS || 90_000);
  const SOURCE_QUALITY_TRENDING_SAMPLE_N = Number(process.env.SOURCE_QUALITY_TRENDING_SAMPLE_N || 10);

  const JUP_TOKENLIST_ENABLED = (process.env.JUP_TOKENLIST_ENABLED || 'true').toLowerCase() === 'true';
  const JUP_TOKENLIST_URL = process.env.JUP_TOKENLIST_URL || 'https://cache.jup.ag/tokens';
  const JUP_TOKENLIST_CACHE_MS = Number(process.env.JUP_TOKENLIST_CACHE_MS || 6 * 60 * 60_000);
  const JUP_TOKENLIST_SAMPLE_N = Number(process.env.JUP_TOKENLIST_SAMPLE_N || 30);

  const JUP_PREFILTER_ENABLED = (process.env.JUP_PREFILTER_ENABLED || 'true').toLowerCase() === 'true';
  const JUP_PREFILTER_AMOUNT_USD = Number(process.env.JUP_PREFILTER_AMOUNT_USD || 5);
  const ROUTE_ALT_ENABLED = (process.env.ROUTE_ALT_ENABLED ?? 'true') === 'true';
  const ROUTE_ALT_MIN_LIQ_USD = Math.max(0, Number(process.env.ROUTE_ALT_MIN_LIQ_USD ?? 18_000));
  const ROUTE_ALT_MAX_PRICE_IMPACT_PCT = Math.max(0.1, Number(process.env.ROUTE_ALT_MAX_PRICE_IMPACT_PCT ?? 4.0));

  const CANDIDATE_LEDGER_DIR = process.env.CANDIDATE_LEDGER_DIR || './state/candidates';
  const CANDIDATE_LEDGER_RETENTION_DAYS = Number(process.env.CANDIDATE_LEDGER_RETENTION_DAYS || 180);

  const TRADES_LEDGER_PATH = process.env.TRADES_LEDGER_PATH || './state/trades.jsonl';

  // Ops hygiene: JSONL ledger retention / rotation (best-effort)
  const JSONL_RETENTION_DAYS = Number(process.env.JSONL_RETENTION_DAYS || 30);
  const JSONL_ROTATE_MAX_BYTES = Number(process.env.JSONL_ROTATE_MAX_BYTES || (25 * 1024 * 1024)); // 25MB

  // Alive ping (use e.g. https://healthchecks.io or a custom webhook)
  const ALIVE_PING_URL = process.env.ALIVE_PING_URL || '';
  const ALIVE_PING_EVERY_MS = Number(process.env.ALIVE_PING_EVERY_MS || 24 * 60 * 60_000);

  // Circuit breaker: pause entries after repeated dependency failures
  const CIRCUIT_BREAKER_ENABLED = (process.env.CIRCUIT_BREAKER_ENABLED ?? 'true') === 'true';
  const CIRCUIT_FAILS_DEX = Number(process.env.CIRCUIT_FAILS_DEX || 4);
  const CIRCUIT_FAILS_RPC = Number(process.env.CIRCUIT_FAILS_RPC || 3);
  const CIRCUIT_FAILS_JUP = Number(process.env.CIRCUIT_FAILS_JUP || 5);
  const CIRCUIT_COOLDOWN_MS = Number(process.env.CIRCUIT_COOLDOWN_MS || 60 * 60_000);

  // Incident playbook: auto-shift to degraded mode on restart/error patterns, then self-recover.
  const PLAYBOOK_ENABLED = (process.env.PLAYBOOK_ENABLED ?? 'true') === 'true';
  const PLAYBOOK_RESTART_THRESHOLD = Number(process.env.PLAYBOOK_RESTART_THRESHOLD ?? 3);
  const PLAYBOOK_RESTART_WINDOW_MS = Number(process.env.PLAYBOOK_RESTART_WINDOW_MS ?? 15 * 60_000);
  const PLAYBOOK_ERROR_THRESHOLD = Number(process.env.PLAYBOOK_ERROR_THRESHOLD ?? 8);
  const PLAYBOOK_ERROR_WINDOW_MS = Number(process.env.PLAYBOOK_ERROR_WINDOW_MS ?? 10 * 60_000);
  const PLAYBOOK_STABLE_RECOVERY_MS = Number(process.env.PLAYBOOK_STABLE_RECOVERY_MS ?? 20 * 60_000);

  // Paper momentum trading (no live swaps; logs hypothetical entries/exits)
  const PAPER_ENABLED = (process.env.PAPER_ENABLED ?? 'false') === 'true';

  // Live momentum mode (executes swaps; uses same entry thresholds as PAPER_*)
  const LIVE_MOMO_ENABLED = (process.env.LIVE_MOMO_ENABLED ?? 'false') === 'true';
  const LIVE_MOMO_USD_TARGET = Number(process.env.LIVE_MOMO_USD_TARGET || 20);
  const LIVE_MOMO_USD_MIN = Number(process.env.LIVE_MOMO_USD_MIN || 2);
  const LIVE_MOMO_USD_MAX = Number(process.env.LIVE_MOMO_USD_MAX || 7);
  const LIVE_MOMO_SIZE_MODE = (process.env.LIVE_MOMO_SIZE_MODE || 'usd').toLowerCase(); // usd|percent
  const LIVE_MOMO_PCT_OF_PORTFOLIO = Number(process.env.LIVE_MOMO_PCT_OF_PORTFOLIO || 0.20);
  const LIVE_MOMO_MAX_SOL_PER_TRADE = Number(process.env.LIVE_MOMO_MAX_SOL_PER_TRADE || 1.0);
  const LIVE_MOMO_STOP_AT_ENTRY = (process.env.LIVE_MOMO_STOP_AT_ENTRY ?? 'true') === 'true';
  const LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT = Number(process.env.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT || 0.0005); // 0.05%
  const LIVE_STOP_ARM_DELAY_MS = Math.max(0, Number(process.env.LIVE_STOP_ARM_DELAY_MS || 0));
  const LIVE_PREARM_CATASTROPHIC_STOP_PCT = Math.max(0, Number(process.env.LIVE_PREARM_CATASTROPHIC_STOP_PCT || 0.07));
  const LIVE_MOMO_TRAIL_ACTIVATE_PCT = Number(process.env.LIVE_MOMO_TRAIL_ACTIVATE_PCT || 0.10);
  const LIVE_MOMO_TRAIL_DISTANCE_PCT = Number(process.env.LIVE_MOMO_TRAIL_DISTANCE_PCT || 0.12);
  const LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS = Math.max(0, Number(process.env.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS || 45_000));
  const LIVE_FAST_STOP_REENTRY_WINDOW_MS = Math.max(0, Number(process.env.LIVE_FAST_STOP_REENTRY_WINDOW_MS || 180_000));
  const LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH = (process.env.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH ?? 'true') === 'true';
  const LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS = (process.env.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS ?? 'true') === 'true';
  const LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS = Math.max(1, Number(process.env.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2));

  const CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM = (process.env.CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM ?? 'true') === 'true';
  const CONFIRM_TX_ACCEL_MIN = Math.max(0, Number(process.env.CONFIRM_TX_ACCEL_MIN || 1.0));
  const CONFIRM_BUY_SELL_MIN = Math.max(0, Number(process.env.CONFIRM_BUY_SELL_MIN || 1.2));
  const CONFIRM_SNAPSHOT_MAX_AGE_MS = Math.max(250, Number(process.env.CONFIRM_SNAPSHOT_MAX_AGE_MS || 5_000));
  const ATTEMPT_PER_MINT_COOLDOWN_MS = Math.max(0, Number(process.env.ATTEMPT_PER_MINT_COOLDOWN_MS || 1_800_000));
  const ATTEMPT_NEW_HIGH_MULTIPLIER = Math.max(1, Number(process.env.ATTEMPT_NEW_HIGH_MULTIPLIER || 1.03));
  const ATTEMPT_LIQ_EXPAND_MULTIPLIER = Math.max(1, Number(process.env.ATTEMPT_LIQ_EXPAND_MULTIPLIER || 1.20));

  const EARLY_FAILURE_KILL_ENABLED = (process.env.EARLY_FAILURE_KILL_ENABLED ?? 'true') === 'true';
  const EARLY_FAILURE_KILL_MIN_MS = Math.max(15_000, Number(process.env.EARLY_FAILURE_KILL_MIN_MS || 60_000));
  const EARLY_FAILURE_KILL_MAX_MS = Math.max(EARLY_FAILURE_KILL_MIN_MS, Number(process.env.EARLY_FAILURE_KILL_MAX_MS || 90_000));

  const HARD_STOP_COOLDOWN_ENABLED = (process.env.HARD_STOP_COOLDOWN_ENABLED ?? 'true') === 'true';
  const HARD_STOP_COOLDOWN_TRIGGER_COUNT = Math.max(2, Number(process.env.HARD_STOP_COOLDOWN_TRIGGER_COUNT || 3));
  const HARD_STOP_COOLDOWN_WINDOW_MS = Math.max(60_000, Number(process.env.HARD_STOP_COOLDOWN_WINDOW_MS || (15 * 60_000)));
  const HARD_STOP_COOLDOWN_PAUSE_MS = Math.max(60_000, Number(process.env.HARD_STOP_COOLDOWN_PAUSE_MS || (20 * 60_000)));

  const HOLDER_TIER_NEW_MAX_AGE_SEC = Math.max(60, Number(process.env.HOLDER_TIER_NEW_MAX_AGE_SEC || 1800));
  const HOLDER_TIER_MIN_NEW = Math.max(0, Number(process.env.HOLDER_TIER_MIN_NEW || 400));
  const HOLDER_TIER_MIN_MATURE = Math.max(HOLDER_TIER_MIN_NEW, Number(process.env.HOLDER_TIER_MIN_MATURE || 900));
  const HOLDER_MISSING_SOFT_ALLOW = (process.env.HOLDER_MISSING_SOFT_ALLOW ?? 'true') === 'true';

  const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

  // Momentum profile + entry thresholds (paper engine). Live momo uses the same thresholds.
  const MOMENTUM_PROFILE = (process.env.MOMENTUM_PROFILE || (AGGRESSIVE_MODE ? 'aggressive' : 'normal')).toLowerCase(); // normal|aggressive
  const AGGRESSIVE_PAPER_ENTRY_RET_15M_PCT = Number(process.env.AGGRESSIVE_PAPER_ENTRY_RET_15M_PCT || 0.035);
  const AGGRESSIVE_PAPER_ENTRY_RET_5M_PCT = Number(process.env.AGGRESSIVE_PAPER_ENTRY_RET_5M_PCT || 0.012);
  const AGGRESSIVE_PAPER_ENTRY_GREEN_LAST5 = Number(process.env.AGGRESSIVE_PAPER_ENTRY_GREEN_LAST5 || 2);
  const AGGRESSIVE_PAPER_ENTRY_COOLDOWN_MS = Number(process.env.AGGRESSIVE_PAPER_ENTRY_COOLDOWN_MS || 4 * 60_000);

  const PAPER_ENTRY_RET_15M_PCT = Number(process.env.PAPER_ENTRY_RET_15M_PCT || (MOMENTUM_PROFILE === 'aggressive' ? AGGRESSIVE_PAPER_ENTRY_RET_15M_PCT : 0.12));
  const PAPER_ENTRY_RET_5M_PCT = Number(process.env.PAPER_ENTRY_RET_5M_PCT || (MOMENTUM_PROFILE === 'aggressive' ? AGGRESSIVE_PAPER_ENTRY_RET_5M_PCT : 0.04));
  const PAPER_ENTRY_GREEN_LAST5 = Number(process.env.PAPER_ENTRY_GREEN_LAST5 || (MOMENTUM_PROFILE === 'aggressive' ? AGGRESSIVE_PAPER_ENTRY_GREEN_LAST5 : 4));
  const PAPER_ENTRY_COOLDOWN_MS = Number(process.env.PAPER_ENTRY_COOLDOWN_MS || (MOMENTUM_PROFILE === 'aggressive' ? AGGRESSIVE_PAPER_ENTRY_COOLDOWN_MS : (30 * 60_000)));
  const FORCE_ATTEMPT_ON_CONFIRM_PASS = (process.env.FORCE_ATTEMPT_ON_CONFIRM_PASS ?? (AGGRESSIVE_MODE ? 'true' : 'false')) === 'true';
  const FORCE_ATTEMPT_POLICY_ACTIVE = AGGRESSIVE_MODE && FORCE_ATTEMPT_ON_CONFIRM_PASS;
  const FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS = Math.max(1_000, Number(process.env.FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS ?? PAPER_ENTRY_COOLDOWN_MS));
  const FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR = Math.max(1, Math.min(60, Number(process.env.FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR ?? 3)));
  const FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE = Math.max(1, Math.min(120, Number(process.env.FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE ?? 8)));

  const MOMENTUM_FALLBACK_ENABLED = (process.env.MOMENTUM_FALLBACK_ENABLED ?? (AGGRESSIVE_MODE ? 'true' : 'false')) === 'true';
  const MOMENTUM_FALLBACK_TOLERANCE = Math.max(0.6, Math.min(1, Number(process.env.MOMENTUM_FALLBACK_TOLERANCE ?? 0.85)));
  const MOMENTUM_FALLBACK_MIN_LIQ_USD = Math.max(0, Number(process.env.MOMENTUM_FALLBACK_MIN_LIQ_USD ?? 15000));
  const MOMENTUM_FALLBACK_MIN_TX1H = Math.max(0, Number(process.env.MOMENTUM_FALLBACK_MIN_TX1H ?? 20));

  // Paper risk rules are derived from LIVE momo risk rules by default.
  // (So changing LIVE risk rules updates paper behavior too, unless you override PAPER_* explicitly.)
  const derivedPaper = getPaperRulesFromMomentumRules({
    PAPER_ENTRY_RET_15M_PCT,
    PAPER_ENTRY_RET_5M_PCT,
    PAPER_ENTRY_GREEN_LAST5,
    PAPER_ENTRY_COOLDOWN_MS,
    LIVE_MOMO_STOP_AT_ENTRY,
    LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    LIVE_MOMO_TRAIL_ACTIVATE_PCT,
    LIVE_MOMO_TRAIL_DISTANCE_PCT,
  });

  // Paper risk follows LIVE momentum risk as the single source of truth.
  // (Legacy PAPER_* env overrides are intentionally ignored to prevent divergence.)
  const PAPER_STOP_AT_ENTRY = derivedPaper.PAPER_STOP_AT_ENTRY;
  const PAPER_STOP_AT_ENTRY_BUFFER_PCT = Number(derivedPaper.PAPER_STOP_AT_ENTRY_BUFFER_PCT);

  const PAPER_TRAIL_ACTIVATE_PCT = Number(derivedPaper.PAPER_TRAIL_ACTIVATE_PCT);
  const PAPER_TRAIL_DISTANCE_PCT = Number(derivedPaper.PAPER_TRAIL_DISTANCE_PCT);
  const PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE = derivedPaper.PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE;

  // Forward outcome tracking ("what would have happened")
  // TRACK_ENABLED kept as backward-compatible alias for SIM_TRACKING_ENABLED.
  const TRACK_ENABLED = SIM_TRACKING_ENABLED;
  const TRACK_SAMPLE_EVERY_MS = Number(process.env.TRACK_SAMPLE_EVERY_MS || 60_000);
  const TRACK_HORIZON_HOURS = Number(process.env.TRACK_HORIZON_HOURS || 24);
  const TRACK_RESULT_ALERTS_ENABLED = (process.env.TRACK_RESULT_ALERTS_ENABLED ?? 'true') === 'true';
  const TRACKER_LIVE_EXECUTION_ENABLED = (process.env.TRACKER_LIVE_EXECUTION_ENABLED ?? 'false') === 'true';
  const TRACK_MAX_ACTIVE = Number(process.env.TRACK_MAX_ACTIVE || 25);
  const TRACK_CANDIDATES_PER_CYCLE = Number(process.env.TRACK_CANDIDATES_PER_CYCLE || 5);
  const TRACK_DIR = process.env.TRACK_DIR || './state/track';
  const TRACK_INGEST_WINDOW_MINUTES = Number(process.env.TRACK_INGEST_WINDOW_MINUTES || 30);
  const TRACK_INGEST_MIN_POINTS = Number(process.env.TRACK_INGEST_MIN_POINTS || 10);
  const TRACK_INGEST_EXPECTED_FRACTION = Number(process.env.TRACK_INGEST_EXPECTED_FRACTION || 0.2);

  // AI pipeline models (overrideable via Telegram commands)
  const MODEL_PREPROCESS = process.env.MODEL_PREPROCESS || 'gpt-5-mini';
  const MODEL_ANALYZE = process.env.MODEL_ANALYZE || 'gpt-5.2';
  const MODEL_GATEKEEPER = process.env.MODEL_GATEKEEPER || 'gpt-5.2';

  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  const cfg = {
    HELIUS_API_KEY,
    SOLANA_RPC_URL,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,

    STARTING_CAPITAL_USDC,
    MAX_POSITION_USDC,
    MAX_POSITIONS,
    MIN_LIQUIDITY_FLOOR_USD,
    LIQUIDITY_TO_MCAP_RATIO,
    MIN_MCAP_USD,
    MIN_TOKEN_AGE_HOURS,

    PORTFOLIO_STOP_USDC,
    MAX_DRAWDOWN_PCT,
    MIN_SOL_FOR_FEES,
    CAPITAL_SOFT_RESERVE_SOL,
    CAPITAL_RETRY_BUFFER_PCT,
    MAX_NEW_ENTRIES_PER_HOUR,

    DEFAULT_SLIPPAGE_BPS,

    SCAN_EVERY_MS,
    SCAN_BACKOFF_MAX_MS,
    PAIR_CACHE_MAX_AGE_MS,
    WATCHLIST_TRIGGER_MODE,
    WATCHLIST_MAX_SIZE,
    WATCHLIST_EVAL_EVERY_MS,
    WATCHLIST_IMMEDIATE_ROUTE_MAX_PER_CYCLE,
    WATCHLIST_IMMEDIATE_ROUTE_DEDUP_MS,
    WATCHLIST_MINT_TTL_MS,
    WATCHLIST_EVICT_MAX_AGE_HOURS,
    WATCHLIST_EVICT_STALE_CYCLES,
    WATCHLIST_HOT_QUEUE_MAX,
    HOT_TTL_MS,
    HOT_EVAL_MIN_MS,
    HOT_EVAL_MAX_MS,
    COLD_EVAL_MIN_MS,
    COLD_EVAL_MAX_MS,
    CONFIRM_DELAY_MIN_MS,
    CONFIRM_DELAY_MAX_MS,
    ROUTE_CACHE_ENABLED,
    ROUTE_CACHE_TTL_MS,
    ROUTE_CACHE_MAX_SIZE,
    DEBUG_CANARY_ENABLED,
    DEBUG_CANARY_VERBOSE,
    DEBUG_CANARY_COOLDOWN_MS,
    CONVERSION_CANARY_MODE,
    CONVERSION_CANARY_COOLDOWN_MS,
    CONVERSION_CANARY_TRACE_PATH,
    CANARY_BYPASS_MOMENTUM,
    CANARY_BYPASS_MOMENTUM_UNTIL_ISO,
    CANARY_MOMO_FAIL_SAMPLE_PER_MIN,
    MOMENTUM_DIAG_WINDOW_MIN,
    PRE_RUNNER_ENABLED,
    PRE_RUNNER_TX_ACCEL_MIN,
    PRE_RUNNER_WALLET_EXPANSION_MIN,
    PRE_RUNNER_PRICE_IMPACT_EXPANSION_MIN,
    PRE_RUNNER_FAST_WINDOW_MS,
    PRE_RUNNER_EVAL_MIN_MS,
    PRE_RUNNER_EVAL_MAX_MS,
    BURST_PROMOTION_ENABLED,
    BURST_TX_ACCEL_MIN,
    BURST_WALLET_EXPANSION_MIN,
    BURST_VOLUME_EXPANSION_MIN,
    BURST_FAST_WINDOW_MS,
    BURST_EVAL_MIN_MS,
    BURST_EVAL_MAX_MS,
    HOT_MIN_ABS_TX1H_HEALTHY,
    HOT_MIN_ABS_VOLUME_5M_HEALTHY,
    HOT_MOMENTUM_MIN_LIQ_USD,
    HOT_MCAP_REFRESH_RETRIES,
    HOT_MCAP_REFRESH_DELAY_MS,
    HOT_MCAP_REFRESH_WINDOW_MS,
    HOT_ALLOW_AGE_PENDING,
    HOT_AGE_PENDING_MAX_EVALS,
    HOT_AGE_PENDING_MAX_MS,
    HOT_AGE_PENDING_COOLDOWN_MS,
    MINT_AGE_LOOKUP_RETRY_MS,
    MOMENTUM_MICRO_MAX_AGE_MS,
    MOMENTUM_REQUIRE_FRESH_MICRO,
    MOMENTUM_MICRO_MIN_PRESENT_FOR_GATE,
    MOMENTUM_PASS_STREAK_REQUIRED,
    MOMENTUM_PASS_STREAK_RESET_MS,
    MOMENTUM_TX_ACCEL_MIN_RATIO,
    MOMENTUM_VOLUME_EXPANSION_MIN_RATIO,
    MOMENTUM_WALLET_EXPANSION_MIN_RATIO,
    MOMENTUM_SCORE_PASS_THRESHOLD,
    MAX_TOP10_PCT,
    MAX_TOP_HOLDER_PCT,
    MAX_BUNDLE_CLUSTER_PCT,
    POSITIONS_EVERY_MS,
    HEARTBEAT_EVERY_MS,
    DEBUG_REJECTIONS,
    DEBUG_REJECTIONS_EVERY_MS,

    STATE_PATH,
    TRADING_LOG_PATH,
    LEDGER_PATH,
    TELEGRAM_POLL_EVERY_MS,
    TG_VISIBILITY_PINGS,
    SCANNER_ENTRIES_ENABLED,
    SCANNER_TRACKING_ENABLED,
    AUTO_TUNE_ENABLED,
    AUTO_TUNE_EVERY_MS,
    HOURLY_DIAG_ENABLED,
    HOURLY_DIAG_EVERY_MS,
    DIAG_RETENTION_DAYS,
    DIAG_RETENTION_MS,
    REQUIRE_SOCIAL_META,
    AI_PIPELINE_ENABLED,
    MOMENTUM_FILTER_ENABLED,
    RUGCHECK_ENABLED,
    BASE_FILTERS_ENABLED,
    MCAP_FILTER_ENABLED,
    LIQ_RATIO_FILTER_ENABLED,
    FORCE_TRADING_ENABLED,
    DATA_CAPTURE_ENABLED,
    EXECUTION_ENABLED,
    SIM_TRACKING_ENABLED,
    MAX_PRICE_IMPACT_PCT,
    MAX_QUOTE_DEGRADE_PCT,
    AGGRESSIVE_MODE,
    LIVE_CONVERSION_PROFILE_ENABLED,
    PAIR_FETCH_CONCURRENCY,
    LIVE_PARALLEL_QUOTE_FANOUT_N,
    LIVE_CANDIDATE_SHORTLIST_N,
    LIVE_REJECT_RECHECK_BURST_ENABLED,
    LIVE_REJECT_RECHECK_BURST_ATTEMPTS,
    LIVE_REJECT_RECHECK_BURST_DELAY_MS,
    LIVE_REJECT_RECHECK_PASSES,
    LIVE_REJECT_RECHECK_PASS_DELAY_MS,
    LIVE_TWO_STAGE_SLIPPAGE_RETRY_ENABLED,
    LIVE_TWO_STAGE_SLIPPAGE_RETRY_BPS,
    LIVE_TWO_STAGE_SLIPPAGE_MAX_BPS,
    LIVE_PROBE_CONFIRM_ENABLED,
    LIVE_PROBE_MAX_CANDIDATES,
    LIVE_PROBE_MIN_LIQ_USD,
    LIVE_PROBE_MIN_TX1H,
    LIVE_CONFIRM_MIN_LIQ_USD,
    LIVE_ATTEMPT_MIN_LIQ_USD,
    ENTRY_MIN_MCAP_USD,
    ENTRY_MIN_LIQUIDITY_USD,
    LIVE_CONFIRM_MAX_PRICE_IMPACT_PCT,
    AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT,
    EFFECTIVE_CONFIRM_MAX_PRICE_IMPACT_PCT,
    FORCE_ATTEMPT_ON_CONFIRM_PASS,
    FORCE_ATTEMPT_POLICY_ACTIVE,
    FORCE_ATTEMPT_PER_MINT_COOLDOWN_MS,
    FORCE_ATTEMPT_MAX_PER_MINT_PER_HOUR,
    FORCE_ATTEMPT_GLOBAL_MAX_PER_MINUTE,
    LOW_LIQ_STRICT_MOMENTUM_UNDER_USD,

    EARLY_SHORTLIST_PREFILTER_ENABLED,
    EARLY_SHORTLIST_PREFILTER_MODE,
    EARLY_SHORTLIST_PREFILTER_ACTIVE,
    AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD,
    AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_TX1H,
    AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD,
    EARLY_SHORTLIST_PREFILTER_MIN_LIQ_USD,
    EARLY_SHORTLIST_PREFILTER_MIN_TX1H,
    EARLY_SHORTLIST_PREFILTER_MIN_BOOST_USD,

    SOURCE_MODE,
    SOURCE_QUALITY_JUP_SAMPLE_N,
    SOURCE_QUALITY_REQUIRE_JUP_QUOTEABLE,
    BIRDEYE_LITE_ENABLED,
    BIRDEYE_API_KEY,
    BIRDEYE_LITE_MAX_RPS,
    BIRDEYE_LITE_CHAIN,
    BIRDEYE_LITE_CACHE_TTL_MS,
    BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS,
    BIRDEYE_ENTRY_FETCH_TIMEOUT_MS,
    STREAMING_PROVIDER_MODE,
    LASERSTREAM_ENABLED,
    LASERSTREAM_STAGING_MODE,
    LASERSTREAM_DEVNET_WS_URL,
    LASERSTREAM_DEVNET_RPC_URL,
    LASERSTREAM_PROGRAM_IDS,
    LASERSTREAM_RECONNECT_BASE_MS,
    LASERSTREAM_RECONNECT_MAX_MS,
    LASERSTREAM_REPLAY_LOOKBACK_SECONDS,
    LASERSTREAM_HEARTBEAT_STALE_MS,
    LASERSTREAM_BUFFER_MAX,
    TRENDING_ENABLED,
    TRENDING_REFRESH_MS,
    SOURCE_QUALITY_TRENDING_SAMPLE_N,
    JUP_TOKENLIST_ENABLED,
    JUP_TOKENLIST_URL,
    JUP_TOKENLIST_CACHE_MS,
    JUP_TOKENLIST_SAMPLE_N,
    JUP_PREFILTER_ENABLED,
    JUP_PREFILTER_AMOUNT_USD,
    ROUTE_ALT_ENABLED,
    ROUTE_ALT_MIN_LIQ_USD,
    ROUTE_ALT_MAX_PRICE_IMPACT_PCT,
    CANDIDATE_LEDGER_DIR,
    CANDIDATE_LEDGER_RETENTION_DAYS,
    TRADES_LEDGER_PATH,
    JSONL_RETENTION_DAYS,
    JSONL_ROTATE_MAX_BYTES,

    ALIVE_PING_URL,
    ALIVE_PING_EVERY_MS,

    CIRCUIT_BREAKER_ENABLED,
    CIRCUIT_FAILS_DEX,
    CIRCUIT_FAILS_RPC,
    CIRCUIT_FAILS_JUP,
    CIRCUIT_COOLDOWN_MS,

    PLAYBOOK_ENABLED,
    PLAYBOOK_RESTART_THRESHOLD,
    PLAYBOOK_RESTART_WINDOW_MS,
    PLAYBOOK_ERROR_THRESHOLD,
    PLAYBOOK_ERROR_WINDOW_MS,
    PLAYBOOK_STABLE_RECOVERY_MS,

    PAPER_ENABLED,
    MOMENTUM_PROFILE,
    AGGRESSIVE_PAPER_ENTRY_RET_15M_PCT,
    AGGRESSIVE_PAPER_ENTRY_RET_5M_PCT,
    AGGRESSIVE_PAPER_ENTRY_GREEN_LAST5,
    AGGRESSIVE_PAPER_ENTRY_COOLDOWN_MS,
    PAPER_ENTRY_RET_15M_PCT,
    PAPER_ENTRY_RET_5M_PCT,
    PAPER_ENTRY_GREEN_LAST5,
    PAPER_ENTRY_COOLDOWN_MS,
    MOMENTUM_FALLBACK_ENABLED,
    MOMENTUM_FALLBACK_TOLERANCE,
    MOMENTUM_FALLBACK_MIN_LIQ_USD,
    MOMENTUM_FALLBACK_MIN_TX1H,
    PAPER_STOP_AT_ENTRY,
    PAPER_STOP_AT_ENTRY_BUFFER_PCT,
    PAPER_TRAIL_ACTIVATE_PCT,
    PAPER_TRAIL_DISTANCE_PCT,
    PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE,

    LIVE_MOMO_ENABLED,
    LIVE_MOMO_USD_TARGET,
    LIVE_MOMO_USD_MIN,
    LIVE_MOMO_USD_MAX,
    LIVE_MOMO_SIZE_MODE,
    LIVE_MOMO_PCT_OF_PORTFOLIO,
    LIVE_MOMO_MAX_SOL_PER_TRADE,
    LIVE_MOMO_STOP_AT_ENTRY,
    LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
    LIVE_STOP_ARM_DELAY_MS,
    LIVE_PREARM_CATASTROPHIC_STOP_PCT,
    LIVE_MOMO_TRAIL_ACTIVATE_PCT,
    LIVE_MOMO_TRAIL_DISTANCE_PCT,
    LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS,
    LIVE_FAST_STOP_REENTRY_WINDOW_MS,
    LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH,
    LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS,
    LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS,

    CONFIRM_REQUIRE_TX_ACCEL_AND_BUY_DOM,
    CONFIRM_TX_ACCEL_MIN,
    CONFIRM_BUY_SELL_MIN,
    CONFIRM_SNAPSHOT_MAX_AGE_MS,
    ATTEMPT_PER_MINT_COOLDOWN_MS,
    ATTEMPT_NEW_HIGH_MULTIPLIER,
    ATTEMPT_LIQ_EXPAND_MULTIPLIER,
    EARLY_FAILURE_KILL_ENABLED,
    EARLY_FAILURE_KILL_MIN_MS,
    EARLY_FAILURE_KILL_MAX_MS,
    HARD_STOP_COOLDOWN_ENABLED,
    HARD_STOP_COOLDOWN_TRIGGER_COUNT,
    HARD_STOP_COOLDOWN_WINDOW_MS,
    HARD_STOP_COOLDOWN_PAUSE_MS,

    HOLDER_TIER_NEW_MAX_AGE_SEC,
    HOLDER_TIER_MIN_NEW,
    HOLDER_TIER_MIN_MATURE,
    HOLDER_MISSING_SOFT_ALLOW,

    JUPITER_API_KEY,

    TRACK_ENABLED,
    TRACK_SAMPLE_EVERY_MS,
    TRACK_HORIZON_HOURS,
    TRACK_RESULT_ALERTS_ENABLED,
    TRACKER_LIVE_EXECUTION_ENABLED,
    TRACK_MAX_ACTIVE,
    TRACK_CANDIDATES_PER_CYCLE,
    TRACK_DIR,
    TRACK_INGEST_WINDOW_MINUTES,
    TRACK_INGEST_MIN_POINTS,
    TRACK_INGEST_EXPECTED_FRACTION,
    MODEL_PREPROCESS,
    MODEL_ANALYZE,
    MODEL_GATEKEEPER,

    USDC_MINT,
    SOL_MINT,
  };

  return validateConfig(cfg);
}
