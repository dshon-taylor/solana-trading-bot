import { describe, it, expect } from 'vitest';
import {evaluatePreMomentum} from '../../src/signals/preMomentum.mjs';

describe('stages/preMomentum', () => {
  it('tx burst promotes to HOT', ()=>{
    const mint='MINT1';
    const metrics = {tx_30s: 20, tx_5m_avg: 5};
    const res = evaluatePreMomentum(mint, metrics);
    expect(res.promote).toBe(true);
  });

  it('micro buys promotes', ()=>{
    const mint='M2';
    const metrics = {buys_in_window:3};
    const res = evaluatePreMomentum(mint, metrics);
    expect(res.promote).toBe(true);
  });

  it('impact spike promotes', ()=>{
    const mint='M3';
    const metrics = {impact_now:5, impact_avg:1};
    const res = evaluatePreMomentum(mint, metrics);
    expect(res.promote).toBe(true);
  });
});

