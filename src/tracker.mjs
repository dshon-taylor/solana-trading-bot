import fs from 'node:fs';
import path from 'node:path';

import { jupPriceUsd } from './jup_price.mjs';
import { getTokenPairs, pickBestPair } from './dexscreener.mjs';
import { executeSwap, toBaseUnits, DECIMALS } from './trader.mjs';
import { getSolBalanceLamports } from './portfolio.mjs';
import { simulateStops } from './track_sim.mjs';
import { paperOnSample } from './paper_momentum.mjs';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function dayStrUtc(t = Date.now()) {
  const d = new Date(t);
  return d.toISOString().slice(0, 10);
}

function appendJsonl(fp, obj) {
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify(obj) + '\n');
}

function toFinitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tokenLabel({ name = null, fallbackName = null, symbol, fallbackSymbol = null, mint = null }) {
  const n = String(name || fallbackName || '').trim();
  if (n) return n;
  const s = String(symbol || fallbackSymbol || '').trim();
  if (s) return s;
  const m = String(mint || '').trim();
  return m ? `${m.slice(0, 6)}…` : 'Unknown token';
}

export function buildTrackSampleRow({ tMs = Date.now(), mint, symbol = null, entryPrice, priceUsd, source, lastGoodPrice = null }) {
  if (!mint) return null;

  const ts = Number.isFinite(Number(tMs)) ? Number(tMs) : Date.now();
  const entry = toFinitePositive(entryPrice);
  const live = toFinitePositive(priceUsd);
  const prev = toFinitePositive(lastGoodPrice);

  const resolvedPrice = live ?? prev ?? entry;
  if (!resolvedPrice) return null;

  // Canonical source labels used for tracker diagnostics and counters.
  // live sources: birdseye|jup|dex
  // fallbacks: last_good|entry_price
  let resolvedSource = source || 'none';
  if (!live) {
    if (prev) resolvedSource = 'last_good';
    else if (entry) resolvedSource = 'entry_price';
  }

  return {
    t: new Date(ts).toISOString(),
    mint,
    symbol,
    entryPrice: entry,
    priceUsd: resolvedPrice,
    source: resolvedSource,
  };
}

export function appendTrackSample(fp, row) {
  if (!row || !row.t || !row.mint) return false;
  if (!Number.isFinite(Number(row.priceUsd)) || Number(row.priceUsd) <= 0) return false;
  appendJsonl(fp, row);
  return true;
}

import { memoizeTTL, tokenBucket } from './cache.mjs';

const jupPriceMemo = memoizeTTL(async (mint) => await jupPriceUsd(mint), 15_000);
const dexscreenerMemo = memoizeTTL(async (mint) => {
  try {
    const pairs = await getTokenPairs('solana', mint);
    const pair = pickBestPair(pairs);
    return Number(pair?.priceUsd || 0);
  } catch {
    return null;
  }
}, 15_000);

// Align dex limiter with Alchemy free tier (25 rps). Use conservative headroom: 20 rps.
const dexLimiter = tokenBucket('dexscreener', 20, 1000);

async function priceUsdForMint(mint, { birdseye = null } = {}) {
  // 1) Birdseye (paid / authoritative when enabled). Client includes internal throttle.
  try {
    if (birdseye?.enabled && typeof birdseye?.getTokenSnapshot === 'function') {
      const snap = await birdseye.getTokenSnapshot(mint);
      const p = Number(snap?.priceUsd);
      if (Number.isFinite(p) && p > 0) return { priceUsd: p, source: 'birdseye' };
    }
  } catch {}

  // 2) Jupiter (cheap). Use memoized jup call.
  try {
    const pj = await jupPriceMemo(mint);
    const n = Number(pj);
    if (Number.isFinite(n) && n > 0) return { priceUsd: n, source: 'jup' };
  } catch {}

  // 3) Rate-limited DexScreener fallback
  try {
    if (!dexLimiter.tryTake()) return { priceUsd: null, source: 'rate_limited' };
    const p = await dexscreenerMemo(mint);
    if (Number.isFinite(p) && p > 0) return { priceUsd: p, source: 'dex' };
  } catch {}

  return { priceUsd: null, source: 'none' };
}

