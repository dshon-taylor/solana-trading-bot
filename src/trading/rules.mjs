// Centralized trading rules (single source of truth).
// Goal: make it easy to change momentum/risk behavior in one place.

export function getMomentumRules(cfg) {
  return {
    entry: {
      ret15mPct: cfg.PAPER_ENTRY_RET_15M_PCT,
      ret5mPct: cfg.PAPER_ENTRY_RET_5M_PCT,
      greensLast5: cfg.PAPER_ENTRY_GREEN_LAST5,
      cooldownMs: cfg.PAPER_ENTRY_COOLDOWN_MS,
    },
    risk: {
      // Stop-at-entry (buffer is a tiny % below entry)
      stopAtEntry: cfg.LIVE_MOMO_STOP_AT_ENTRY,
      stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,

      // Trailing (activate once we’re up X, trail by Y)
      trailActivatePct: cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT,
      trailDistancePct: cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT,
    },
  };
}

export function getPaperRulesFromMomentumRules(cfg) {
  const r = getMomentumRules(cfg);
  return {
    PAPER_ENTRY_RET_15M_PCT: r.entry.ret15mPct,
    PAPER_ENTRY_RET_5M_PCT: r.entry.ret5mPct,
    PAPER_ENTRY_GREEN_LAST5: r.entry.greensLast5,
    PAPER_ENTRY_COOLDOWN_MS: r.entry.cooldownMs,

    PAPER_STOP_AT_ENTRY: true,
    PAPER_STOP_AT_ENTRY_BUFFER_PCT: r.risk.stopAtEntryBufferPct,

    PAPER_TRAIL_ACTIVATE_PCT: r.risk.trailActivatePct,
    PAPER_TRAIL_DISTANCE_PCT: r.risk.trailDistancePct,
    PAPER_BREAKEVEN_ON_TRAIL_ACTIVATE: true,
  };
}
