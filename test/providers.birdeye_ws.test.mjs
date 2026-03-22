import birdeye from '../src/providers/birdeye_ws.mjs';
import cache from '../src/global_cache.mjs';
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

  afterAll(async ()=>{
    birdeye.stop();
  });
});
