import fs from 'fs';
import { nowIso } from '../observability/logger.mjs';
import { evaluateTrackerIngestionHealth, formatTrackerIngestionSummary } from '../trading/tracker.mjs';

export async function startHeartbeat({ cfg, state, _conn, walletPub, tgSend, rpcHealth }) {
  const enabled = String(process.env.HEARTBEAT_ENABLED ?? 'true') !== 'false';
  if (!enabled) return null;

  const everyMs = Number(process.env.HEARTBEAT_EVERY_MS ?? cfg.HEARTBEAT_EVERY_MS ?? 300000);
  const persistPath = process.env.HEARTBEAT_PERSIST_PATH ?? './state/heartbeat.json';
  const alertCooldownMs = Number(process.env.TELEGRAM_HEARTBEAT_ALERT_COOLDOWN_MS ?? cfg.TELEGRAM_HEARTBEAT_ALERT_COOLDOWN_MS ?? 3600000);

  let lastAlertAt = state.flags?.lastHeartbeatAlertAtMs || 0;
  let lastSnapshot = null;

  async function doHeartbeat() {
    const _nowMs = Date.now();
    const trackerHealth = evaluateTrackerIngestionHealth({ cfg, state, nowMs: _nowMs });
    const snapshot = {
      t: nowIso(),
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      wallet: walletPub,
      tradingEnabled: !!state.tradingEnabled,
      degradedMode: !!state.flags?.degradedMode,
      pauseExternalCalls: !!state.flags?.pauseExternalCalls,
      portfolioStopActive: !!state.flags?.portfolioStopActive,
      portfolioStopReason: state.flags?.portfolioStopReason || null,
      openPositions: Object.values(state.positions || {}).filter(p => p?.status === 'open').length,
      lastErrors: (state.debug && state.debug.last) ? state.debug.last.slice(-5) : [],
      rpcHealthSummary: rpcHealth ? rpcHealth.summary?.() : null,
      trackerIngestion: trackerHealth,
      trackerIngestionSummary: formatTrackerIngestionSummary({ cfg, state, nowMs: _nowMs }),
    };

    // Persist small JSON file for external monitors
    try {
      fs.writeFileSync(persistPath, JSON.stringify(snapshot, null, 2));
    } catch (_e) {
      // ignore
    }

    // Send Telegram alert if a significant change happened (portfolio stop toggled / circuit changed / pauseExternalCalls toggled)
    const significant = (
      (lastSnapshot && lastSnapshot.portfolioStopActive !== snapshot.portfolioStopActive) ||
      (lastSnapshot && lastSnapshot.pauseExternalCalls !== snapshot.pauseExternalCalls) ||
      (lastSnapshot && lastSnapshot.degradedMode !== snapshot.degradedMode) ||
      (lastSnapshot && lastSnapshot.trackerIngestion?.severity !== snapshot.trackerIngestion?.severity)
    );

    if (significant && (Date.now() - lastAlertAt) > alertCooldownMs) {
      lastAlertAt = Date.now();
      state.flags = state.flags || {};
      state.flags.lastHeartbeatAlertAtMs = lastAlertAt;
      try {
        const lines = [
          `🤖 Heartbeat alert: tradingEnabled=${snapshot.tradingEnabled ? 'on' : 'off'}`,
          `• degraded=${snapshot.degradedMode}  pauseExternal=${snapshot.pauseExternalCalls}`,
          `• portfolioStop=${snapshot.portfolioStopActive} ${snapshot.portfolioStopReason || ''}`,
          `• openPositions=${snapshot.openPositions}`,
          snapshot.rpcHealthSummary ? `• rpc: ${snapshot.rpcHealthSummary.best?.url || 'n/a'}` : null,
          snapshot.trackerIngestionSummary,
        ].filter(Boolean).join('\n');
        await tgSend(cfg, lines);
      } catch (_e) {
        // ignore send failures
      }
    }

    lastSnapshot = snapshot;
  }

  // Run immediately once
  doHeartbeat().catch(() => {});

  const id = globalThis.setInterval(() => {
    doHeartbeat().catch(() => {});
  }, everyMs);

  return {
    stop: () => globalThis.clearInterval(id),
  };
}
