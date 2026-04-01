export async function announceBootStatus({ cfg, pub, tgSend, tgSetMyCommands }) {
  console.log(`[wallet] publicKey=${pub}`);
  console.log(
    `[boot] data_capture=${cfg.DATA_CAPTURE_ENABLED} execution=${cfg.EXECUTION_ENABLED} sim_tracking=${cfg.SIM_TRACKING_ENABLED} ` +
      `live_momo=${cfg.LIVE_MOMO_ENABLED} scanner_entries=${cfg.SCANNER_ENTRIES_ENABLED} scanner_tracking=${cfg.SCANNER_TRACKING_ENABLED} ` +
      `stopAtEntry=${cfg.LIVE_MOMO_STOP_AT_ENTRY} bufferPct=${cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT} ` +
      `trailActivatePct=${cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT} trailDistancePct=${cfg.LIVE_MOMO_TRAIL_DISTANCE_PCT}`,
  );

  await tgSend(cfg, `🟢 *Candle Carl online*\n\n👛 Wallet: ${pub}\n🪙 Base: SOL`);
  void tgSetMyCommands(cfg);
}
