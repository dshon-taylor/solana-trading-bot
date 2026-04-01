import { describe, it, expect } from 'vitest';
import hotQueue from '../../src/signals/hotQueue.mjs';

describe('services/hotQueue', () => {
  it('promote and demote', ()=>{
    const mint = 'HOT1';
    const ok = hotQueue.promoteToHot(mint, { metrics: { tx_30s: 10 }, reasons: ['tx'] });
    expect(ok).toBe(true);
    const list = hotQueue.getHotList();
    expect(list.includes(mint)).toBe(true);
    hotQueue.demote(mint);
    const list2 = hotQueue.getHotList();
    expect(list2.includes(mint)).toBe(false);
  });
});
