import { test, expect } from 'vitest';
import HotQueue from '../src/lib/hotQueue.mjs';

test('enqueue and size', ()=>{
  const q = new HotQueue({ redisUrl: null });
  expect(q.size()).toBe(0);
  q.enqueue('MINT1', 10, {foo:1});
  expect(q.size()).toBe(1);
  q.enqueue('MINT2', 5);
  expect(q.size()).toBe(2);
  // lower score replace should not enqueue
  expect(q.enqueue('MINT2', 3)).toBe(false);
  expect(q.size()).toBe(2);
});

test('topN and pop', ()=>{
  const q = new HotQueue({ redisUrl: null });
  q.enqueue('A', 1);
  q.enqueue('B', 5);
  q.enqueue('C', 3);
  expect(q.dequeueTop(2)).toEqual(['B','C']);
  const popped = q.pop('B');
  expect(popped.mint).toBe('B');
  expect(q.size()).toBe(2);
});

test('ttl expiration within bounds', async ()=>{
  const q = new HotQueue({ redisUrl: null });
  q.hotTtlMs = 350; // set small TTL for test
  q.enqueue('X', 1);
  expect(q.size()).toBe(1);
  await new Promise(r=>setTimeout(r, 400));
  // lazy expire on size check
  expect(q.size()).toBe(0);
});

test('limitPerMin and TOP_N enforcement', ()=>{
  const q = new HotQueue({ redisUrl: null });
  q.limitPerMin = 3;
  q.topN = 2;
  // enqueue many
  for (let i=0;i<10;i++) q.enqueue('M'+i, 100-i);
  const promoted = q.promoteEligible();
  expect(promoted.length).toBeLessThanOrEqual(2);
  // simulate minute full
  q.sampleWindow.clear();
  q.limitPerMin = 1;
  const p2 = q.promoteEligible();
  expect(p2.length).toBeLessThanOrEqual(1);
});
