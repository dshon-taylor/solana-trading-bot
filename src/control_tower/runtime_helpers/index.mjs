import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PublicKey } from '@solana/web3.js';

const execFileAsync = promisify(execFile);

const CT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
  hour12: true,
});

export function fmtCt(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return `${CT_FORMATTER.format(new Date(n)).replace(',', '')} CT`;
}

export function createGlobalTimers() {
  return {
    birdeyeWsPoll: null,
    scanLoop: null,
    positionsLoop: null,
    heartbeatLoop: null,
    telegramPoll: null,
    watchlistCleanup: null,
    memoryMonitor: null,
    memoryDebug: null,
  };
}

export function clearAllTimers(globalTimers) {
  for (const [name, timer] of Object.entries(globalTimers || {})) {
    if (timer) {
      clearInterval(timer);
      globalTimers[name] = null;
    }
  }
}

function readLastSolUsdFallback() {
  try {
    const p = path.resolve(process.cwd(), 'state/last_sol_price.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw || '{}');
    const v = Number(j?.solUsd ?? j?.priceUsd ?? 0);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeLastSolUsdFallback(solUsd) {
  try {
    const v = Number(solUsd || 0);
    if (!(Number.isFinite(v) && v > 0)) return;
    const p = path.resolve(process.cwd(), 'state/last_sol_price.json');
    fs.writeFileSync(p, JSON.stringify({ solUsd: v, at: Date.now() }));
  } catch {}
}

export function createSolUsdPriceResolver({ getTokenPairs, pickBestPair }) {
  return async function getSolUsdPrice() {
    try {
      const pairs = await getTokenPairs('So11111111111111111111111111111111111111112');
      const best = pickBestPair(pairs);
      const solUsd = Number(best?.priceUsd || 0);
      if (Number.isFinite(solUsd) && solUsd > 0) {
        writeLastSolUsdFallback(solUsd);
        return { solUsd };
      }
    } catch {}
    return { solUsd: readLastSolUsdFallback() };
  };
}

export function startHealthServer({ stateRef, getSnapshot }) {
  const port = Number(process.env.HEALTH_PORT || 0);
  if (!Number.isFinite(port) || port <= 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const snapshot = (typeof getSnapshot === 'function') ? getSnapshot() : {};
    const payload = {
      ok: true,
      nowMs: Date.now(),
      ...snapshot,
      positions: Object.keys(stateRef?.positions || {}).length,
    };

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });

  server.listen(port, '0.0.0.0');
  return server;
}

export async function runNodeScriptJson(scriptPath, args, { timeoutMs = 90_000, safeErr } = {}) {
  const maxBuffer = Math.max(512 * 1024, Number(process.env.RUN_SCRIPT_MAX_BUFFER_BYTES || (2 * 1024 * 1024)));
  const parseLimitBytes = Math.max(64 * 1024, Number(process.env.RUN_SCRIPT_PARSE_LIMIT_BYTES || (512 * 1024)));
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    timeout: timeoutMs,
    maxBuffer,
    env: process.env,
  });
  const stdoutText = String(stdout || '').trim();
  const outBytes = Buffer.byteLength(stdoutText, 'utf8');
  console.log('[runNodeScriptJson]', { script: scriptPath, stdoutBytes: outBytes, parseLimitBytes, maxBuffer });
  if (outBytes > parseLimitBytes) {
    throw new Error(`script stdout too large for JSON parse path (${outBytes} > ${parseLimitBytes})`);
  }

  const lines = stdoutText
    .split(/\r?\n/g)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1] : '';
  const looksLikeJson = lastLine.startsWith('{') || lastLine.startsWith('[');
  if (!looksLikeJson) {
    const preview = lastLine.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`script JSON parse failed: last non-empty stdout line is not JSON; preview="${preview}"`);
  }

  try {
    return JSON.parse(lastLine);
  } catch (e) {
    const preview = lastLine.slice(0, 240).replace(/\s+/g, ' ').trim();
    const errMsg = typeof safeErr === 'function' ? safeErr(e).message : (e?.message || String(e));
    throw new Error(`script JSON parse failed (${errMsg}); stdoutBytes=${outBytes}; lastLinePreview="${preview}"`);
  }
}

