import fs from 'node:fs';
import path from 'node:path';
import { computeTrailPct } from '../signals/trailing.mjs';
import { computePreTrailStopPrice } from '../signals/stop_policy.mjs';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(fp, obj) {
  ensureDir(path.dirname(fp));
  const audit = { t_audit: new Date().toISOString(), host: process.env.HOSTNAME || null, pid: process.pid, requestId: (Math.random().toString(36).slice(2,10)) };
  fs.appendFileSync(fp, JSON.stringify({ ...audit, ...obj }) + '\n');
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return (b - a) / a;
}

function getRetFromWindow(series, windowMs, nowMs) {
  // series: [{tMs, price}]
  const cutoff = nowMs - windowMs;
  // find first point at/after cutoff (or closest after)
  let base = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].tMs >= cutoff) {
      base = series[i];
      break;
    }
  }
  if (!base) return null;
  const last = series[series.length - 1];
  return pct(base.price, last.price);
}

function greenCountLastN(series, n = 5) {
  if (series.length < 2) return 0;
  const s = series.slice(-n);
  let greens = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].price > s[i - 1].price) greens++;
  }
  return greens;
}

// Utility for diagnostics: compute the same window metrics used by paper momentum entry.
export function paperComputeMomentumWindows(series, nowMs) {
  const safeSeries = Array.isArray(series) ? series : [];
  return {
    ret15: getRetFromWindow(safeSeries, 15 * 60_000, nowMs),
    ret5: getRetFromWindow(safeSeries, 5 * 60_000, nowMs),
    greensLast5: greenCountLastN(safeSeries, 5),
  };
}

export function paperInit(state) {
  state.paper ||= { enabledUntilMs: 0, positions: {} };
  state.paper.positions ||= {};
}

