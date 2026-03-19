import { describe, it, expect, beforeEach } from 'vitest';

// Mock watchlist prioritization logic to test optimization
function watchlistEntriesPrioritizedOriginal({ state, cfg, limit, nowMs }) {
  const wl = state.watchlist || {};
  const activeMints = new Set(Object.keys(wl.mints || {}));
  const queue = (wl.hotQueue || [])
    .filter(item => activeMints.has(item?.mint) && Number(item?.hotUntilMs || 0) > nowMs)
    .sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
  const picked = [];
  const seen = new Set();

  for (const item of queue) {
    if (picked.length >= limit) break;
    const mint = item?.mint;
    if (!mint || seen.has(mint)) continue;
    const row = wl.mints[mint];
    if (!row) continue;
    picked.push([mint, row, true]);
    seen.add(mint);
  }

  if (picked.length < limit) {
    const sorted = Object.entries(wl.mints).sort((a, b) => {
      const aT = Number(a?.[1]?.lastEvaluatedAtMs || 0);
      const bT = Number(b?.[1]?.lastEvaluatedAtMs || 0);
      return aT - bT;
    });
    for (const [mint, row] of sorted) {
      if (picked.length >= limit) break;
      if (seen.has(mint)) continue;
      picked.push([mint, row, false]);
      seen.add(mint);
    }
  }

  wl.hotQueue = queue
    .filter(item => {
      const mint = item?.mint;
      if (!mint || !activeMints.has(mint)) return false;
      if (seen.has(mint)) return false;
      return Number(item?.hotUntilMs || 0) > nowMs;
    })
    .slice(0, cfg.hotQueueMax || 100);

  return picked;
}

// Optimized version - single-pass filter and sort
function watchlistEntriesPrioritizedOptimized({ state, cfg, limit, nowMs }) {
  const wl = state.watchlist || {};
  const mints = wl.mints || {};
  const activeMints = new Set(Object.keys(mints));
  
  // Single-pass filter and collect valid hot queue items
  const validHotItems = [];
  const hotQueue = wl.hotQueue || [];
  
  for (let i = 0; i < hotQueue.length; i++) {
    const item = hotQueue[i];
    const mint = item?.mint;
    const hotUntil = Number(item?.hotUntilMs || 0);
    
    if (mint && activeMints.has(mint) && hotUntil > nowMs) {
      validHotItems.push({
        mint,
        priority: Number(item?.priority || 0),
        atMs: Number(item?.atMs || 0),
        hotUntilMs: hotUntil,
        item
      });
    }
  }
  
  // Sort once with extracted numbers
  validHotItems.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    return priorityDiff !== 0 ? priorityDiff : b.atMs - a.atMs;
  });
  
  // Pick from hot queue first
  const picked = [];
  const seen = new Set();
  
  for (let i = 0; i < validHotItems.length && picked.length < limit; i++) {
    const { mint } = validHotItems[i];
    if (seen.has(mint)) continue;
    
    const row = mints[mint];
    if (!row) continue;
    
    picked.push([mint, row, true]);
    seen.add(mint);
  }
  
  // Fill remaining with non-hot mints if needed
  if (picked.length < limit) {
    const mintsWithTime = [];
    
    for (const mint in mints) {
      if (seen.has(mint)) continue;
      const row = mints[mint];
      mintsWithTime.push({
        mint,
        row,
        time: Number(row?.lastEvaluatedAtMs || 0)
      });
    }
    
    // Sort by evaluation time (oldest first)
    mintsWithTime.sort((a, b) => a.time - b.time);
    
    for (let i = 0; i < mintsWithTime.length && picked.length < limit; i++) {
      const { mint, row } = mintsWithTime[i];
      picked.push([mint, row, false]);
      seen.add(mint);
    }
  }
  
  // Rebuild hotQueue efficiently - filter items not yet seen
  const maxHotQueue = cfg.hotQueueMax || 100;
  const newHotQueue = [];
  
  for (let i = 0; i < validHotItems.length && newHotQueue.length < maxHotQueue; i++) {
    const { mint, item } = validHotItems[i];
    if (!seen.has(mint)) {
      newHotQueue.push(item);
    }
  }
  
  wl.hotQueue = newHotQueue;
  
  return picked;
}

