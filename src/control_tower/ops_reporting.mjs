export function fmtUsd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '$0';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function splitForTelegram(text, maxLen = 3500) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) out.push(rest);
  return out;
}

export function createOpsReporting({
  cfg,
  state,
  conn,
  pub,
  birdseye,
  tgSend,
  getSplBalance,
  tokenDisplayName,
}) {
  async function tgSendChunked(text) {
    const parts = splitForTelegram(text, 3500);
    for (let i = 0; i < parts.length; i++) {
      const head = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
      await tgSend(cfg, `${head}${parts[i]}`);
    }
  }

  async function sendPositionsReport() {
    const openEntries = Object.entries(state.positions || {}).filter(([, p]) => p?.status === 'open');
    if (!openEntries.length) {
      await tgSend(cfg, '📌 *Positions*\n\nNone open.');
      return;
    }

    const lines = [];
    for (const [mint, p] of openEntries) {
      let tokenName = String(p?.tokenName || '').trim();
      let tokenSymbol = String(p?.symbol || '').trim();
      const stop = Number(p?.stopPriceUsd || 0);
      const peak = Math.max(
        Number(p?.peakPriceUsd || 0),
        Number(p?.lastPeakPrice || 0),
        Number(p?.trailingAnchor || 0),
        0,
      );

      let dec = Number(p?.decimals);
      let livePrice = Number(p?.lastSeenPriceUsd || 0);
      try {
        const snap = await birdseye?.getTokenSnapshot?.(mint);
        const d = Number(snap?.raw?.decimals);
        if (Number.isFinite(d) && d >= 0) dec = d;
        const px = Number(snap?.priceUsd || 0);
        if (px > 0) livePrice = px;
        if (!tokenName) tokenName = String(snap?.raw?.name || '').trim();
        if (!tokenSymbol) tokenSymbol = String(snap?.raw?.symbol || '').trim();
      } catch {}

      let liveRaw = Number(p?.onchain?.amount || 0);
      try {
        const bal = await getSplBalance(conn, pub, mint);
        if (bal?.fetchOk !== false && Number(bal?.amount || 0) >= 0) liveRaw = Number(bal.amount || 0);
      } catch {}

      const recvRaw = Number(p?.receivedTokensRaw || 0);
      const basisRaw = recvRaw > 0 ? recvRaw : liveRaw;
      const basisTokens = (basisRaw > 0 && Number.isFinite(dec) && dec >= 0) ? (basisRaw / (10 ** dec)) : null;
      const liveTokens = (liveRaw > 0 && Number.isFinite(dec) && dec >= 0) ? (liveRaw / (10 ** dec)) : null;

      const spentUsd = (Number(p?.spentSolApprox || 0) > 0 && Number(p?.solUsdAtEntry || 0) > 0)
        ? (Number(p.spentSolApprox) * Number(p.solUsdAtEntry))
        : null;
      const basisPx = (basisTokens && spentUsd) ? (spentUsd / basisTokens) : Number(p?.entryPriceUsd || 0) || null;
      const pnlPct = (basisPx && livePrice > 0) ? (((livePrice - basisPx) / basisPx) * 100) : null;
      const estValue = (liveTokens && livePrice > 0) ? (liveTokens * livePrice) : null;

      const label = tokenDisplayName({ name: tokenName, symbol: tokenSymbol, mint });
      lines.push(`• ${label} (${mint.slice(0,6)}…)`);
      if (tokenName || tokenSymbol) lines.push(`  name=${tokenName || 'n/a'} symbol=${tokenSymbol || 'n/a'}`);
      lines.push(`  stop=$${stop.toFixed(6)} last=$${livePrice.toFixed(6)} peak=$${peak.toFixed(6)}`);
      lines.push(`  trailing=${p?.trailingActive ? 'on' : 'off'} trailPct=${Number.isFinite(Number(p?.activeTrailPct)) ? `${(Number(p.activeTrailPct)*100).toFixed(1)}%` : 'n/a'}`);
      lines.push(`  basis=${basisPx ? `$${basisPx.toFixed(10)}` : 'n/a'} source=${p?.entryPriceSource || 'unknown'} tokens=${liveTokens ? liveTokens.toFixed(5) : 'n/a'} spent≈${spentUsd != null ? fmtUsd(spentUsd) : 'n/a'}`);
      lines.push(`  estValue=${estValue != null ? fmtUsd(estValue) : 'n/a'} pnl=${pnlPct != null ? `${pnlPct.toFixed(2)}%` : 'n/a'}`);
    }

    const msg = `📌 *Positions* (${openEntries.length})\n\n` + lines.join('\n');
    if (msg.length <= 3500) {
      await tgSend(cfg, msg);
    } else {
      const chunks = [];
      let cur = `📌 *Positions* (${openEntries.length})\n\n`;
      for (const line of lines) {
        if ((cur + line + '\n').length > 3200) {
          chunks.push(cur);
          cur = '';
        }
        cur += line + '\n';
      }
      if (cur.trim()) chunks.push(cur);
      for (const ch of chunks) await tgSend(cfg, ch);
    }
  }

  return {
    tgSendChunked,
    sendPositionsReport,
  };
}

export function createSpendSummaryCache({
  cfg,
  parseRange,
  readLedger,
  summarize,
  safeErr,
}) {
  const spendSummaryCache = {
    loadedAtMs: 0,
    summaries: new Map(),
    inFlight: false,
    lastError: null,
  };

  function refreshSpendSummaryCacheAsync() {
    if (spendSummaryCache.inFlight) return;
    spendSummaryCache.inFlight = true;
    Promise.resolve().then(() => {
      const events = readLedger(cfg.LEDGER_PATH);
      const next = new Map();
      for (const key of ['last', '24h', '7d', '30d']) {
        next.set(key, summarize(events, parseRange(key)));
      }
      spendSummaryCache.summaries = next;
      spendSummaryCache.loadedAtMs = Date.now();
      spendSummaryCache.lastError = null;
    }).catch((e) => {
      spendSummaryCache.lastError = safeErr(e).message;
    }).finally(() => {
      spendSummaryCache.inFlight = false;
    });
  }

  return {
    spendSummaryCache,
    refreshSpendSummaryCacheAsync,
  };
}