function makeTrackStats(nowMs = Date.now()) {
  return {
    windowStartedAtMs: nowMs,
    candidatesEnqueued: 0,
    samples: 0,
    // Per-sample resolved source counts (rolling, reset every ~30m in trackerTick).
    // Keys: birdseye|dex|jup|last_good|entry_price|none
    sampleSources: {
      birdseye: 0,
      dex: 0,
      jup: 0,
      last_good: 0,
      entry_price: 0,
      none: 0,
    },
    paperSignals: 0,
    paperEntries: 0,
    paperExits: 0,
  };
}

export function evaluateTrackerIngestionHealth({ cfg, state, nowMs = Date.now() }) {
  const ingest = state?.track?.ingest;
  const recentWrites = Array.isArray(ingest?.recentWriteTimestamps) ? ingest.recentWriteTimestamps : [];
  const windowMs = Math.max(60_000, Number(cfg.TRACK_INGEST_WINDOW_MINUTES || 30) * 60_000);
  const cutoffMs = nowMs - windowMs;
  const recentCount = recentWrites.filter((ts) => Number(ts) >= cutoffMs).length;
  const activeCount = Object.keys(state?.track?.active || {}).length;

  const expectedSamples = activeCount > 0
    ? (activeCount * (windowMs / Math.max(1, Number(cfg.TRACK_SAMPLE_EVERY_MS || 60_000))))
    : 0;
  const minFromExpected = Math.ceil(expectedSamples * Math.max(0, Number(cfg.TRACK_INGEST_EXPECTED_FRACTION || 0.2)));
  const minAbs = Math.max(0, Number(cfg.TRACK_INGEST_MIN_POINTS || 10));
  const minExpected = activeCount > 0 ? Math.max(1, minAbs, minFromExpected) : 0;

  let severity = 'ok';
  if (activeCount > 0 && recentCount === 0) severity = 'critical';
  else if (activeCount > 0 && recentCount < minExpected) severity = 'warning';

  return {
    severity,
    activeCount,
    recentCount,
    minExpected,
    windowMinutes: Math.round(windowMs / 60_000),
    pointsLastHour: Number(ingest?.pointsLastHour || 0),
    pointsToday: Number(ingest?.pointsToday || 0),
    hourStartedAtMs: ingest?.hourStartedAtMs || null,
    dayKey: ingest?.dayKey || null,
    lastWriteAtMs: ingest?.lastWriteAtMs || null,
  };
}

export function formatTrackerIngestionSummary({ cfg, state, nowMs = Date.now() }) {
  const h = evaluateTrackerIngestionHealth({ cfg, state, nowMs });
  const sevIcon = h.severity === 'critical' ? '🚨' : h.severity === 'warning' ? '⚠️' : '✅';
  const status = h.severity === 'critical' ? 'ZERO_INGEST' : h.severity === 'warning' ? 'LOW_INGEST' : 'ok';
  return `${sevIcon} tracker ingest: ${status} window=${h.windowMinutes}m recent=${h.recentCount}/${h.minExpected} active=${h.activeCount} hour=${h.pointsLastHour} day=${h.pointsToday}`;
}

export function trackerSamplingBreakdown({ state, nowMs = Date.now(), windowMs = 60 * 60_000 } = {}) {
  const ingest = state?.track?.ingest;
  const recent = Array.isArray(ingest?.recentSamples) ? ingest.recentSamples : [];
  const cutoff = nowMs - Math.max(1, Number(windowMs || 0));

  const counts = { birdseye: 0, dex: 0, jup: 0, last_good: 0, entry_price: 0, none: 0, other: 0 };
  let total = 0;

  for (const s of recent) {
    const tMs = Number(s?.tMs || 0);
    if (!Number.isFinite(tMs) || tMs < cutoff) continue;
    total++;
    const k = String(s?.source || 'none');
    if (k in counts) counts[k] += 1;
    else counts.other += 1;
  }

  return { total, windowMs, counts };
}

