export async function runOpsCycle({
  t,
  cfg,
  state,
  lastHb,
  lastAlivePingCheckAt,
  evaluatePlaybook,
  circuitOkForEntries,
  runSelfRecovery,
  tgSend,
  saveState,
  positionCount,
  maybeAlivePing,
}) {
  let nextLastHb = lastHb;
  let nextLastAlivePingCheckAt = lastAlivePingCheckAt;

  if (cfg.PLAYBOOK_ENABLED) {
    const pb = evaluatePlaybook({
      state,
      cfg,
      nowMs: t,
      circuitOpen: !circuitOkForEntries({ state, nowMs: t }),
    });

    if (pb.transition === 'enter_degraded') {
      state.tradingEnabled = false;
      state.flags ||= {};
      state.flags.playbookDegraded = true;

      state.marketDataReliability = { dex: { failures: 0, backoffUntilMs: 0 } };
      state.dexCooldown = { level: 0, cooldownUntilMs: 0, lastHitMs: 0, reason: null };
      runSelfRecovery({ state, nowMs: t, note: 'reset_backoffs_and_pause_entries' });

      await tgSend(cfg, `🚧 Playbook degraded mode ON (${pb.reason}). Entries paused; running self-recovery.`);
      console.warn(`[playbook] enter_degraded reason=${pb.reason} restarts=${pb.recentRestarts} errors=${pb.recentErrors}`);
      saveState(cfg.STATE_PATH, state);
    } else if (pb.transition === 'exit_degraded') {
      state.tradingEnabled = cfg.EXECUTION_ENABLED && cfg.FORCE_TRADING_ENABLED;
      state.flags ||= {};
      state.flags.playbookDegraded = false;
      await tgSend(cfg, '✅ Playbook recovered to normal mode. Re-opening execution gate.');
      console.warn(`[playbook] exit_degraded reason=${pb.reason}`);
      saveState(cfg.STATE_PATH, state);
    }
  }

  if (t - nextLastHb >= cfg.HEARTBEAT_EVERY_MS) {
    nextLastHb = t;
    const pc = positionCount(state);
    console.log(`[hb] ${new Date(t).toISOString()} open_positions=${pc}`);
    saveState(cfg.STATE_PATH, state);
  }

  if (t - nextLastAlivePingCheckAt > 60_000) {
    nextLastAlivePingCheckAt = t;
    try {
      await maybeAlivePing({
        cfg,
        state,
        nowMs: t,
        reason: `open_positions=${positionCount(state)}`,
        persist: () => saveState(cfg.STATE_PATH, state),
      });
    } catch {}
  }

  return {
    lastHb: nextLastHb,
    lastAlivePingCheckAt: nextLastAlivePingCheckAt,
  };
}
