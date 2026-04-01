import { describe, it, expect } from 'vitest';

import { resolveEntryAndStopForOpenPosition } from '../src/trading/entry_guard.mjs';

describe('entry_guard', () => {
  it('blocks when entry price is missing and no Birdseye fallback', async () => {
    const res = await resolveEntryAndStopForOpenPosition({
      mint: 'So11111111111111111111111111111111111111112',
      pair: { baseToken: { address: 'So11111111111111111111111111111111111111112', decimals: 9 }, priceUsd: null },
      snapshot: null,
      decimalsHint: 9,
      birdeyeEnabled: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missingEntryPriceUsd');
  });

  it('hydrates entry price from Birdseye when snapshot/pair missing price', async () => {
    const getBirdseyeSnapshot = async () => ({ priceUsd: 1.23, atMs: Date.now() });
    const res = await resolveEntryAndStopForOpenPosition({
      mint: 'mint1',
      pair: { baseToken: { address: 'mint1' }, priceUsd: 0 },
      snapshot: { priceUsd: 0 },
      decimalsHint: 6,
      birdeyeEnabled: true,
      getBirdseyeSnapshot,
      birdeyeFetchTimeoutMs: 250,
    });
    expect(res.ok).toBe(true);
    expect(res.entryPriceUsd).toBeCloseTo(1.23);
    expect(res.stopPriceUsd).toBeGreaterThan(0);
  });

  it('hydrates decimals from RPC token supply when decimals hint missing', async () => {
    const getTokenSupply = async () => ({ value: { uiAmount: 1, decimals: 8 } });
    const res = await resolveEntryAndStopForOpenPosition({
      mint: 'mint2',
      pair: { baseToken: { address: 'mint2' }, priceUsd: 2 },
      snapshot: { priceUsd: 2 },
      decimalsHint: null,
      rpcUrl: 'http://example.invalid',
      getTokenSupply,
      birdeyeEnabled: false,
      stopAtEntry: true,
      stopAtEntryBufferPct: 0.05,
    });
    expect(res.ok).toBe(true);
    expect(res.decimals).toBe(8);
  });

  it('blocks if decimals cannot be resolved from hint/pair/RPC', async () => {
    const res = await resolveEntryAndStopForOpenPosition({
      mint: 'mint3',
      pair: { baseToken: { address: 'mint3' }, priceUsd: 2 },
      snapshot: { priceUsd: 2 },
      decimalsHint: null,
      birdeyeEnabled: false,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missingDecimals');
  });
});