export function paperSetEnabledForHours(state, hours) {
  paperInit(state);
  const h = Number(hours);
  const durMs = (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60_000;
  state.paper.enabledUntilMs = Date.now() + durMs;
}

export function paperDisable(state) {
  paperInit(state);
  state.paper.enabledUntilMs = 0;
}

export function paperIsEnabled(state, cfg) {
  paperInit(state);
  // Allow the momentum signal engine to run when live momo is enabled.
  if (cfg.LIVE_MOMO_ENABLED) return true;
  if (cfg.PAPER_ENABLED) return true;
  return Date.now() < (state.paper.enabledUntilMs || 0);
}

export function paperOnSample({ cfg, state, mint, symbol, entryAnchorPrice, tIso, tMs, priceUsd }) {
  paperInit(state);
  if (!paperIsEnabled(state, cfg)) return null;

  // Keep a small in-memory series per mint for momentum windows (store on state.track.active if present)
  state.paper.series ||= {};
  const series = (state.paper.series[mint] ||= []);
  series.push({ tMs, price: priceUsd });
  // keep last ~70 minutes worth of data max
  const cutoff = tMs - 70 * 60_000;
  while (series.length && series[0].tMs < cutoff) series.shift();

  // Update open paper position if exists
  const pos = state.paper.positions[mint];
  if (pos && pos.status === 'open') {
    const entryAtMs = Date.parse(String(pos.entryT || '')) || tMs;

    if (!pos.trailActivated) {
      const preTrailStop = computePreTrailStopPrice({
        entryPriceUsd: pos.entryPrice,
        entryAtMs,
        nowMs: tMs,
        armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
        prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
        stopAtEntryBufferPct: cfg.PAPER_STOP_AT_ENTRY_BUFFER_PCT,
      });
      if (Number.isFinite(Number(preTrailStop)) && preTrailStop > 0) {
        pos.stopPx = Math.max(Number(pos.stopPx || 0), Number(preTrailStop));
      }
    }

    // hard stop
    if (priceUsd <= pos.stopPx) {
      pos.status = 'closed';
      pos.exitT = tIso;
      pos.exitReason = 'stopLoss';
      pos.exitPrice = pos.stopPx;
    }

    // trailing (single-source tier logic via computeTrailPct, same as live)
    if (pos.status === 'open') {
      const profitPct = pct(pos.entryPrice, priceUsd);
      const desiredTrailPct = computeTrailPct(profitPct);

      if (!pos.trailActivated) {
        if (desiredTrailPct != null) {
          pos.trailActivated = true;
          pos.activeTrailPct = desiredTrailPct;
          pos.trailHigh = priceUsd;
          pos.trailStop = pos.trailHigh * (1 - desiredTrailPct);

          // Raise stop to breakeven once trailing activates ("stop loss to our entry")
          if (cfg.PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE) {
            pos.stopPx = Math.max(pos.stopPx, pos.entryPrice);
          }
        }
      } else {
        // Never widen trail: if tier changes, only allow tighter (smaller pct) values.
        if (desiredTrailPct != null && Number.isFinite(Number(pos.activeTrailPct))) {
          pos.activeTrailPct = Math.min(Number(pos.activeTrailPct), Number(desiredTrailPct));
        }
        if (priceUsd > pos.trailHigh) {
          pos.trailHigh = priceUsd;
          const activeTrail = Number.isFinite(Number(pos.activeTrailPct)) ? Number(pos.activeTrailPct) : Number(cfg.PAPER_TRAIL_DISTANCE_PCT || 0.30);
          pos.trailStop = pos.trailHigh * (1 - activeTrail);
        }
        if (priceUsd <= pos.trailStop) {
          pos.status = 'closed';
          pos.exitT = tIso;
          pos.exitReason = 'trailingStop';
          pos.exitPrice = pos.trailStop;
        }
      }
    }

    if (pos.status === 'closed') {
      const pnlPct = (pos.exitPrice - pos.entryPrice) / pos.entryPrice;
      const fp = './state/paper_trades.jsonl';
      appendJsonl(fp, {
        t: tIso,
        mode: 'paper',
        mint,
        symbol,
        entryT: pos.entryT,
        entryPrice: pos.entryPrice,
        exitT: pos.exitT,
        exitPrice: pos.exitPrice,
        exitReason: pos.exitReason,
        pnlPct,
      });
      return { kind: 'exit', mint, symbol, pnlPct, reason: pos.exitReason };
    }

    return null;
  }

  // Parity mode: entries are sourced from the same scanner/live process path.
  // In this mode this module only maintains existing paper positions (stops/trailing/exits).
  if (cfg.PAPER_USE_LIVE_PROCESS) return null;

  // If no open position, evaluate momentum entry
  state.paper.lastEntryAtMs ||= {};
  const ret15 = getRetFromWindow(series, 15 * 60_000, tMs);
  const ret5 = getRetFromWindow(series, 5 * 60_000, tMs);
  const greens = greenCountLastN(series, 5);

  const lastEntryAt = Number(state.paper.lastEntryAtMs[mint] || 0);
  const cooledDown = !lastEntryAt || (tMs - lastEntryAt) >= cfg.PAPER_ENTRY_COOLDOWN_MS;

  if (
    cooledDown &&
    ret15 != null && ret5 != null &&
    ret15 >= cfg.PAPER_ENTRY_RET_15M_PCT &&
    ret5 >= cfg.PAPER_ENTRY_RET_5M_PCT &&
    greens >= cfg.PAPER_ENTRY_GREEN_LAST5
  ) {
    const entryPrice = entryAnchorPrice || priceUsd;
    state.paper.lastEntryAtMs[mint] = tMs;
    state.paper.positions[mint] = {
      status: 'open',
      mint,
      symbol,
      entryT: tIso,
      entryPrice,
      stopPx: Number(computePreTrailStopPrice({
        entryPriceUsd: entryPrice,
        entryAtMs: tMs,
        nowMs: tMs,
        armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
        prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
        stopAtEntryBufferPct: cfg.PAPER_STOP_AT_ENTRY_BUFFER_PCT,
      }) || (entryPrice * (1 - cfg.PAPER_STOP_AT_ENTRY_BUFFER_PCT))),
      trailActivated: false,
      trailHigh: null,
      trailStop: null,
    };

    appendJsonl('./state/paper_trades.jsonl', {
      t: tIso,
      mode: 'paper',
      type: 'entry',
      mint,
      symbol,
      entryPrice,
      ret15,
      ret5,
      greensLast5: greens,
    });

    return { kind: 'entry', mint, symbol, ret15, ret5 };
  }

  return null;
}
