export async function runManualForceClose({
  state,
  cfg,
  t,
  conn,
  wallet,
  closePosition,
  saveState,
  tgSend,
}) {
  state.runtime ||= {};
  if (state.flags?.forceCloseMint) {
    state.runtime.forceCloseMint = String(state.flags.forceCloseMint || '').trim() || null;
    delete state.flags.forceCloseMint;
    saveState(cfg.STATE_PATH, state);
  }

  if (!state.runtime?.forceCloseMint) return;

  const mint = String(state.runtime.forceCloseMint || '').trim();
  const pos = mint ? state.positions?.[mint] : null;
  if (!mint || !pos || pos.status !== 'open') {
    delete state.runtime.forceCloseMint;
    saveState(cfg.STATE_PATH, state);
    return;
  }

  const lastTryMs = Number(pos._forceCloseLastTryAtMs || 0);
  if ((t - lastTryMs) < 10_000) return;

  pos._forceCloseLastTryAtMs = t;
  try {
    const pair = {
      baseToken: { symbol: pos?.symbol || null },
      priceUsd: Number(pos?.lastSeenPriceUsd || pos?.entryPriceUsd || 0),
      url: pos?.pairUrl || null,
    };
    await closePosition(cfg, conn, wallet, state, mint, pair, 'manual force close');
    if (state.positions?.[mint]?.status === 'closed') {
      delete state.runtime.forceCloseMint;
      await tgSend(cfg, `🛑 Manual force-close executed for ${pos?.symbol || mint.slice(0, 6) + '…'} (${mint}).`);
    }
    saveState(cfg.STATE_PATH, state);
  } catch (e) {
    pos._forceCloseLastErrAtMs = t;
    pos._forceCloseLastErr = (e && e.message) ? String(e.message) : String(e);
    saveState(cfg.STATE_PATH, state);
  }
}
