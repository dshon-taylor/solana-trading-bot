async function tgSendWithRetry({ cfg, tgSend, text, attempts = 8, delayMs = 5000 }) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (await tgSend(cfg, text)) return true;
    } catch {}
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export async function announceBootStatus({ cfg, pub, tgSend, tgSetMyCommands }) {
  console.log(`[wallet] publicKey=${pub}`);
  console.log(
    `[boot] data_capture=${cfg.DATA_CAPTURE_ENABLED} execution=${cfg.EXECUTION_ENABLED} sim_tracking=${cfg.SIM_TRACKING_ENABLED} ` +
      `live_momo=${cfg.LIVE_MOMO_ENABLED} scanner_entries=${cfg.SCANNER_ENTRIES_ENABLED} scanner_tracking=${cfg.SCANNER_TRACKING_ENABLED} ` +
      `stopAtEntry=${cfg.LIVE_MOMO_STOP_AT_ENTRY} bufferPct=${cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT} ` +
      `trailActivatePct=${cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT} trailDistancePct=${cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT}`,
  );

  await tgSendWithRetry({
    cfg,
    tgSend,
    text: `🟢 *Candle Carl online*\n\n👛 Wallet: ${pub}\n🪙 Base: SOL`,
    attempts: Number(cfg.BOOT_ANNOUNCE_RETRY_ATTEMPTS || 8),
    delayMs: Number(cfg.BOOT_ANNOUNCE_RETRY_DELAY_MS || 5000),
  });

  // best-effort: command registration must never block startup/announcements
  void tgSetMyCommands(cfg);
}
