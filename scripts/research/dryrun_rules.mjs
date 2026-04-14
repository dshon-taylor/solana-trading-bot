import dotenv from 'dotenv';
import { getConfig } from '../../src/config.mjs';
import { paperOnSample } from '../../src/analytics/paper_momentum.mjs';

dotenv.config();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// This script runs a tiny synthetic series through paper momentum
// to sanity-check stop-at-entry + trailing configuration.
const cfg = getConfig();
const state = {};

const mint = 'DRYRUN_MINT';
const symbol = 'DRY';
const startMs = Date.now() - 20 * 60_000;

// Make entry easy for dry-run (doesn't affect bot; just this script)
cfg.PAPER_ENABLED = true;
cfg.PAPER_ENTRY_RET_15M_PCT = -1;
cfg.PAPER_ENTRY_RET_5M_PCT = -1;
cfg.PAPER_ENTRY_GREEN_LAST5 = 0;

// Feed flat prices to trigger entry quickly
for (let i = 0; i < 6; i++) {
  const tMs = startMs + i * 60_000;
  paperOnSample({
    cfg,
    state,
    mint,
    symbol,
    entryAnchorPrice: 1.0,
    tIso: new Date(tMs).toISOString(),
    tMs,
    priceUsd: 1.0,
  });
}

const pos = state.paper?.positions?.[mint];
assert(pos && pos.status === 'open', 'Expected an open paper position after dry-run entry');

const expectedStop = 1.0 * (1 - cfg.PAPER_STOP_AT_ENTRY_BUFFER_PCT);
assert(Math.abs(pos.stopPx - expectedStop) < 1e-9, `stopPx mismatch: got ${pos.stopPx} expected ${expectedStop}`);

console.log('[dryrun] ok: entry + stop-at-entry configured', {
  stopAtEntryBufferPct: cfg.PAPER_STOP_AT_ENTRY_BUFFER_PCT,
  stopPx: pos.stopPx,
});
