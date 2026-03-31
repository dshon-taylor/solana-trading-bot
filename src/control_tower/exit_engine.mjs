import { getSplBalance } from '../portfolio.mjs';
import { getTokenSupply } from '../helius.mjs';
import { executeSwap } from '../trader.mjs';
import { appendTradingLog, nowIso } from '../logger.mjs';
import { tgSend } from '../telegram.mjs';
import { pushDebug } from '../debug_buffer.mjs';
import { saveState } from '../state.mjs';
import { appendJsonl } from '../candidates_ledger.mjs';
import { tokenDisplayName, tokenDisplayWithSymbol } from './position_policy.mjs';
import { processExposureQueue } from './entry_engine.mjs';
import { computeTrailPct, computeStopFromAnchor, updateTrailingAnchor } from '../lib/trailing.mjs';
import { computePreTrailStopPrice } from '../lib/stop_policy.mjs';

function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function recordHardStopAndMaybePause({ cfg, state, nowMs, reason }) {
  if (!cfg.HARD_STOP_COOLDOWN_ENABLED) return { tripped: false };
  const why = String(reason || '').toLowerCase();
  const isHardStop = why.includes('stop hit') && !why.includes('trailing stop');
  if (!isHardStop) return { tripped: false };

  state.runtime ||= {};
  state.runtime.hardStopEventsMs ||= [];
  const windowMs = Number(cfg.HARD_STOP_COOLDOWN_WINDOW_MS || (15 * 60_000));
  const cutoff = nowMs - windowMs;
  state.runtime.hardStopEventsMs = state.runtime.hardStopEventsMs.filter((ts) => Number(ts || 0) >= cutoff);
  state.runtime.hardStopEventsMs.push(nowMs);

  const trigger = Number(cfg.HARD_STOP_COOLDOWN_TRIGGER_COUNT || 3);
  if (state.runtime.hardStopEventsMs.length >= trigger) {
    state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
    const pauseMs = Number(cfg.HARD_STOP_COOLDOWN_PAUSE_MS || (20 * 60_000));
    const until = nowMs + pauseMs;
    state.exposure.pausedUntilMs = Math.max(Number(state.exposure.pausedUntilMs || 0), until);
    state.runtime.hardStopEventsMs = [];
    return { tripped: true, untilMs: state.exposure.pausedUntilMs };
  }
  return { tripped: false };
}