export async function resolveMintCreatedAtFromRpc({ state, conn, mint, nowMs, maxPages = 3 }) {
  if (!conn || !mint) return { createdAtMs: null, source: 'rpc.mintSignatures.missingInput' };
  state.runtime ||= {};
  state.runtime.mintCreatedAtCache ||= {};
  const map = state.runtime.mintCreatedAtCache;
  const cached = map[mint] || null;
  if (cached && Number(cached?.checkedAtMs || 0) > (nowMs - (60 * 60_000))) {
    return { createdAtMs: Number(cached?.createdAtMs || 0) || null, source: String(cached?.source || 'rpc.mintSignatures.cache') };
  }

  let before = null;
  let oldestBlockTimeSec = null;
  try {
    const pk = new PublicKey(mint);
    for (let i = 0; i < Math.max(1, Number(maxPages || 1)); i += 1) {
      const sigs = await conn.getSignaturesForAddress(pk, before ? { before, limit: 1000 } : { limit: 1000 });
      if (!Array.isArray(sigs) || !sigs.length) break;
      const withTime = sigs.filter((x) => Number.isFinite(Number(x?.blockTime)) && Number(x.blockTime) > 0);
      if (withTime.length) {
        const localOldest = withTime.reduce((min, x) => Math.min(min, Number(x.blockTime)), Number.POSITIVE_INFINITY);
        if (Number.isFinite(localOldest) && localOldest > 0) {
          oldestBlockTimeSec = oldestBlockTimeSec == null ? localOldest : Math.min(oldestBlockTimeSec, localOldest);
        }
      }
      before = sigs[sigs.length - 1]?.signature || null;
      if (!before || sigs.length < 1000) break;
    }
  } catch {
    map[mint] = { createdAtMs: null, checkedAtMs: nowMs, source: 'rpc.mintSignatures.error' };
    return { createdAtMs: null, source: 'rpc.mintSignatures.error' };
  }

  const createdAtMs = oldestBlockTimeSec ? (Math.round(oldestBlockTimeSec * 1000)) : null;
  map[mint] = { createdAtMs: createdAtMs || null, checkedAtMs: nowMs, source: createdAtMs ? 'rpc.mintSignatures.blockTime' : 'rpc.mintSignatures.missingBlockTime' };
  return { createdAtMs: createdAtMs || null, source: createdAtMs ? 'rpc.mintSignatures.blockTime' : 'rpc.mintSignatures.missingBlockTime' };
}

export async function computeMcapUsd(cfg, pair, rpcUrl, { getTokenSupply }) {
  const priceUsd = Number(pair?.priceUsd || 0);
  if (!priceUsd) return { ok: false, reason: 'missing priceUsd', mcapUsd: null, decimals: null };

  const mint = pair?.baseToken?.address;
  if (!mint) return { ok: false, reason: 'missing base token mint', mcapUsd: null, decimals: null };

  const supply = await getTokenSupply(rpcUrl, mint);
  const uiAmount = supply?.value?.uiAmount;
  const decimals = supply?.value?.decimals;
  if (typeof uiAmount !== 'number') return { ok: false, reason: 'missing uiAmount supply', mcapUsd: null, decimals: null };
  if (typeof decimals !== 'number') return { ok: false, reason: 'missing decimals', mcapUsd: null, decimals: null };

  const mcapUsd = uiAmount * priceUsd;
  return { ok: true, reason: 'ok', mcapUsd, decimals };
}

