import birdeye from '../src/providers/birdeye/ws_client.mjs';
import cache from '../src/lib/cache/global_cache.mjs';
import { describe, it, expect, afterAll } from 'vitest';

describe('birdeye_ws manager', ()=>{
  it('reports status shape', async ()=>{
    birdeye.start();
    const s = birdeye.getStatus();
    expect(['OPEN', 'CONNECTING', 'CLOSED']).toContain(s.status);
    expect(typeof s.enabled).toBe('boolean');
    expect(typeof s.subscribedCount).toBe('number');
    expect(typeof s.desiredCount).toBe('number');
  });

  it('syncs desired subscriptions from cache keys', async ()=>{
    cache.set('birdeye:sub:mintA', true, 60);
    birdeye._syncSubscriptions();
    let s = birdeye.getStatus();
    expect(s.subscribedCount).toBeGreaterThanOrEqual(1);

    cache.del('birdeye:sub:mintA');
    birdeye._syncSubscriptions();
    s = birdeye.getStatus();
    expect(s.subscribedCount).toBe(0);
  });

  it('derives tx priceUsd from TXS_DATA and stores tx trace entry', async ()=>{
    const mint = 'MintTxA';
    const nowSec = Math.floor(Date.now() / 1000);
    const msg = {
      type: 'TXS_DATA',
      data: {
        tokenAddress: mint,
        blockUnixTime: nowSec,
        side: 'buy',
        txHash: 'abc123',
        volumeUSD: 42.5,
        tokenPrice: 0.0123,
        pricePair: 0.0119,
      },
    };

    birdeye._onMessage(JSON.stringify(msg));
    const arr = cache.get(`birdeye:ws:tx:${mint}`) || [];
    expect(arr.length).toBeGreaterThan(0);
    const last = arr[arr.length - 1];
    expect(last.side).toBe('buy');
    expect(last.txHash).toBe('abc123');
    expect(last.volumeUSD).toBe(42.5);
    expect(last.t).toBe(nowSec * 1000);
    expect(last.priceUsd).toBe(0.0123);
  });

  afterAll(async ()=>{
    birdeye.stop();
  });
});
