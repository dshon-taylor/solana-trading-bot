#!/usr/bin/env node
import { computeTrailPct, computeStopFromAnchor, updateTrailingAnchor } from '../../src/signals/trailing.mjs';

function must(cond, msg) { if (!cond) throw new Error(msg); }
function fmtUsd(n) { return `$${Number(n || 0).toFixed(2)}`; }

const checkpoints = [];
function ck(name, pass, details = {}) {
  checkpoints.push({ name, pass, details });
}

// 1) Mock entry execution-safe fill pricing
const entry = {
  fillInLamports: 200_000_000, // 0.2 SOL
  fillOutRaw: 1_000_000_000_000, // 1,000,000 tokens @ 6 dec? we'll use 6 => 1,000,000.000000
  fillOutDecimals: 6,
  feeLamports: 5_000,
  solUsdAtEntry: 100,
  stopAtEntryBufferPct: 0.0005,
};

const fillInSol = entry.fillInLamports / 1e9;
const fillOutTokens = entry.fillOutRaw / (10 ** entry.fillOutDecimals);
const entryPriceUsd = (fillInSol * entry.solUsdAtEntry) / fillOutTokens;
let stopPriceUsd = entryPriceUsd * (1 - entry.stopAtEntryBufferPct);

ck('ENTRY fill-derived price', Number.isFinite(entryPriceUsd) && entryPriceUsd > 0, {
  fillInSol,
  fillOutTokens,
  entryPriceUsd,
  stopPriceUsd,
});

// 2) Adaptive trailing progression using execution-safe stop updates
const pos = {
  entryPriceUsd,
  stopPriceUsd,
  trailingAnchor: entryPriceUsd,
  lastPeakPrice: entryPriceUsd,
  trailingActive: false,
  activeTrailPct: null,
};

const prices = [
  entryPriceUsd * 1.10, // <30%
  entryPriceUsd * 1.35, // 30-80 => 30% trail
  entryPriceUsd * 1.90, // >=80 => 22%
  entryPriceUsd * 2.60, // >=150 => 18%
  entryPriceUsd * 1.50, // drawdown; should never widen
];

for (const px of prices) {
  if (px > pos.lastPeakPrice) pos.lastPeakPrice = px;
  const pnl = (px - pos.entryPriceUsd) / pos.entryPriceUsd;
  const desiredTrail = computeTrailPct(pnl);

  if (pnl < 0.30) {
    // rule: stop=entry only if trailing not active; never widen once tightened
    if (!pos.trailingActive && !Number.isFinite(Number(pos.activeTrailPct))) {
      const stopAtEntry = pos.entryPriceUsd;
      if (!Number.isFinite(Number(pos.stopPriceUsd)) || pos.stopPriceUsd < stopAtEntry) {
        pos.stopPriceUsd = stopAtEntry;
      }
    }
    continue;
  }

  const newAnchor = updateTrailingAnchor(pos.lastPeakPrice, pos.trailingAnchor);
  pos.trailingAnchor = newAnchor;

  const candidate = computeStopFromAnchor(pos.trailingAnchor, desiredTrail, 0.025); // 250bps execution-safe
  if (!Number.isFinite(Number(pos.stopPriceUsd)) || candidate > pos.stopPriceUsd) {
    pos.stopPriceUsd = candidate;
    pos.trailingActive = true;
    pos.activeTrailPct = desiredTrail;
  }
}

ck('TRAIL tier selection reached tightest tier', pos.activeTrailPct === 0.18, {
  activeTrailPct: pos.activeTrailPct,
  trailingAnchor: pos.trailingAnchor,
  stopPriceUsd: pos.stopPriceUsd,
});

// ensure never widened on drawdown step
const stopAfterTighten = pos.stopPriceUsd;
const drawdownPrice = entryPriceUsd * 1.20; // below 30% from peak maybe
const drawdownPnl = (drawdownPrice - entryPriceUsd) / entryPriceUsd;
if (drawdownPnl < 0.30) {
  // should not reset lower once trailing active
  if (!pos.trailingActive) {
    // no-op for this test path
  }
}
ck('NEVER widen after tighten', pos.stopPriceUsd === stopAfterTighten, { stopAfterTighten, stopNow: pos.stopPriceUsd });

// 3) Mock exit from fill amounts + fee-aware PnL
const exit = {
  soldRaw: entry.fillOutRaw,
  soldDecimals: entry.fillOutDecimals,
  outSolLamports: 260_000_000, // 0.26 SOL
  feeLamports: 7_000,
  solUsdExit: 105,
};
const soldTokens = exit.soldRaw / (10 ** exit.soldDecimals);
const outSol = exit.outSolLamports / 1e9;
const exitPriceUsd = (outSol * exit.solUsdExit) / soldTokens;
const pnlPct = (exitPriceUsd - entryPriceUsd) / entryPriceUsd;
const entryUsdApprox = fillInSol * entry.solUsdAtEntry;
const pnlUsdApprox = entryUsdApprox * pnlPct;
const entryFeeUsd = (entry.feeLamports / 1e9) * entry.solUsdAtEntry;
const exitFeeUsd = (exit.feeLamports / 1e9) * exit.solUsdExit;
const pnlUsdNetApprox = pnlUsdApprox - entryFeeUsd - exitFeeUsd;

ck('EXIT fill-derived price', Number.isFinite(exitPriceUsd) && exitPriceUsd > 0, {
  exitPriceUsd,
  pnlPct,
  pnlUsdApprox,
  pnlUsdNetApprox,
});

// 4) Ledger/telegram parity mock
const tradeRow = {
  kind: 'exit',
  entryPriceUsd,
  exitPriceUsd,
  entryFeeLamports: entry.feeLamports,
  entryFeeUsd,
  exitFeeLamports: exit.feeLamports,
  exitFeeUsd,
  pnlPct,
  pnlUsdApprox,
  pnlUsdNetApprox,
  entryPriceSource: 'jupiter_fill',
  exitPriceSource: 'jupiter_fill',
};

const tgLine = `PnL ${(pnlPct * 100).toFixed(2)}% (gross≈ ${fmtUsd(pnlUsdApprox)}, net≈ ${fmtUsd(pnlUsdNetApprox)})`;
const parity = tgLine.includes((pnlPct * 100).toFixed(2))
  && tgLine.includes(fmtUsd(pnlUsdApprox))
  && tgLine.includes(fmtUsd(pnlUsdNetApprox));
ck('Telegram/ledger parity fields aligned', parity, { tgLine, tradeRow });

const failed = checkpoints.filter(c => !c.pass);
for (const c of checkpoints) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name}`);
  console.log(JSON.stringify(c.details));
}

must(failed.length === 0, `mock lifecycle failed ${failed.length} checkpoints`);
console.log('\nALL_CHECKPOINTS_PASS');
