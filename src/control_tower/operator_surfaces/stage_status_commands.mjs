import { estimateEquityUsd } from '../portfolio_control.mjs';
import { positionCount } from '../position_policy.mjs';
import { isPaperModeActive, jupCooldownRemainingMs } from '../route_control.mjs';
import { formatTrackerIngestionSummary } from '../../tracker.mjs';
import { getModels } from '../../ai_pipeline.mjs';
import { fmtUsd } from '../ops_reporting.mjs';
import { nowIso, safeErr } from '../../logger.mjs';

export async function handleStatusCommands(ctx) {
  const { cfg, state, tgSend, getSolUsdPrice, getLoopState } = ctx;
  const { dexCooldownUntil, lastScan, lastSolUsdAt } = getLoopState();

  if (state.flags?.sendStatus) {
    state.flags.sendStatus = false;
    try {
      const { conn, pub } = ctx;
      const { solUsd } = await getSolUsdPrice();
      const { equityUsd, solLamports } = await estimateEquityUsd(cfg, conn, pub, state, solUsd);
      const openCount = positionCount(state);
      const effLiqFloor = state.filterOverrides?.MIN_LIQUIDITY_USD ?? cfg.MIN_LIQUIDITY_FLOOR_USD;
      const effMinMcap = state.filterOverrides?.MIN_MCAP_USD ?? cfg.MIN_MCAP_USD;
      const effMinAge = state.filterOverrides?.MIN_TOKEN_AGE_HOURS ?? cfg.MIN_TOKEN_AGE_HOURS;
      await tgSend(cfg, [
        '🧾 *Status*',
        `🕒 ${nowIso()}`,
        '',
        `👛 Wallet: ${pub}`,
        `• SOL: ${(solLamports/1e9).toFixed(4)}  |  SOLUSD: $${solUsd.toFixed(2)}`,
        `• Equity≈: ${fmtUsd(equityUsd)}`,
        `• Open positions: ${openCount}`,
        `• Execution config: ${cfg.EXECUTION_ENABLED ? '✅ enabled' : '🛑 disabled'}`,
        `• Runtime gate: ${state.tradingEnabled ? '✅ open' : '🛑 halted'}`,
        '',
        `⚙️ Filters: liq>=max(${effLiqFloor}, ${(state.filterOverrides?.LIQUIDITY_TO_MCAP_RATIO ?? cfg.LIQUIDITY_TO_MCAP_RATIO)}*mcap), mcap>=${effMinMcap}, age>=${effMinAge}h`,
      ].join('\n'));
    } catch (e) {
      await tgSend(cfg, `Status error: ${safeErr(e).message}`);
    }
  }

  if (state.flags?.sendModels) {
    state.flags.sendModels = false;
    const models = getModels(cfg, state);
    await tgSend(cfg, [
      `🤖 Models @ ${nowIso()}`,
      `• preprocess: ${models.preprocess}`,
      `• analyze: ${models.analyze}`,
      `• gatekeeper: ${models.gatekeeper}`,
      `Update: /setmodel preprocess gpt-5-mini | /setmodel analyze gpt-5.2 | /setmodel gatekeeper gpt-5.2`,
    ].join('\n'));
  }

  if (state.flags?.sendHealth) {
    state.flags.sendHealth = false;
    const nowMs = Date.now();
    const loopFreshSec = lastScan ? Math.round((nowMs - lastScan) / 1000) : null;
    const solFreshSec = lastSolUsdAt ? Math.round((nowMs - lastSolUsdAt) / 1000) : null;
    const dexCdSec = Math.max(0, Math.round((dexCooldownUntil - nowMs) / 1000));
    const jupCdSec = Math.max(0, Math.round(jupCooldownRemainingMs(state, nowMs) / 1000));
    const circuitState = state?.circuit?.open ? 'open' : 'closed';
    const trackerSummary = formatTrackerIngestionSummary({ cfg, state });
    await tgSend(
      cfg,
      `❤️ Health: loop=${loopFreshSec == null ? 'n/a' : `${loopFreshSec}s`} circuit=${circuitState} dexCd=${dexCdSec}s jupCd=${jupCdSec}s solData=${solFreshSec == null ? 'n/a' : `${solFreshSec}s`}\n${trackerSummary}`
    );
  }

  if (state.flags?.sendMode) {
    state.flags.sendMode = false;
    const nowMs = Date.now();
    const paperOn = isPaperModeActive({ state, cfg, nowMs });
    const mode = !state.tradingEnabled ? 'halted' : paperOn ? 'paper' : cfg.EXECUTION_ENABLED ? 'live' : 'monitoring';
    const gates = [
      `executionCfg=${cfg.EXECUTION_ENABLED ? 'on' : 'off'}`,
      `runtimeGate=${state.tradingEnabled ? 'open' : 'halted'}`,
      `paper=${paperOn ? 'on' : 'off'}`,
      `force=${cfg.FORCE_TRADING_ENABLED ? 'on' : 'off'}`,
      `playbook=${state?.playbook?.mode || 'normal'}`,
      `circuit=${state?.circuit?.open ? 'open' : 'closed'}`,
    ];
    await tgSend(cfg, `🎚️ Mode: *${mode}* (${gates.join(', ')})`);
  }
}
