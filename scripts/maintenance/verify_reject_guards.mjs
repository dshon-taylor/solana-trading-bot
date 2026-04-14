import fs from 'fs';
import { isTokenSafe, getConcentrationMetrics } from '../../src/rugcheck.mjs';
import { passesBaseFilters, evaluateMomentumSignal } from '../../src/strategy.mjs';
import { buildTrackSampleRow, evaluateTrackerIngestionHealth } from '../../src/tracker.mjs';
import { config } from 'process';

const results = {};

// 1) Rugcheck concentration rejects
const reportHighTopHolder = { score_normalised: 80, topHolderPct: 20, top10Pct: 40, bundleClusterPct: 10 };
const r1 = isTokenSafe(reportHighTopHolder);
results.rugcheck_topHolder = { passed: r1.ok === false, reason: r1.reason };

const reportHighTop10 = { score_normalised: 80, topHolderPct: 5, top10Pct: 60, bundleClusterPct: 5 };
const r2 = isTokenSafe(reportHighTop10);
results.rugcheck_top10 = { passed: r2.ok === false, reason: r2.reason };

const reportHighBundle = { score_normalised: 80, topHolderPct: 5, top10Pct: 30, bundleClusterPct: 35 };
const r3 = isTokenSafe(reportHighBundle);
results.rugcheck_bundle = { passed: r3.ok === false, reason: r3.reason };

// 2) Strategy hard rejects: liquidity, v5m, tx1h, spread, age
const basePair = {
  liquidity: { usd: 100000 },
  txns: { h1: { buys: 50, sells: 0 } },
  pairCreatedAt: Date.now() - 1000 * 60 * 10, // 10 minutes ago
  priceUsd: 1,
  wsCache: { volume_5m: 20000, volume_30m_avg: 10000, tx_1h: 50, tx_1m: 10, tx_5m_avg: 2, buySellRatio: 2, rolling_high_5m: 0.9 },
};
const sigOk = evaluateMomentumSignal(basePair);
results.momentum_ok = { passed: sigOk.ok, hardRejects: sigOk.reasons.hardRejects };

const lowLiq = JSON.parse(JSON.stringify(basePair)); lowLiq.liquidity.usd = 60000;
const sigLiq = evaluateMomentumSignal(lowLiq);
results.hard_liq = { rejected: !sigLiq.ok, hardRejects: sigLiq.reasons.hardRejects };

const lowV5m = JSON.parse(JSON.stringify(basePair)); lowV5m.wsCache.volume_5m = 10000;
const sigV5m = evaluateMomentumSignal(lowV5m);
results.hard_v5m = { rejected: !sigV5m.ok, hardRejects: sigV5m.reasons.hardRejects };

const lowTx1h = JSON.parse(JSON.stringify(basePair)); lowTx1h.wsCache.tx_1h = 10; lowTx1h.txns.h1.buys = 10; lowTx1h.txns.h1.sells = 10;
const sigTx = evaluateMomentumSignal(lowTx1h);
results.hard_tx1h = { rejected: !sigTx.ok, hardRejects: sigTx.reasons.hardRejects };

const highSpread = JSON.parse(JSON.stringify(basePair)); highSpread.spreadPct = 5;
const sigSpread = evaluateMomentumSignal(highSpread);
results.hard_spread = { rejected: !sigSpread.ok, hardRejects: sigSpread.reasons.hardRejects };

const youngPair = JSON.parse(JSON.stringify(basePair)); youngPair.pairCreatedAt = Date.now() - 30 * 1000; // 30s old
const sigAge = evaluateMomentumSignal(youngPair);
results.hard_age = { rejected: !sigAge.ok, hardRejects: sigAge.reasons.hardRejects };

// 3) passesBaseFilters: min liquidity and min age
const pf1 = passesBaseFilters({ pair: basePair, minLiquidityUsd: 75000, minAgeHours: 0.001 });
results.passesBaseFilters_ok = { ok: pf1.ok, reason: pf1.reason };
const pf2 = passesBaseFilters({ pair: lowLiq, minLiquidityUsd: 75000, minAgeHours: 0.001 });
results.passesBaseFilters_lowliq = { ok: pf2.ok, reason: pf2.reason };
const pf3 = passesBaseFilters({ pair: youngPair, minLiquidityUsd: 1000, minAgeHours: 0.1 });
results.passesBaseFilters_age = { ok: pf3.ok, reason: pf3.reason };

// 4) Tracker ingestion health sample
const state = { track: { ingest: { recentWriteTimestamps: [], pointsLastHour: 0, pointsToday: 0 }, active: { 'MINT1': {} } } };
const cfg = { TRACK_INGEST_WINDOW_MINUTES: 60, TRACK_SAMPLE_EVERY_MS: 60000, TRACK_INGEST_EXPECTED_FRACTION: 0.2, TRACK_INGEST_MIN_POINTS: 1 };
const healthBefore = evaluateTrackerIngestionHealth({ cfg, state, nowMs: Date.now() });
results.tracker_health_before = healthBefore;
// simulate a write
state.track.ingest.recentWriteTimestamps.push(Date.now());
state.track.ingest.pointsLastHour = 1; state.track.ingest.pointsToday = 1;
const healthAfter = evaluateTrackerIngestionHealth({ cfg, state, nowMs: Date.now() });
results.tracker_health_after = healthAfter;

// 5) Confirm AGGRESSIVE_MODE env read
// Read .env explicitly
let aggressiveFromEnvFile = null;
try{
  let envtxt = null;
  const candidates = ['./.env','../.env','./trading-bot/.env','trading-bot/.env','./src/.env'];
  for(const c of candidates){
    try{ if(fs.existsSync(c)){ envtxt = fs.readFileSync(c,'utf8'); break; } }catch(e){}
  }
  const m = envtxt.match(/^AGGRESSIVE_MODE\s*=\s*(.*)$/m);
  if(m) aggressiveFromEnvFile = String(m[1]).trim();
}catch(e){}
results.aggressive_mode_env = { AGGRESSIVE_MODE: process.env.AGGRESSIVE_MODE || null, AGGRESSIVE_MODE_file: aggressiveFromEnvFile };

// write output
fs.mkdirSync('./analysis', { recursive: true });
fs.writeFileSync('./analysis/reject_guard_validation_latest.json', JSON.stringify(results, null, 2));
console.log('WROTE analysis/reject_guard_validation_latest.json');
console.log(JSON.stringify(results, null, 2));
process.exit(0);
