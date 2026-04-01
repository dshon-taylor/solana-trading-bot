export function createMainLoopState({ cfg }) {
  return {
    lastScan: 0,
    nextScanDelayMs: cfg.SCAN_EVERY_MS,
    lastPosRef: { value: 0 },
    lastHb: 0,
    lastRej: 0,
    lastTgPoll: 0,
    lastAutoTune: 0,
    lastHourlyDiag: 0,
    lastWatchlistEval: 0,
    lastExposureQueueDrainAt: 0,
    loopPrevAtMs: Date.now(),
    loopDtMs: 0,
  };
}
