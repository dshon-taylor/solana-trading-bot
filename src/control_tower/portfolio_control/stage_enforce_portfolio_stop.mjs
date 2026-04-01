export async function enforcePortfolioStopGate({
  cfg,
  conn,
  pub,
  state,
  solPrice,
  nowMs,
  nowIso,
  tgSend,
  shouldStopPortfolio,
  circuitClear,
  circuitHit,
  recordPlaybookError,
  saveState,
  safeErr,
  lastRpcAlertRef,
}) {
  if (!solPrice) return { halted: false };

  try {
    const stopInfo = await shouldStopPortfolio(cfg, conn, pub, state, solPrice);
    if (stopInfo.stop) {
      state.flags ||= {};
      state.flags.portfolioStopActive = true;
      state.flags.portfolioStopReason = stopInfo.reason;
      state.flags.portfolioStopAtIso = nowIso();
      state.flags.lastPortfolioStopAlertAtMs ||= 0;

      state.tradingEnabled = false;

      if (nowMs - state.flags.lastPortfolioStopAlertAtMs > 60 * 60_000) {
        state.flags.lastPortfolioStopAlertAtMs = nowMs;
        await tgSend(cfg, `🛑 Trading halted: ${stopInfo.reason}`);
      }

      saveState(cfg.STATE_PATH, state);
      return { halted: true };
    }

    circuitClear({ state, nowMs, dep: 'rpc', persist: () => saveState(cfg.STATE_PATH, state) });
    return { halted: false };
  } catch (e) {
    if (cfg.PLAYBOOK_ENABLED) {
      recordPlaybookError({ state, nowMs, kind: 'rpc_error', note: safeErr(e).message });
    }
    circuitHit({ state, nowMs, dep: 'rpc', note: `portfolioCheck(${safeErr(e).message})`, persist: () => saveState(cfg.STATE_PATH, state) });
    const lastRpcAlertAt = Number(lastRpcAlertRef?.value || 0);
    if (nowMs - lastRpcAlertAt > 10 * 60_000) {
      if (lastRpcAlertRef) lastRpcAlertRef.value = nowMs;
      await tgSend(cfg, `⚠️ RPC/balance check failed. Pausing entries until it recovers. (${safeErr(e).message})`);
    }
    return { halted: false };
  }
}
