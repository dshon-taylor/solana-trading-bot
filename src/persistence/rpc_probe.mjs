import fetch from 'node-fetch';

function nowMs() { return Date.now(); }

export function startRpcProbe({ cfg, intervalMs = 30_000 }) {
  const raw = String(cfg.SOLANA_RPC_URL || '').split(',').map(s=>s.trim()).filter(Boolean);
  const urls = raw.length ? raw : [];
  const state = {
    urls: urls.map(u=>({ url: u, lastOk: false, lastLatencyMs: null, lastCheckedAt: null, failures: 0 })),
    best: null,
  };

  async function probeOne(u) {
    const start = nowMs();
    try {
      const res = await fetch(u, { method: 'POST', body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getHealth', params:[] }), headers: { 'content-type':'application/json' }, timeout: 10000 });
      const latency = nowMs() - start;
      state.urls.find(x=>x.url===u).lastCheckedAt = nowMs();
      if (!res.ok) {
        state.urls.find(x=>x.url===u).lastOk = false;
        state.urls.find(x=>x.url===u).failures++;
        state.urls.find(x=>x.url===u).lastLatencyMs = null;
        return;
      }
      // treat HTTP OK as success; it's fine if body not expected
      state.urls.find(x=>x.url===u).lastOk = true;
      state.urls.find(x=>x.url===u).lastLatencyMs = latency;
      state.urls.find(x=>x.url===u).failures = 0;
    } catch (e) {
      const rec = state.urls.find(x=>x.url===u);
      if (rec) {
        rec.lastOk = false;
        rec.lastLatencyMs = null;
        rec.failures = (rec.failures || 0) + 1;
        rec.lastCheckedAt = nowMs();
      }
    }
  }

  async function probeAll() {
    await Promise.all(state.urls.map(u=>probeOne(u.url)));
    // pick best by ok then latency
    const oks = state.urls.filter(x=>x.lastOk).sort((a,b)=> (a.lastLatencyMs||Infinity) - (b.lastLatencyMs||Infinity));
    state.best = oks.length ? oks[0] : (state.urls.length ? state.urls[0] : null);
  }

  // initial probe
  probeAll().catch(()=>{});
  const id = setInterval(()=>{ probeAll().catch(()=>{}); }, intervalMs);

  return {
    stop: () => clearInterval(id),
    summary: () => {
      return {
        best: state.best ? { url: state.best.url, ok: state.best.lastOk, latencyMs: state.best.lastLatencyMs } : null,
        all: state.urls.map(u=>({ url: u.url, ok: u.lastOk, latencyMs: u.lastLatencyMs, failures: u.failures }))
      };
    }
  };
}
