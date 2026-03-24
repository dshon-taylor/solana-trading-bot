import { describe, it, expect } from 'vitest';
import { paperOnSample } from '../src/paper_momentum.mjs';

function mkCfg(overrides = {}) {
  return {
    LIVE_MOMO_ENABLED: true,
    PAPER_ENABLED: false,

    PAPER_ENTRY_COOLDOWN_MS: 60_000,
    PAPER_ENTRY_RET_15M_PCT: 0.12,
    PAPER_ENTRY_RET_5M_PCT: 0.04,
    PAPER_ENTRY_GREEN_LAST5: 4,

    PAPER_STOP_AT_ENTRY: true,
    PAPER_STOP_AT_ENTRY_BUFFER_PCT: 0.0005,

    PAPER_STOP_LOSS_PCT: 0.18,
    PAPER_TRAIL_ACTIVATE_PCT: 0.12,
    PAPER_TRAIL_DISTANCE_PCT: 0.12,
    PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE: true,

    ...overrides,
  };
}

function feedSeries({ cfg, state, mint, symbol, startMs, stepMs, prices }) {
  const out = [];
  prices.forEach((priceUsd, i) => {
    const tMs = startMs + i * stepMs;
    const tIso = new Date(tMs).toISOString();
    const evt = paperOnSample({
      cfg,
      state,
      mint,
      symbol,
      entryAnchorPrice: prices[0],
      tIso,
      tMs,
      priceUsd,
    });
    if (evt) out.push(evt);
  });
  return out;
}

describe('paper_momentum', () => {
  it('enters when momentum thresholds are met', () => {
    const cfg = mkCfg({
      PAPER_ENTRY_RET_15M_PCT: 0.1,
      PAPER_ENTRY_RET_5M_PCT: 0.05,
      PAPER_ENTRY_GREEN_LAST5: 4,
    });
    const state = {};

    // 16 minutes of 1-minute bars; last 5 mins trending up strongly.
    const startMs = Date.now() - 16 * 60_000;
    const prices = [];
    let p = 1.0;
    for (let i = 0; i < 11; i++) prices.push((p += 0.001));
    for (let i = 0; i < 6; i++) prices.push((p += 0.02));

    const evts = feedSeries({
      cfg,
      state,
      mint: 'MINT',
      symbol: 'TKN',
      startMs,
      stepMs: 60_000,
      prices,
    });

    expect(evts.some((e) => e.kind === 'entry')).toBe(true);
  });

  it('sets stop-at-entry with 0.05% buffer', () => {
    const state = {};
    const startMs = Date.now() - 16 * 60_000;

    // Force an entry by making thresholds trivially easy.
    const easy = mkCfg({
      PAPER_ENTRY_RET_15M_PCT: -1,
      PAPER_ENTRY_RET_5M_PCT: -1,
      PAPER_ENTRY_GREEN_LAST5: 0,
      PAPER_STOP_AT_ENTRY_BUFFER_PCT: 0.0005,
    });

    feedSeries({
      cfg: easy,
      state,
      mint: 'MINT2',
      symbol: 'TKN',
      startMs,
      stepMs: 60_000,
      prices: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    });

    const pos = state.paper.positions['MINT2'];
    expect(pos).toBeTruthy();
    expect(pos.stopPx).toBeCloseTo(1.0 * (1 - 0.0005), 10);
  });

  it('activates trailing at +10% (single-source tier rules) and raises stop to breakeven on activation', () => {
    const cfg = mkCfg({
      PAPER_ENTRY_RET_15M_PCT: -1,
      PAPER_ENTRY_RET_5M_PCT: -1,
      PAPER_ENTRY_GREEN_LAST5: 0,
      // Intentionally set a conflicting legacy value; single-source tier logic should still activate at +10%.
      PAPER_TRAIL_ACTIVATE_PCT: 0.30,
      PAPER_TRAIL_DISTANCE_PCT: 0.12,
      PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE: true,
      PAPER_STOP_AT_ENTRY_BUFFER_PCT: 0.0005,
    });
    const state = {};
    const startMs = Date.now() - 20 * 60_000;

    // Entry at 1.0
    feedSeries({
      cfg,
      state,
      mint: 'MINT3',
      symbol: 'TKN',
      startMs,
      stepMs: 60_000,
      prices: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
    });

    // Pump to +10% to activate trailing under unified tier rules.
    feedSeries({
      cfg,
      state,
      mint: 'MINT3',
      symbol: 'TKN',
      startMs: startMs + 6 * 60_000,
      stepMs: 60_000,
      prices: [1.05, 1.10],
    });

    const pos = state.paper.positions['MINT3'];
    expect(pos).toBeTruthy();
    expect(pos.trailActivated).toBe(true);
    // Stop should be at least entry (breakeven) after activation.
    expect(pos.stopPx).toBeGreaterThanOrEqual(pos.entryPrice);
  });
});