describe('watchlist prioritization optimization', () => {
  let state, cfg, nowMs;

  beforeEach(() => {
    nowMs = Date.now();
    state = {
      watchlist: {
        mints: {
          'mint1': { lastEvaluatedAtMs: nowMs - 5000 },
          'mint2': { lastEvaluatedAtMs: nowMs - 3000 },
          'mint3': { lastEvaluatedAtMs: nowMs - 7000 },
          'mint4': { lastEvaluatedAtMs: nowMs - 1000 },
          'mint5': { lastEvaluatedAtMs: nowMs - 10000 },
        },
        hotQueue: [
          { mint: 'mint1', priority: 10, atMs: nowMs - 100, hotUntilMs: nowMs + 60000 },
          { mint: 'mint2', priority: 20, atMs: nowMs - 200, hotUntilMs: nowMs + 60000 },
          { mint: 'mint6', priority: 15, atMs: nowMs - 150, hotUntilMs: nowMs + 60000 }, // Not in mints
          { mint: 'mint3', priority: 5, atMs: nowMs - 300, hotUntilMs: nowMs - 1000 }, // Expired
        ]
      }
    };
    cfg = { hotQueueMax: 100 };
  });

  it('both implementations return same results', () => {
    // Clone state to avoid mutation between implementations
    const stateForOriginal = JSON.parse(JSON.stringify(state));
    const stateForOptimized = JSON.parse(JSON.stringify(state));
    
    const original = watchlistEntriesPrioritizedOriginal({ state: stateForOriginal, cfg, limit: 3, nowMs });
    const optimized = watchlistEntriesPrioritizedOptimized({ state: stateForOptimized, cfg, limit: 3, nowMs });
    
    expect(optimized.length).toBe(original.length);
    
    for (let i = 0; i < original.length; i++) {
      expect(optimized[i][0]).toBe(original[i][0]); // mint
      expect(optimized[i][2]).toBe(original[i][2]); // isHot flag
    }
  });

  it('prioritizes by priority then atMs', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 10, nowMs });
    
    // First should be mint2 (priority 20)
    expect(optimized[0][0]).toBe('mint2');
    expect(optimized[0][2]).toBe(true); // isHot
    
    // Second should be mint1 (priority 10)
    expect(optimized[1][0]).toBe('mint1');
    expect(optimized[1][2]).toBe(true); // isHot
  });

  it('filters expired items', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 10, nowMs });
    
    // mint3 should not be hot (expired), should appear later as non-hot
    const mint3Entry = optimized.find(e => e[0] === 'mint3');
    expect(mint3Entry).toBeDefined();
    expect(mint3Entry[2]).toBe(false); // Not hot
  });

  it('filters items not in activeMints', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 10, nowMs });
    
    // mint6 not in mints, should not appear
    const mint6Entry = optimized.find(e => e[0] === 'mint6');
    expect(mint6Entry).toBeUndefined();
  });

  it('respects limit', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 2, nowMs });
    expect(optimized.length).toBe(2);
  });

  it('fills with non-hot mints when hot queue insufficient', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 5, nowMs });
    
    // Should have 2 hot (mint2, mint1) and 3 non-hot
    const hotCount = optimized.filter(e => e[2] === true).length;
    const nonHotCount = optimized.filter(e => e[2] === false).length;
    
    expect(hotCount).toBe(2);
    expect(nonHotCount).toBe(3);
  });

  it('non-hot mints sorted by oldest evaluation time', () => {
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 5, nowMs });
    
    // Non-hot mints should be ordered by lastEvaluatedAtMs (oldest first)
    const nonHot = optimized.filter(e => e[2] === false);
    
    // mint5 has oldest time (nowMs - 10000)
    expect(nonHot[0][0]).toBe('mint5');
    // mint3 next (nowMs - 7000)
    expect(nonHot[1][0]).toBe('mint3');
  });

  it('handles empty hotQueue', () => {
    state.watchlist.hotQueue = [];
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 3, nowMs });
    
    expect(optimized.length).toBe(3);
    // All should be non-hot
    expect(optimized.every(e => e[2] === false)).toBe(true);
  });

  it('handles empty mints', () => {
    state.watchlist.mints = {};
    const optimized = watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 3, nowMs });
    
    expect(optimized.length).toBe(0);
  });

  it('updates hotQueue correctly', () => {
    watchlistEntriesPrioritizedOptimized({ state, cfg, limit: 3, nowMs });
    
    // hotQueue should only have valid, unexpired, active items not yet seen
    const hotQueue = state.watchlist.hotQueue;
    
    // Should not include expired mint3
    expect(hotQueue.find(item => item.mint === 'mint3')).toBeUndefined();
    
    // Should not include invalid mint6
    expect(hotQueue.find(item => item.mint === 'mint6')).toBeUndefined();
  });
});
