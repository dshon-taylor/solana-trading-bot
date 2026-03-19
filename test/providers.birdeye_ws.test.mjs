import birdeye from '../src/providers/birdeye_ws.mjs';
import { describe, it, expect, afterAll } from 'vitest';

describe('birdeye_ws manager', ()=>{
  it('connects and reports status', async ()=>{
    await birdeye.connect();
    const s = birdeye.getStatus();
    expect(s.status).toBe('OPEN');
    expect(s.connections).toBeGreaterThanOrEqual(1);
  });

  it('subscribe/unsubscribe works', async ()=>{
    await birdeye.subscribe('mintA');
    let s = birdeye.getStatus();
    expect(s.subscribedCount).toBeGreaterThanOrEqual(1);
    await birdeye.unsubscribe('mintA');
    s = birdeye.getStatus();
    expect(s.subscribedCount).toBe(0);
  });

  afterAll(async ()=>{
    await birdeye.disconnect();
  });
});
