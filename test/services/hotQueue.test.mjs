import test from 'node:test';
import assert from 'node:assert/strict';
import hotQueue from '../../src/services/hotQueue.mjs';

test('promote and demote', ()=>{
  const mint='HOT1';
  const ok = hotQueue.promoteToHot(mint,{metrics:{tx_30s:10},reasons:['tx']});
  assert(ok===true);
  const list = hotQueue.getHotList();
  assert(list.includes(mint));
  hotQueue.demote(mint);
  const list2 = hotQueue.getHotList();
  assert(!list2.includes(mint));
});
