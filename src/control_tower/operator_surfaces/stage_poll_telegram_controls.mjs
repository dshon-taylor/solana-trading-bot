export async function pollTelegramControls({
  t,
  cfg,
  state,
  counters,
  lastTgPoll,
  handleTelegramControls,
  tgSend,
  nowIso,
  getDiagSnapshotMessage,
  tgSendChunked,
  sendPositionsReport,
  safeErr,
}) {
  // Respect TELEGRAM_DISABLED flag to avoid polling when telegram is intentionally disabled
  try {
    const teleDisabled = String(cfg?.TELEGRAM_DISABLED || process.env.TELEGRAM_DISABLED || '').trim().toLowerCase() === 'true';
    if (teleDisabled) return { lastTgPoll };
  } catch (e) {
    // noop - fall through to normal behavior
  }

  if ((t - lastTgPoll) < cfg.TELEGRAM_POLL_EVERY_MS) {
    return { lastTgPoll };
  }

  const nextLastTgPoll = t;
  await handleTelegramControls({
    cfg,
    state,
    counters,
    send: tgSend,
    nowIso,
    onDiagRequest: (mode = 'compact', windowHours = null) => {
      const m = String(mode || 'compact').toLowerCase();
      const diagMode = (m === 'full' || m === 'momentum' || m === 'confirm' || m === 'execution' || m === 'scanner') ? m : 'compact';
      const msg = getDiagSnapshotMessage(Date.now(), diagMode, windowHours);
      Promise.resolve(tgSendChunked(msg)).catch((e) => {
        console.warn('[diag] send failed', safeErr(e).message);
      });
    },
    onPositionsRequest: () => sendPositionsReport(),
  });

  return { lastTgPoll: nextLastTgPoll };
}
