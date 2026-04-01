// Shared fetch helpers with rate-limit aware retry.
// Goal: avoid tight-looping on 429s (Jupiter/RPC/etc) and provide consistent errors.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms, pct = 0.2) {
  const delta = ms * pct;
  const j = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(ms + j));
}

function parseRetryAfterMs(res) {
  const ra = res?.headers?.get?.('retry-after');
  if (!ra) return 0;
  const sec = Number(ra);
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  const dt = Date.parse(ra);
  if (Number.isFinite(dt)) return Math.max(0, dt - Date.now());
  return 0;
}

export async function fetchJsonWithRetry(url, {
  method = 'GET',
  headers = undefined,
  body = undefined,
  retries = 3,
  baseDelayMs = 600,
  maxDelayMs = 10_000,
  tag = 'HTTP',
} = {}) {
  let lastErr;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { method, headers, body });
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res);
        const waitMs = Math.min(maxDelayMs, Math.max(baseDelayMs, retryAfterMs || baseDelayMs * (i + 1) * 2));
        const e = new Error(`${tag}_429`);
        e.code = `${tag}_429`;
        e.status = 429;
        e.retryAfterMs = retryAfterMs;
        e.waitMs = waitMs;
        throw e;
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const e = new Error(`${tag} failed: ${res.status} ${t.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i === retries) break;

      const is429 = String(e?.message || '').includes('429') || e?.status === 429 || e?.code === `${tag}_429`;
      const suggested = Number(e?.waitMs || 0);
      const backoff = Math.min(maxDelayMs, baseDelayMs * (i + 1) * (is429 ? 3 : 1));
      const waitMs = Math.max(0, suggested || backoff);
      await sleep(jitter(waitMs, 0.25));
    }
  }

  throw lastErr;
}