export function createExitEngine({ getSolUsdPrice }) {
  async function closePosition(cfg, conn, wallet, state, mint, pair, reason) {
    const pos = state.positions[mint];
    if (!pos || pos.status !== 'open') return;

    const tokenBal = await getSplBalance(conn, wallet.publicKey.toBase58(), mint);
    const amount = tokenBal.amount;

    if (tokenBal.fetchOk === false) {
      pos.exitPending = true;
      pos.lastExitAttemptAt = nowIso();
      pos.lastExitAttemptReason = reason;
      pos._lastNoBalAlertAtMs = pos._lastNoBalAlertAtMs || 0;
      const nowMs = Date.now();
      if (nowMs - pos._lastNoBalAlertAtMs > 10 * 60_000) {
        pos._lastNoBalAlertAtMs = nowMs;
        await tgSend(cfg, `⚠️ EXIT blocked for ${pos.symbol || mint.slice(0,6)+'…'}: couldn't fetch token balance reliably (${tokenBal.error || 'unknown'}). Will keep retrying.`);
      }
      return;
    }

    if (!amount || amount <= 0) {
      pos.exitPending = true;
      pos.lastExitAttemptAt = nowIso();
      pos.lastExitAttemptReason = reason;
      pos._lastNoBalAlertAtMs = pos._lastNoBalAlertAtMs || 0;
      const nowMs = Date.now();
      if (nowMs - pos._lastNoBalAlertAtMs > 10 * 60_000) {
        pos._lastNoBalAlertAtMs = nowMs;
        await tgSend(cfg, `⚠️ EXIT blocked for ${pos.symbol || mint.slice(0,6)+'…'}: token balance read as 0 (source=${tokenBal.source || 'unknown'}, ata=${tokenBal.ata}). If you still see the token in wallet, this is an RPC/indexing mismatch; I'll keep retrying.`);
      }
      return;
    }

    const res = await executeSwap({
      conn,
      wallet,
      inputMint: mint,
      outputMint: cfg.SOL_MINT,
      inAmountBaseUnits: amount,
      slippageBps: cfg.DEFAULT_SLIPPAGE_BPS,
    });

    const entryPriceUsd = Number(pos.entryPriceUsd || 0) || null;
    const soldRaw = Number(res?.fill?.inAmountRaw || amount || 0);
    let soldDecimals = Number(res?.fill?.inDecimals);
    if (!Number.isFinite(soldDecimals) || soldDecimals < 0) soldDecimals = Number(pos.decimals);
    if (!Number.isFinite(soldDecimals) || soldDecimals < 0) {
      try {
        const sup = await getTokenSupply(cfg.SOLANA_RPC_URL, mint);
        soldDecimals = Number(sup?.decimals);
        if (Number.isFinite(soldDecimals) && soldDecimals >= 0) pos.decimals = soldDecimals;
      } catch {}
    }
    const soldTokens = (soldRaw > 0 && Number.isFinite(soldDecimals) && soldDecimals >= 0)
      ? (soldRaw / (10 ** soldDecimals))
      : null;
    const outSolRaw = Number(res?.fill?.outAmountRaw || 0);
    const outSol = outSolRaw > 0 ? (outSolRaw / 1e9) : null;

    let solUsdExit = Number(pos.solUsdAtEntry || 0) || null;
    try {
      const q = await getSolUsdPrice();
      if (Number.isFinite(Number(q?.solUsd)) && Number(q.solUsd) > 0) solUsdExit = Number(q.solUsd);
    } catch {}

    const liveExitPriceUsd = (soldTokens && outSol && solUsdExit)
      ? ((outSol * solUsdExit) / soldTokens)
      : null;
    const exitPriceUsd = Number(liveExitPriceUsd || pair.priceUsd || pos.lastSeenPriceUsd || 0) || null;

    const pnlPct = (entryPriceUsd && exitPriceUsd) ? ((exitPriceUsd - entryPriceUsd) / entryPriceUsd) : null;
    const entryUsdApprox = (Number(pos.spentSolApprox || 0) && Number(pos.solUsdAtEntry || 0))
      ? (Number(pos.spentSolApprox || 0) * Number(pos.solUsdAtEntry || 0))
      : null;
    const pnlUsdApprox = (entryUsdApprox != null && pnlPct != null) ? (entryUsdApprox * pnlPct) : null;
    const exitFeeLamports = Number(res?.fill?.feeLamports || 0) || 0;
    const entryFeeUsd = Number(pos.entryFeeUsd || 0) || 0;
    const exitFeeUsd = (solUsdExit && exitFeeLamports > 0) ? ((exitFeeLamports / 1e9) * solUsdExit) : 0;
    const pnlUsdNetApprox = (pnlUsdApprox == null) ? null : (pnlUsdApprox - entryFeeUsd - exitFeeUsd);

    pos.status = 'closed';
    pos.exitAt = nowIso();
    pos.exitTx = res.signature;
    pos.exitReason = reason;
    pos.exitPriceUsd = exitPriceUsd;

    try {
      const why = String(reason || '').toLowerCase();
      const isStopExit = why.includes('stop hit') || why.includes('stop loss hit') || why.includes('trailing stop hit');
      if (isStopExit) {
        const nowMsLocal = Date.now();
        const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMsLocal;
        const heldMs = Math.max(0, nowMsLocal - entryAtMs);
        const fastStopMaxAgeMs = Math.max(0, Number(cfg.LIVE_FAST_STOP_REENTRY_STOP_MAX_AGE_MS || 45_000));
        const fastStopWindowMs = Math.max(0, Number(cfg.LIVE_FAST_STOP_REENTRY_WINDOW_MS || 180_000));
        const isFastStop = heldMs <= fastStopMaxAgeMs;
        state.runtime ||= {};
        state.runtime.requalifyAfterStopByMint ||= {};
        state.runtime.requalifyAfterStopByMint[mint] = {
          blockedAtMs: nowMsLocal,
          trigger: 'stop',
          entryPriceUsd: Number(pos.entryPriceUsd || 0) || null,
          exitPriceUsd: Number(exitPriceUsd || 0) || null,
          fastStopActive: isFastStop,
          holdUntilMs: isFastStop ? (nowMsLocal + fastStopWindowMs) : null,
          holdMs: heldMs,
          breakoutAboveUsd: Number(pos.lastPeakPrice || pos.peakPriceUsd || pos.entryPriceUsd || 0) || null,
          requireNewHigh: cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_NEW_HIGH === true,
          requireTradeUpticks: cfg.LIVE_FAST_STOP_REENTRY_REQUIRE_TRADE_UPTICKS === true,
          minConsecutiveTradeUpticks: Math.max(1, Number(cfg.LIVE_FAST_STOP_REENTRY_MIN_CONSEC_TRADE_UPTICKS || 2)),
        };
      }
    } catch {}

    try {
      const hs = recordHardStopAndMaybePause({ cfg, state, nowMs: Date.now(), reason });
      if (hs?.tripped && Number.isFinite(Number(hs.untilMs || 0))) {
        const untilIso = new Date(Number(hs.untilMs)).toISOString();
        await tgSend(cfg, `🧯 Hard-stop cooldown engaged: 3 hard stops in 15m. Pausing new entries until ${untilIso}.`);
      }
    } catch {}

    pos.exitPriceSource = Number.isFinite(Number(liveExitPriceUsd)) && Number(liveExitPriceUsd) > 0 ? 'jupiter_fill_math' : 'snapshot';
    pos.exitSoldTokens = soldTokens || null;
    pos.exitOutSol = outSol || null;
    pos.exitFeeLamports = exitFeeLamports || null;
    pos.exitFeeUsd = exitFeeUsd || null;
    pos.pnlPct = pnlPct;
    pos.pnlUsdApprox = pnlUsdApprox;
    pos.pnlUsdNetApprox = pnlUsdNetApprox;
    pos.lastSeenPriceUsd = exitPriceUsd ?? (Number(pos.lastSeenPriceUsd || 0) || null);

    try {
      state.runtime ||= {};
      state.runtime.diagCounters ||= {};
      const dc = state.runtime.diagCounters;
      dc.runnerCapture ||= {
        exitsUnder15s: 0,
        holdSecSamples: [],
        reached5BeforeExit: 0,
        reached10BeforeExit: 0,
        reached20BeforeExit: 0,
        reached30BeforeExit: 0,
        exitedBeforePostEntryLocalMax10m: 0,
        totalExitsMeasured: 0,
      };
      const rc = dc.runnerCapture;
      const entryMs = Date.parse(String(pos.entryAt || 0));
      const exitMs = Date.parse(String(pos.exitAt || 0));
      const holdSec = (Number.isFinite(entryMs) && Number.isFinite(exitMs) && exitMs > entryMs)
        ? ((exitMs - entryMs) / 1000)
        : null;
      if (Number.isFinite(holdSec)) {
        if (holdSec < 15) rc.exitsUnder15s = Number(rc.exitsUnder15s || 0) + 1;
        rc.holdSecSamples = Array.isArray(rc.holdSecSamples) ? rc.holdSecSamples : [];
        rc.holdSecSamples.push(Number(holdSec.toFixed(3)));
        if (rc.holdSecSamples.length > 400) rc.holdSecSamples = rc.holdSecSamples.slice(-400);
      }
      const peak = Number(pos.lastPeakPrice || pos.peakPriceUsd || 0);
      const entryPxN = Number(pos.entryPriceUsd || 0);
      if (entryPxN > 0 && peak > 0) {
        const peakRet = (peak / entryPxN) - 1;
        if (peakRet >= 0.05) rc.reached5BeforeExit = Number(rc.reached5BeforeExit || 0) + 1;
        if (peakRet >= 0.10) rc.reached10BeforeExit = Number(rc.reached10BeforeExit || 0) + 1;
        if (peakRet >= 0.20) rc.reached20BeforeExit = Number(rc.reached20BeforeExit || 0) + 1;
        if (peakRet >= 0.30) rc.reached30BeforeExit = Number(rc.reached30BeforeExit || 0) + 1;
      }
      const peakAtMs = Number(pos.peakAtMs || pos.lastPeakAtMs || 0);
      if (Number.isFinite(exitMs) && exitMs > 0 && Number.isFinite(peakAtMs) && peakAtMs > 0 && Number.isFinite(entryMs) && entryMs > 0) {
        if (exitMs < peakAtMs && (peakAtMs - entryMs) <= 10 * 60_000) {
          rc.exitedBeforePostEntryLocalMax10m = Number(rc.exitedBeforePostEntryLocalMax10m || 0) + 1;
        }
      }
      rc.totalExitsMeasured = Number(rc.totalExitsMeasured || 0) + 1;
    } catch {}

    const symbol = tokenDisplayName({
      name: pos?.tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
      symbol: pos?.symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
      mint,
    });
    const exitHeader = tokenDisplayWithSymbol({
      name: pos?.tokenName || pair?.baseToken?.name || pair?.birdeye?.raw?.name || null,
      symbol: pos?.symbol || pair?.baseToken?.symbol || pair?.birdeye?.raw?.symbol || null,
      mint,
    });
    const pnlLine = (pnlPct == null)
      ? '• PnL: n/a'
      : `• PnL: ${(pnlPct * 100).toFixed(2)}%`
        + (pnlUsdApprox == null
          ? ''
          : ` (gross≈ ${fmtUsd(pnlUsdApprox)}${pnlUsdNetApprox == null ? '' : `, net≈ ${fmtUsd(pnlUsdNetApprox)}`})`);

    const tradeRow = {
      time: nowIso(),
      kind: 'exit',
      mint,
      symbol: symbol || null,
      entryAt: pos.entryAt || null,
      exitAt: pos.exitAt || null,
      entryTx: pos.entryTx || null,
      exitTx: res.signature || null,
      spentSolApprox: pos.spentSolApprox || null,
      solUsdAtEntry: pos.solUsdAtEntry || null,
      entryPriceUsd: entryPriceUsd || null,
      exitPriceUsd: exitPriceUsd || null,
      entryPriceSource: pos.entryPriceSource || null,
      exitPriceSource: pos.exitPriceSource || null,
      liquidityUsdAtEntry: Number(pos.liquidityUsdAtEntry || 0) || null,
      mcapUsdAtEntry: Number(pos.mcapUsdAtEntry || 0) || null,
      holdersAtEntry: Number(pos.holdersAtEntry || 0) || null,
      uniqueBuyersAtEntry: Number(pos.uniqueBuyersAtEntry || 0) || null,
      topHolderPctAtEntry: Number(pos.topHolderPctAtEntry || 0) || null,
      top10PctAtEntry: Number(pos.top10PctAtEntry || 0) || null,
      bundleClusterPctAtEntry: Number(pos.bundleClusterPctAtEntry || 0) || null,
      creatorClusterPctAtEntry: Number(pos.creatorClusterPctAtEntry || 0) || null,
      lpLockPctAtEntry: Number(pos.lpLockPctAtEntry || 0) || null,
      lpUnlockedAtEntry: pos.lpUnlockedAtEntry ?? null,
      signalBuyDominance: Number(pos.signalBuyDominance || 0) || null,
      signalTx1h: Number(pos.signalTx1h || 0) || null,
      spreadPctAtEntry: Number(pos.spreadPctAtEntry || 0) || null,
      marketDataSourceAtEntry: pos.marketDataSourceAtEntry || null,
      marketDataConfidenceAtEntry: pos.marketDataConfidenceAtEntry || null,
      marketDataFreshnessMsAtEntry: Number(pos.marketDataFreshnessMsAtEntry || 0) || null,
      quotePriceImpactPctAtEntry: Number(pos.quotePriceImpactPctAtEntry || 0) || null,
      requestedSlippageBpsAtEntry: Number(pos.requestedSlippageBpsAtEntry || 0) || null,
      maxPriceImpactPctAtEntry: Number(pos.maxPriceImpactPctAtEntry || 0) || null,
      entryFeeLamports: Number(pos.entryFeeLamports || 0) || null,
      entryFeeUsd: Number(pos.entryFeeUsd || 0) || null,
      exitSoldTokens: soldTokens || null,
      exitOutSol: outSol || null,
      exitFeeLamports: exitFeeLamports || null,
      exitFeeUsd: exitFeeUsd || null,
      pnlPct: pnlPct == null ? null : Number(pnlPct),
      pnlUsdApprox: pnlUsdApprox == null ? null : Number(pnlUsdApprox),
      pnlUsdNetApprox: pnlUsdNetApprox == null ? null : Number(pnlUsdNetApprox),
      exitReason: reason || null,
    };

    let wrote = false;
    let attempts = 0;
    const maxAttempts = 3;
    while (!wrote && attempts < maxAttempts) {
      attempts += 1;
      try {
        appendJsonl(cfg.TRADES_LEDGER_PATH, tradeRow);
        wrote = true;
      } catch {
        await new Promise(r => setTimeout(r, 200 * attempts));
      }
    }
    if (!wrote) {
      await tgSend(cfg, `⚠️ EXIT recorded in state but failed to write to trades ledger for ${symbol} (${mint}). Will retry in background.`);
      state.positions[mint] = pos;
      saveState(cfg.STATE_PATH, state);
      return;
    }

    const msg = [
      `🔴 *EXIT* — ${exitHeader}`,
      '',
      `🧾 Mint: \`${mint}\``,
      `📌 Reason: ${reason}`,
      `🏷️ Exit price source: ${pos.exitPriceSource || 'snapshot'}`,
      Number.isFinite(Number(exitPriceUsd)) ? `💵 Exit price (per token): $${Number(exitPriceUsd).toFixed(10)}` : '💵 Exit price (per token): n/a',
      pnlLine,
      '',
      `🔗 Dex: ${pos.pairUrl}`,
      `🧾 Tx: https://solscan.io/tx/${res.signature}`,
    ].join('\n');

    await tgSend(cfg, msg);

    if (pnlPct != null && pnlPct >= 0.05) {
      const runner = `🏁🏁🏁 *WE GOT A RUNNER!* 🏁🏁🏁\n${symbol} closed at ${(pnlPct * 100).toFixed(2)}%` + (pnlUsdApprox == null ? '' : ` (≈ ${fmtUsd(pnlUsdApprox)})`);
      await tgSend(cfg, runner);
    }

    appendTradingLog(cfg.TRADING_LOG_PATH,
      `\n## EXIT ${symbol} (${mint})\n- time: ${nowIso()}\n- reason: ${reason}\n- exitPriceUsd: ${exitPriceUsd}\n- exitPriceSource: ${pos.exitPriceSource || 'snapshot'}\n- exitFeeLamports: ${exitFeeLamports}\n- pnlPct: ${pnlPct}\n- pnlUsdApprox: ${pnlUsdApprox}\n- pnlUsdNetApprox: ${pnlUsdNetApprox}\n- tx: ${res.signature}\n`);

    state.exposure ||= { activeRunnerCount: 0, queue: [], pausedUntilMs: 0 };
    state.exposure.activeRunnerCount = Math.max(0, Number(state.exposure.activeRunnerCount || 0) - 1);
    if (pnlPct != null && pnlPct >= 0.8) {
      const pauseMs = Number(cfg.POST_WIN_PAUSE_MS || 180000);
      state.exposure.pausedUntilMs = Date.now() + pauseMs;
      pushDebug(state, { t: nowIso(), mint, symbol, reason: `POST_WIN_PAUSE set until ${new Date(state.exposure.pausedUntilMs).toISOString()}` });
    }
    try { await processExposureQueue(cfg, conn, wallet, state); } catch (e) { console.warn('[exposure] processQueue failed', e?.message || e); }
    saveState(cfg.STATE_PATH, state);
  }

  async function updateStops(cfg, state, mint, priceUsd) {
    const pos = state.positions[mint];
    if (!pos || pos.status !== 'open') return { changed: false };

    pos.lastSeenPriceUsd = priceUsd;
    pos.trailingAnchor = pos.trailingAnchor ?? pos.peakPriceUsd ?? pos.entryPriceUsd;
    pos.activeTrailPct = pos.activeTrailPct ?? null;
    pos.lastStopPrice = pos.lastStopPrice ?? pos.stopPriceUsd ?? null;
    pos.lastPeakPrice = pos.lastPeakPrice ?? pos.peakPriceUsd ?? pos.entryPriceUsd;

    if (priceUsd > (pos.lastPeakPrice || 0)) {
      pos.lastPeakPrice = priceUsd;
      pos.lastPeakAtMs = Date.now();
    }

    const entry = Number(pos.entryPriceUsd);
    const profitPct = (priceUsd - entry) / entry;
    const trailActivatePct = Number.isFinite(Number(pos.trailActivatePct))
      ? Number(pos.trailActivatePct)
      : Number(cfg.LIVE_MOMO_TRAIL_ACTIVATE_PCT || 0.10);

    let changed = false;
    const desiredTrailPct = computeTrailPct(profitPct);

    if (desiredTrailPct == null || profitPct < trailActivatePct) {
      if (pos.trailingActive || Number.isFinite(Number(pos.activeTrailPct))) {
        return { changed, stopPriceUsd: pos.stopPriceUsd };
      }

      const nowMs = Date.now();
      const entryAtMs = Date.parse(String(pos.entryAt || '')) || nowMs;
      const stopPrice = computePreTrailStopPrice({
        entryPriceUsd: entry,
        entryAtMs,
        nowMs,
        armDelayMs: cfg.LIVE_STOP_ARM_DELAY_MS,
        prearmCatastrophicStopPct: cfg.LIVE_PREARM_CATASTROPHIC_STOP_PCT,
        stopAtEntryBufferPct: cfg.LIVE_MOMO_STOP_AT_ENTRY_BUFFER_PCT,
      });

      if (!Number.isFinite(Number(pos.stopPriceUsd)) || pos.stopPriceUsd < stopPrice) {
        pos.stopPriceUsd = stopPrice;
        pos.lastStopUpdateAt = nowIso();
        pos.trailingActive = false;
        pos.activeTrailPct = null;
        pos.trailingAnchor = pos.trailingAnchor ?? pos.lastPeakPrice;
        pos.lastStopPrice = pos.stopPriceUsd;
        changed = true;
      }
      return { changed, stopPriceUsd: pos.stopPriceUsd };
    }

    const newAnchor = updateTrailingAnchor(pos.lastPeakPrice, pos.trailingAnchor);
    if (newAnchor !== pos.trailingAnchor) {
      pos.trailingAnchor = newAnchor;
    }

    const slippageBps = Number(pos.slippageBps ?? cfg.DEFAULT_SLIPPAGE_BPS ?? 0);
    const slippagePct = slippageBps / 10_000;
    const candidateStop = computeStopFromAnchor(pos.trailingAnchor, desiredTrailPct, slippagePct);

    if (!Number.isFinite(Number(pos.stopPriceUsd)) || candidateStop > pos.stopPriceUsd) {
      pos.stopPriceUsd = candidateStop;
      pos.lastStopUpdateAt = nowIso();
      pos.trailingActive = true;
      pos.activeTrailPct = desiredTrailPct;
      pos.lastStopPrice = pos.stopPriceUsd;
      changed = true;
    }

    return { changed, stopPriceUsd: pos.stopPriceUsd };
  }

  return {
    closePosition,
    updateStops,
  };
}

export default createExitEngine;