export function formatTrackerSamplingBreakdown({ state, nowMs = Date.now(), windowMs = 60 * 60_000 } = {}) {
  const b = trackerSamplingBreakdown({ state, nowMs, windowMs });
  const m = Math.round(b.windowMs / 60_000);
  const c = b.counts;

  const pct = (n) => (b.total > 0 ? `${Math.round((n / b.total) * 100)}%` : '0%');
  return [
    `🧾 tracker sampling (last ${m}m): total=${b.total}`,
    `• birdseye=${c.birdseye} (${pct(c.birdseye)})  jup=${c.jup} (${pct(c.jup)})  dex=${c.dex} (${pct(c.dex)})`,
    `• last_good=${c.last_good} (${pct(c.last_good)})  entry_price=${c.entry_price} (${pct(c.entry_price)})  none=${c.none} (${pct(c.none)}) other=${c.other}`,
  ].join('\n');
}

function trackRecordPoint({ cfg, state, tMs, source = 'none' }) {
  state.track ||= { active: {} };
  state.track.ingest ||= { recentWriteTimestamps: [] };

  const ingest = state.track.ingest;
  const dayKey = dayStrUtc(tMs);

  if (!ingest.hourStartedAtMs || (tMs - ingest.hourStartedAtMs) >= 3_600_000) {
    ingest.hourStartedAtMs = tMs;
    ingest.pointsLastHour = 0;
  }
  if (ingest.dayKey !== dayKey) {
    ingest.dayKey = dayKey;
    ingest.pointsToday = 0;
  }

  ingest.pointsLastHour = Number(ingest.pointsLastHour || 0) + 1;
  ingest.pointsToday = Number(ingest.pointsToday || 0) + 1;
  ingest.lastWriteAtMs = tMs;

  ingest.recentWriteTimestamps = Array.isArray(ingest.recentWriteTimestamps)
    ? ingest.recentWriteTimestamps
    : [];
  ingest.recentWriteTimestamps.push(tMs);

  ingest.recentSamples = Array.isArray(ingest.recentSamples) ? ingest.recentSamples : [];
  ingest.recentSamples.push({ tMs, source: String(source || 'none') });

  const keepMs = Math.max(2 * 3_600_000, Math.max(60_000, Number(cfg.TRACK_INGEST_WINDOW_MINUTES || 30) * 60_000) * 3);
  const cutoff = tMs - keepMs;
  while (ingest.recentWriteTimestamps.length && ingest.recentWriteTimestamps[0] < cutoff) ingest.recentWriteTimestamps.shift();
  while (ingest.recentSamples.length && Number(ingest.recentSamples[0]?.tMs || 0) < cutoff) ingest.recentSamples.shift();
}

export function trackerInit({ cfg: _cfg, state }) {
  state.track ||= { active: {} };
  state.track.stats ||= makeTrackStats();
  state.track.ingest ||= {
    hourStartedAtMs: Date.now(),
    pointsLastHour: 0,
    dayKey: dayStrUtc(),
    pointsToday: 0,
    recentWriteTimestamps: [],
    recentSamples: [],
    lastWarnSeverity: 'ok',
    lastWarnAtMs: 0,
  };
}

