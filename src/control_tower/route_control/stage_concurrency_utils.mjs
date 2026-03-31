export async function mapWithConcurrency(items, concurrency, worker) {
  const arr = Array.isArray(items) ? items : [];
  const maxWorkers = Math.max(1, Math.min(arr.length || 1, Number(concurrency || 1)));
  let idx = 0;
  const workers = Array.from({ length: maxWorkers }, async () => {
    while (idx < arr.length) {
      const current = idx;
      idx += 1;
      await worker(arr[current], current);
    }
  });
  await Promise.all(workers);
}

export function jitter(ms, pct = 0.25) {
  const delta = ms * pct;
  return Math.max(0, Math.round(ms + ((Math.random() * 2 - 1) * delta)));
}