export function pruneRuntimeMaps({ runtimeStateRef, wsmgr, safeErr }) {
  try {
    const runtime = runtimeStateRef?.runtime;
    if (!runtime) return;
    const now = Date.now();
    const maxAgeMs = Math.max(5 * 60_000, Number(process.env.RUNTIME_MAP_MAX_AGE_MS || (6 * 60 * 60_000)));
    const maxSize = Math.max(200, Number(process.env.RUNTIME_MAP_MAX_SIZE || 5000));

    const pruneObjectMap = (obj, tsKey = 'atMs') => {
      if (!obj || typeof obj !== 'object') return 0;
      let removed = 0;
      for (const [k, v] of Object.entries(obj)) {
        const t = Number(v?.[tsKey] ?? v?.tsMs ?? v?.checkedAtMs ?? 0);
        if (t > 0 && (now - t) > maxAgeMs) { delete obj[k]; removed += 1; }
      }
      const keys = Object.keys(obj);
      if (keys.length > maxSize) {
        keys
          .sort((a, b) => Number(obj?.[a]?.[tsKey] ?? obj?.[a]?.tsMs ?? obj?.[a]?.checkedAtMs ?? 0) - Number(obj?.[b]?.[tsKey] ?? obj?.[b]?.tsMs ?? obj?.[b]?.checkedAtMs ?? 0))
          .slice(0, keys.length - maxSize)
          .forEach((k) => { delete obj[k]; removed += 1; });
      }
      return removed;
    };

    const removed = {
      mintCreatedAtCache: pruneObjectMap(runtime.mintCreatedAtCache, 'checkedAtMs'),
      confirmTxCarryByMint: pruneObjectMap(runtime.confirmTxCarryByMint, 'atMs'),
      confirmLiqTrack: pruneObjectMap(runtime.confirmLiqTrack, 'tsMs'),
      wsmgrDiag: pruneObjectMap(wsmgr?.diag, 'atMs'),
      momentumRepeatFail: pruneObjectMap(runtime.momentumRepeatFail, 'tMs'),
    };

    if (Object.values(removed).some((n) => n > 0)) {
      console.log('[mem-prune]', { removed, maxAgeMs, maxSize });
    }
  } catch (e) {
    console.log('[mem-prune] failed', safeErr(e).message);
  }
}

export function startMemoryMonitors({ globalTimers, getRuntimeStateRef, wsmgr, birdEyeWs, safeErr }) {
  if (!globalTimers.memoryMonitor) {
    globalTimers.memoryMonitor = setInterval(() => {
      const m = process.memoryUsage();
      console.log('[memory]', {
        rss_mb: Math.round(m.rss / 1024 / 1024),
        heap_used_mb: Math.round(m.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(m.heapTotal / 1024 / 1024),
        external_mb: Math.round(m.external / 1024 / 1024),
      });
    }, 60_000);
  }

  if (!globalTimers.memoryDebug) {
    globalTimers.memoryDebug = setInterval(() => {
      try {
        const runtimeStateRef = typeof getRuntimeStateRef === 'function' ? getRuntimeStateRef() : null;
        pruneRuntimeMaps({ runtimeStateRef, wsmgr, safeErr });
        const runtime = runtimeStateRef?.runtime || {};
        const watchlist = runtimeStateRef?.watchlist || {};

        console.log('[mem-debug]', {
          trackedMints: Object.keys(watchlist.mints || {}).length,
          hotQueue: Array.isArray(watchlist.hotQueue) ? watchlist.hotQueue.length : 0,
          routeCache: Object.keys(watchlist.routeCache || {}).length,
          mintCreatedAtCache: Object.keys(runtime.mintCreatedAtCache || {}).length,
          confirmTxCarryByMint: Object.keys(runtime.confirmTxCarryByMint || {}).length,
          confirmLiqTrack: Object.keys(runtime.confirmLiqTrack || {}).length,
          momentumRepeatFail: Object.keys(runtime.momentumRepeatFail || {}).length,
          wsmgrDiag: Object.keys(wsmgr?.diag || {}).length,
          birdEyeSubscribed: birdEyeWs?.subscribed ? Array.from(birdEyeWs.subscribed).length : 0,
        });
      } catch (e) {
        console.log('[mem-debug] failed', e?.message || e);
      }
    }, 60_000);
  }
}