export function trackerMaybeEnqueue({ cfg, state, candidates /* [{mint, pair, tok}] */, nowIso }) {
  if (!(cfg.SIM_TRACKING_ENABLED ?? cfg.TRACK_ENABLED)) return;
  trackerInit({ cfg, state });

  const active = state.track.active || {};
  const activeCount = Object.keys(active).length;
  if (activeCount >= cfg.TRACK_MAX_ACTIVE) return;

  let added = 0;
  for (const c of candidates) {
    if (added >= cfg.TRACK_CANDIDATES_PER_CYCLE) break;
    const mint = c?.mint;
    if (!mint || active[mint]) continue;

    const entryPrice = Number(c?.pair?.priceUsd || 0);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

    active[mint] = {
      mint,
      symbol: c?.tok?.tokenSymbol || c?.tok?._symbol || c?.tok?.symbol || null,
      startedAt: Date.now(),
      startedAtIso: nowIso(),
      entryPrice,
      lastGoodPrice: entryPrice,
      lastSampleAt: 0,
      samples: 0,
      completed: false,
    };
    added++;
  }

  state.track.active = active;

  // stats
  try {
    state.track.stats ||= makeTrackStats();
    state.track.stats.candidatesEnqueued += added;
  } catch {}
}

export async function trackerTick({ cfg, state, send, nowIso, conn, wallet, solUsd, birdseye = null }) {
  if (!(cfg.SIM_TRACKING_ENABLED ?? cfg.TRACK_ENABLED)) return;
  trackerInit({ cfg, state });

  const active = state.track.active || {};
  const horizonMs = cfg.TRACK_HORIZON_HOURS * 60 * 60_000;

  // Keep tracker rolling stats internally; no periodic tracker heartbeat Telegram pings.
  state.track.lastBeatAtMs = state.track.lastBeatAtMs || 0;
  const t0 = Date.now();
  if (t0 - state.track.lastBeatAtMs > 30 * 60_000) {
    state.track.lastBeatAtMs = t0;
    try {
      state.track.stats ||= makeTrackStats();
      state.track.stats = makeTrackStats(t0);
    } catch {}
  }

  for (const mint of Object.keys(active)) {
    const job = active[mint];
    if (!job || job.completed) continue;

    const t = Date.now();

    if (job.lastSampleAt && (t - job.lastSampleAt) < cfg.TRACK_SAMPLE_EVERY_MS) continue;

    const { priceUsd, source } = await priceUsdForMint(mint, { birdseye });
    job.lastSampleAt = t;

    // stats
    try {
      state.track.stats ||= makeTrackStats();
      state.track.stats.samples += 1;
    } catch {}

    const fp = path.join(cfg.TRACK_DIR, dayStrUtc(t), `${mint}.jsonl`);
    const row = buildTrackSampleRow({
      tMs: t,
      mint,
      symbol: job.symbol,
      entryPrice: job.entryPrice,
      priceUsd,
      source,
      lastGoodPrice: job.lastGoodPrice,
    });
    const wroteSample = appendTrackSample(fp, row);
    const tIso = row?.t || new Date(t).toISOString();
    if (wroteSample) {
      job.lastGoodPrice = Number(row.priceUsd);
      trackRecordPoint({ cfg, state, tMs: t, source: row?.source || 'none' });

      // Per-sample resolved source counters (for /diag).
      try {
        state.track.stats ||= makeTrackStats();
        state.track.stats.sampleSources ||= {};
        const k = String(row?.source || 'none');
        state.track.stats.sampleSources[k] = Number(state.track.stats.sampleSources[k] || 0) + 1;
      } catch {}
    }

    // Paper momentum engine (entry/exit alerts) + optional live execution
    try {
      const evt = paperOnSample({
        cfg,
        state,
        mint,
        symbol: job.symbol,
        entryAnchorPrice: job.entryPrice,
        tIso,
        tMs: t,
        priceUsd: row?.priceUsd ?? priceUsd,
      });

      // stats
      try {
        if (evt) {
          state.track.stats ||= makeTrackStats();
          state.track.stats.paperSignals += 1;
          if (evt.kind === 'entry') state.track.stats.paperEntries += 1;
          if (evt.kind === 'exit') state.track.stats.paperExits += 1;
        }
      } catch {}

      if (evt?.kind === 'entry') {
        // Log paper->live decision path (so paper and live can be compared)
        const paperAttempt = {
          t: tIso,
          kind: 'paper_entry',
          mint,
          symbol: evt.symbol || job.symbol || null,
          ret15: evt.ret15,
          ret5: evt.ret5,
          greensLast5: evt.greensLast5,
          liveEnabled: !!cfg.LIVE_MOMO_ENABLED,
          executionEnabled: !!cfg.EXECUTION_ENABLED,
          tradingEnabled: (state.tradingEnabled !== false),
          reason: null,
          attempted: false,
          signature: null,
        };

        const attemptsFp = './state/paper_live_attempts.jsonl';

        // Persist to JSONL so we can audit paper->live matching even across restarts.
        // Note: we write twice: once at entry-signal time, once after we set attempted/reason/signature.
        try {
          appendJsonl(attemptsFp, { ...paperAttempt, stage: 'signal' });
        } catch {}

        const lowSolPaused = state.flags?.lowSolPauseEntries === true;
        const executionAllowed = (cfg.EXECUTION_ENABLED === true) && (state.tradingEnabled !== false) && !lowSolPaused;
        if (cfg.LIVE_MOMO_ENABLED && cfg.TRACKER_LIVE_EXECUTION_ENABLED && executionAllowed) {
          // Live momentum entry: spend fixed USD target in SOL, stop at entry, trailing per LIVE_MOMO_*.
          if (!conn || !wallet || !solUsd) {
            paperAttempt.reason = 'skip:missing_conn_wallet_solUsd';
            await send(cfg, `⚠️ Live momo entry skipped (missing conn/wallet/solUsd) for ${tokenLabel({ name: evt?.name, fallbackName: job?.name, symbol: evt.symbol, fallbackSymbol: job?.symbol, mint })}`);
            try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
          } else if (state.positions?.[mint]?.status === 'open') {
            paperAttempt.reason = 'skip:already_open';
            // already open
            try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
          } else {
            // Enforce hard mcap floor in tracker live-entry path too (avoid bypassing scanner filters).
            try {
              const effMinMcap = Number(state?.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD ?? 0);
              if (effMinMcap > 0) {
                const pairs = await getTokenPairs('solana', mint);
                const pair = pickBestPair(pairs);
                const mcapCand = Number(pair?.marketCap ?? pair?.fdv ?? 0);
                if (!(mcapCand > 0)) {
                  paperAttempt.reason = `skip:mcapUnknown(<${effMinMcap})`;
                  try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
                  return;
                }
                if (mcapCand < effMinMcap) {
                  paperAttempt.reason = `skip:mcap<${effMinMcap}(${Math.round(mcapCand)})`;
                  try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
                  return;
                }
              }
            } catch {}

            // Dynamic fee-reserve guard: pause live entries while SOL balance is below fee reserve,
            // and auto-resume once balance recovers.
            try {
              state.flags ||= {};
              const solLam = await getSolBalanceLamports(conn, wallet.publicKey);
              const sol = Number(solLam || 0) / 1e9;
              if (sol < Number(cfg.MIN_SOL_FOR_FEES || 0)) {
                state.flags.lowSolPauseEntries = true;
                const nowMs = Date.now();
                state.track ||= {};
                state.track.lowSolAlertAtMs ||= 0;
                if ((nowMs - Number(state.track.lowSolAlertAtMs || 0)) > 30 * 60_000) {
                  state.track.lowSolAlertAtMs = nowMs;
                  await send(cfg, `⚠️ Low SOL balance for fees: ${sol.toFixed(4)} SOL (< ${Number(cfg.MIN_SOL_FOR_FEES || 0).toFixed(4)} SOL reserve). Pausing new entries until balance recovers.`);
                }
                paperAttempt.reason = 'skip:low_sol_fee_reserve';
                try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
                return;
              }
              if (state.flags.lowSolPauseEntries) {
                state.flags.lowSolPauseEntries = false;
                await send(cfg, `✅ SOL fee reserve recovered (${sol.toFixed(4)} SOL). New entries resumed.`);
              }
            } catch {}

            // Exposure pause gate (hard-stop cooldown / post-win pause):
            // if paused, tracker live entries must not bypass pause.
            try {
              state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
              const nowMs = Date.now();
              const pauseUntilMs = Number(state.exposure.pausedUntilMs || 0);
              if (pauseUntilMs > nowMs) {
                paperAttempt.reason = `skip:exposurePause(until=${new Date(pauseUntilMs).toISOString()})`;
                try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
                return;
              }
            } catch {}

            // Max-position hysteresis gate (same semantics as main loop):
            // halt new entries at max positions; resume only once open <= max-1.
            try {
              state.runtime ||= {};
              const openCount = Object.values(state.positions || {}).filter(p => p?.status === 'open').length;
              const maxPos = Math.max(0, Number(cfg.MAX_POSITIONS || 0));
              const resumeAt = Math.max(0, maxPos - 1);
              if (state.runtime.maxPosHaltActive) {
                if (openCount <= resumeAt) state.runtime.maxPosHaltActive = false;
              } else if (openCount >= maxPos) {
                state.runtime.maxPosHaltActive = true;
              }
              if (state.runtime.maxPosHaltActive || openCount >= maxPos) {
                paperAttempt.reason = `skip:maxPositionsHysteresis(open=${openCount},max=${maxPos},resumeAt=${resumeAt})`;
                try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
                return;
              }
            } catch {}

            paperAttempt.attempted = true;
            // Confidence-sized live entry: USD target in [$2..$7] band by confidence.
            const rawConf = Number(evt?.confidenceScore ?? job?.confidenceScore ?? NaN);
            const conf = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.5;
            const usdMin = Number(cfg.LIVE_MOMO_USD_MIN || 2);
            const usdMax = Number(cfg.LIVE_MOMO_USD_MAX || 7);
            const usdTarget = usdMin + ((usdMax - usdMin) * conf);
            const maxSol = usdTarget / solUsd;
            const inAmountLamports = toBaseUnits(maxSol, DECIMALS[cfg.SOL_MINT] ?? 9);

            let res;
            try {
              res = await executeSwap({
                conn,
                wallet,
                inputMint: cfg.SOL_MINT,
                outputMint: mint,
                inAmountBaseUnits: inAmountLamports,
                slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
                maxPriceImpactPct: cfg.MAX_PRICE_IMPACT_PCT,
              });
              paperAttempt.signature = res.signature;
              paperAttempt.reason = 'ok:swap_submitted';
              try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
            } catch (e) {
              paperAttempt.reason = `fail:swapError:${e?.message || String(e)}`;
              try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
              // Surface a compact warning
              await send(cfg, `⚠️ Live momo entry FAILED for ${tokenLabel({ name: evt?.name, fallbackName: job?.name, symbol: evt.symbol, fallbackSymbol: job?.symbol, mint })} — ${paperAttempt.reason.slice(0,140)}`);
              return;
            }

            const now = Date.now();
            state.positions ||= {};
            state.positions[mint] = {
              status: 'open',
              mint,
              symbol: evt.symbol || job.symbol || null,
              tokenName: evt?.name || job?.name || null,
              decimals: null,
              pairUrl: null,
              entryAt: new Date(now).toISOString(),
              entryPriceUsd: job.entryPrice,
              peakPriceUsd: job.entryPrice,
              trailingActive: false,
              stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
              stopEvalMode: 'conservative_exec_mark',
              // Adaptive trailing baseline rule: pnl <30% => hard stop at entry.
              stopPriceUsd: job.entryPrice,
              mcapUsdAtEntry: null,
              liquidityUsdAtEntry: null,
              trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
              trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
              lastStopUpdateAt: new Date(now).toISOString(),
              lastSeenPriceUsd: job.entryPrice,
              entryTx: res.signature,
              spentSolApprox: maxSol,
              solUsdAtEntry: solUsd,
              note: 'live_momo',
            };

            const fillIn = Number(res?.fill?.inAmountRaw || 0);
            const fillOut = Number(res?.fill?.outAmountRaw || 0);
            const outDecimals = Number(res?.fill?.outDecimals || 0);
            const fillInSol = fillIn > 0 ? (fillIn / 1e9) : maxSol;
            const fillOutTokens = (fillOut > 0 && outDecimals >= 0) ? (fillOut / (10 ** outDecimals)) : null;
            const liveEntryPriceUsd = (fillOutTokens && fillOutTokens > 0 && solUsd > 0)
              ? ((fillInSol * solUsd) / fillOutTokens)
              : Number(job.entryPrice || 0);

            state.positions[mint].entryPriceUsd = liveEntryPriceUsd;
            state.positions[mint].peakPriceUsd = liveEntryPriceUsd;
            state.positions[mint].stopPriceUsd = liveEntryPriceUsd;
            state.positions[mint].lastSeenPriceUsd = liveEntryPriceUsd;
            state.positions[mint].entryPriceSource = (fillOutTokens && fillOutTokens > 0) ? 'jupiter_fill' : 'snapshot';
            state.positions[mint].spentSolApprox = fillInSol;
            state.positions[mint].receivedTokensRaw = fillOut || null;

            const sizeLine = `• size: ${usdTarget.toFixed(2)} USD (conf=${conf.toFixed(2)}, ≈ ${maxSol.toFixed(4)} SOL)`;

            await send(cfg, [
              `🟢 *LIVE ENTRY (momo)* — ${tokenLabel({ name: evt?.name, fallbackName: job?.name, symbol: evt.symbol, fallbackSymbol: job?.symbol, mint })}`, 
              sizeLine,
              `• entry price (per token): $${Number(liveEntryPriceUsd || 0).toFixed(10)} (${state.positions[mint].entryPriceSource})`,
              `• stop: ${cfg.LIVE_MOMO_STOP_AT_ENTRY ? 'entry (scratch)' : `-${(cfg.STOP_LOSS_PCT*100).toFixed(1)}%`}`,
              `• trail: adaptive tiers (<10%=no trail, ≥10%=12%, ≥25%=18%, ≥60%=22%, ≥120%=18%)`,
              `• tx: https://solscan.io/tx/${res.signature}`,
            ].join('\n'));
          }
        } else {
          if (cfg.LIVE_MOMO_ENABLED && !cfg.TRACKER_LIVE_EXECUTION_ENABLED) {
            paperAttempt.reason = 'skip:tracker_live_execution_disabled';
            try { appendJsonl(attemptsFp, { ...paperAttempt, stage: 'decision' }); } catch {}
          }
          if (cfg.PAPER_ENABLED || !cfg.LIVE_MOMO_ENABLED) {
            await send(cfg, `📝 *PAPER ENTRY* ${tokenLabel({ name: evt?.name, fallbackName: job?.name, symbol: evt.symbol, fallbackSymbol: job?.symbol, mint })}\n• ret15m=${(evt.ret15*100).toFixed(1)}% ret5m=${(evt.ret5*100).toFixed(1)}%`);
          }
        }
      }

      if (evt?.kind === 'exit') {
        // Avoid confusing live trading notifications: only surface PAPER EXIT alerts when paper mode is explicitly on.
        if (cfg.PAPER_ENABLED || !cfg.LIVE_MOMO_ENABLED) {
          await send(cfg, `📝 *PAPER EXIT* ${tokenLabel({ name: evt?.name, fallbackName: job?.name, symbol: evt.symbol, fallbackSymbol: job?.symbol, mint })}\n• reason=${evt.reason} pnl=${(evt.pnlPct*100).toFixed(1)}%`);
        }
      }
    } catch {}

    if (wroteSample) job.samples = (job.samples || 0) + 1;

    const age = t - job.startedAt;
    if (age >= horizonMs) {
      // Build series and simulate
      let series = [];
      try {
        const lines = fs.readFileSync(fp, 'utf8').trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          const o = JSON.parse(line);
          const p = Number(o?.priceUsd);
          if (Number.isFinite(p) && p > 0) series.push({ t: o.t, price: p });
        }
      } catch {}

      const sim = simulateStops({
        entryPrice: job.entryPrice,
        series,
        stopLossPct: cfg.STOP_LOSS_PCT,
        trailActivatePct: cfg.TRAIL_ACTIVATE_PCT,
        trailDistancePct: cfg.TRAIL_DISTANCE_PCT,
      });

      const resultPath = path.join(cfg.TRACK_DIR, 'results.jsonl');
      appendJsonl(resultPath, {
        t: nowIso(),
        mint,
        symbol: job.symbol,
        startedAt: job.startedAtIso,
        horizonHours: cfg.TRACK_HORIZON_HOURS,
        samples: job.samples || 0,
        entryPrice: job.entryPrice,
        ...sim,
        pnlPct: (sim.exitPrice && job.entryPrice) ? ((sim.exitPrice - job.entryPrice) / job.entryPrice) : null,
      });

      job.completed = true;

      // Optional: Ping a short summary (rate-limited by completion frequency)
      if (cfg.TRACK_RESULT_ALERTS_ENABLED) {
        try {
          const pnlPct = (sim.exitPrice && job.entryPrice) ? ((sim.exitPrice - job.entryPrice) / job.entryPrice) : null;
          const fmt = (x) => (x == null ? 'n/a' : `${(x*100).toFixed(1)}%`);
          const msg = [
            '🧪 *Track result* (simulated rules, 24h horizon)',
            `• ${tokenLabel({ symbol: job.symbol, mint })}`,
            `• exit: ${sim.exitReason || 'n/a'}  pnl: ${fmt(pnlPct)}`,
            `• max run-up: ${fmt(sim.maxRunupPct)}  max drawdown: ${fmt(sim.maxDrawdownPct)}`,
          ].join('\n');
          await send(cfg, msg);
        } catch {}
      }
    }
  }

  // cleanup completed
  for (const mint of Object.keys(active)) {
    if (active[mint]?.completed) delete active[mint];
  }
  state.track.active = active;

  // Low-noise tracker ingestion warning policy:
  // - critical: alert immediately
  // - warning: alert only after 2+ consecutive warning windows
  // - reminders while degraded: at most every 2h
  try {
    const health = evaluateTrackerIngestionHealth({ cfg, state, nowMs: Date.now() });
    state.track.ingest ||= {};
    const ingest = state.track.ingest;
    const nowMs = Date.now();

    const prevSeverity = String(ingest.lastWarnSeverity || 'ok');
    if (health.severity === 'warning') {
      ingest.warningStreak = Number(ingest.warningStreak || 0) + 1;
    } else {
      ingest.warningStreak = 0;
    }

    const changed = prevSeverity !== health.severity;
    const reminderDue = (health.severity !== 'ok') && ((nowMs - Number(ingest.lastWarnAtMs || 0)) > 2 * 60 * 60_000);
    const shouldSend = health.activeCount > 0 && (
      (health.severity === 'critical' && (changed || reminderDue))
      || (health.severity === 'warning' && (Number(ingest.warningStreak || 0) >= 2) && (changed || reminderDue))
    );

    ingest.lastWarnSeverity = health.severity;
    if (shouldSend) {
      ingest.lastWarnAtMs = nowMs;
      const sev = health.severity === 'critical' ? '🚨' : '⚠️';
      await send(cfg, `${sev} Tracker ingestion ${health.severity}: ${health.recentCount} points in ${health.windowMinutes}m (min expected ${health.minExpected}, active ${health.activeCount}). /diag for details.`);
    }
  } catch {}
}
