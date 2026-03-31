import { ensureWatchlistState } from './stage_watchlist_state_cache.mjs';

export function watchlistHotQueueMax(cfg) {
  return Math.max(8, Number(cfg.WATCHLIST_HOT_QUEUE_MAX || 16));
}

export function readPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? (n * 100) : n;
}

export function getRowHotScore(row) {
  const s = row?.snapshot || {};
  const latest = row?.latest || {};
  const tx30s = Number(s?.txns?.s30?.buys || 0) + Number(s?.txns?.s30?.sells || 0);
  const tx5m = Number(s?.txns?.m5?.buys || 0) + Number(s?.txns?.m5?.sells || 0);
  const tx5mAvg = tx5m > 0 ? (tx5m / 10) : 0;
  const txAccel = tx30s > 0 && tx5mAvg > 0 ? (tx30s / Math.max(1, tx5mAvg)) : 0;
  const ret1 = Number.isFinite(Number(s?.priceChange?.m1))
    ? Number(s?.priceChange?.m1)
    : (Number(latest?.pc1h || 0) / 60);
  const piNow = Number(latest?.priceImpactPct ?? s?.entryHints?.priceImpactPct ?? 0);
  const piBase = Number(row?.meta?.priceImpactBase || piNow || 0);
  const impactExpansion = piNow > 0 && piBase > 0 ? (piNow / Math.max(0.0001, piBase)) : 0;
  const liq = Number(latest?.liqUsd || 0);

  return (txAccel * 4) + (ret1 * 1.5) + (impactExpansion * 2) + (Math.log10(Math.max(1, liq)) * 1.2);
}

export function queueHotWatchlistMint({ state, cfg, mint, nowMs, priority = 1, reason = 'unspecified', counters = null }) {
  const wl = ensureWatchlistState(state);
  const queue = Array.isArray(wl.hotQueue) ? wl.hotQueue : [];
  const existingIdx = queue.findIndex(x => x?.mint === mint);
  const hotUntilMs = nowMs + Number(cfg.HOT_TTL_MS || 600_000);
  const next = { mint, atMs: nowMs, priority: Number(priority || 1), hotUntilMs, reason };
  if (existingIdx >= 0) {
    const prev = queue[existingIdx] || {};
    queue.splice(existingIdx, 1);
    next.priority = Math.max(Number(prev.priority || 0), next.priority);
    next.hotUntilMs = Math.max(Number(prev.hotUntilMs || 0), next.hotUntilMs);
  }
  queue.push(next);
  queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
  const max = watchlistHotQueueMax(cfg);
  if (queue.length > max) {
    const candidateRow = wl.mints?.[mint] || null;
    const candidateScore = getRowHotScore(candidateRow);
    let lowestIdx = -1;
    let lowestScore = Infinity;
    for (let i = 0; i < queue.length; i += 1) {
      const qMint = String(queue[i]?.mint || '');
      const row = wl.mints?.[qMint] || null;
      const score = getRowHotScore(row);
      if (score < lowestScore) {
        lowestScore = score;
        lowestIdx = i;
      }
    }
    const margin = 0.5;
    if (candidateScore > (lowestScore + margin)) {
      if (lowestIdx >= 0) {
        queue.splice(lowestIdx, 1);
        counters && (counters.watchlist.capEvictions = Number(counters.watchlist.capEvictions || 0) + 1);
      }
    } else {
      const idxCandidate = queue.findIndex(x => x?.mint === mint);
      if (idxCandidate >= 0) queue.splice(idxCandidate, 1);
      counters && (counters.watchlist.rejectedDueToCap = Number(counters.watchlist.rejectedDueToCap || 0) + 1);
    }
    queue.sort((a, b) => (Number(b?.priority || 0) - Number(a?.priority || 0)) || (Number(b?.atMs || 0) - Number(a?.atMs || 0)));
    if (queue.length > max) queue.length = max;
  }
  wl.hotQueue = queue;
  if (counters?.watchlist) {
    counters.watchlist.hotQueueSizeSamples ||= [];
    counters.watchlist.hotQueueSizeSamples.push({ tMs: nowMs, size: Number(queue.length || 0), cap: Number(max || 0) });
    if (counters.watchlist.hotQueueSizeSamples.length > 200) counters.watchlist.hotQueueSizeSamples = counters.watchlist.hotQueueSizeSamples.slice(-200);
  }
}

export function watchlistEntriesSorted(state) {
  const wl = ensureWatchlistState(state);
  return Object.entries(wl.mints).sort((a, b) => {
    const aT = Number(a?.[1]?.lastEvaluatedAtMs || 0);
    const bT = Number(b?.[1]?.lastEvaluatedAtMs || 0);
    return aT - bT;
  });
}

export function watchlistEntriesPrioritized({ state, cfg, limit, nowMs }) {
  const wl = ensureWatchlistState(state);
  const mints = wl.mints || {};
  const activeMints = new Set(Object.keys(mints));

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
        item,
      });
    }
  }

  validHotItems.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    return priorityDiff !== 0 ? priorityDiff : b.atMs - a.atMs;
  });

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

  if (picked.length < limit) {
    const mintsWithTime = [];

    for (const mint in mints) {
      if (seen.has(mint)) continue;
      const row = mints[mint];
      mintsWithTime.push({
        mint,
        row,
        time: Number(row?.lastEvaluatedAtMs || 0),
      });
    }

    mintsWithTime.sort((a, b) => a.time - b.time);

    for (let i = 0; i < mintsWithTime.length && picked.length < limit; i++) {
      const { mint, row } = mintsWithTime[i];
      picked.push([mint, row, false]);
      seen.add(mint);
    }
  }

  const maxHotQueue = watchlistHotQueueMax(cfg);
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
