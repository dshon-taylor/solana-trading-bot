import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePreMomentum} from '../../src/stages/preMomentum.mjs';
import hotQueue from '../../src/services/hotQueue.mjs';

test('tx burst promotes to HOT', ()=>{
  const mint='MINT1';
  const metrics = {tx_30s: 20, tx_5m_avg: 5};
  const res = evaluatePreMomentum(mint, metrics);
  assert(res.promote===true);
});

test('micro buys promotes', ()=>{
  const mint='M2';
  const metrics = {buys_in_window:3};
  const res = evaluatePreMomentum(mint, metrics);
  assert(res.promote===true);
});

test('impact spike promotes', ()=>{
  const mint='M3';
  const metrics = {impact_now:5, impact_avg:1};
  const res = evaluatePreMomentum(mint, metrics);
  assert(res.promote===true);
});

