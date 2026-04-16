import { appendDiagEvent } from './diag_event_store.mjs';

export function createScanCompactEventPusher({ counters, cfg, appendJsonl }) {
  return function pushScanCompactEvent(kind, extra = {}) {
    counters.watchlist ||= {};
    counters.watchlist.compactWindow ||= {};
    const w = counters.watchlist.compactWindow;
    const now = Date.now();
    const retainMs = Math.max(60 * 60_000, Number(cfg.DIAG_RETENTION_MS || (90 * 24 * 60 * 60_000)));
    const cutoff = now - retainMs;

    if (kind === 'candidateSeen') {
      if (!Array.isArray(w.candidateSeen)) w.candidateSeen = [];
      w.candidateSeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
      while (w.candidateSeen.length && Number(w.candidateSeen[0]?.tMs || 0) < cutoff) w.candidateSeen.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'candidateSeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } },
        });
      } catch {}
      return;
    }

    if (kind === 'candidateRouteable') {
      if (!Array.isArray(w.candidateRouteable)) w.candidateRouteable = [];
      w.candidateRouteable.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') });
      while (w.candidateRouteable.length && Number(w.candidateRouteable[0]?.tMs || 0) < cutoff) w.candidateRouteable.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'candidateRouteable', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown') } },
        });
      } catch {}
      return;
    }

    if (kind === 'candidateLiquiditySeen') {
      if (!Array.isArray(w.candidateLiquiditySeen)) w.candidateLiquiditySeen = [];
      w.candidateLiquiditySeen.push({ tMs: now, mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
      while (w.candidateLiquiditySeen.length && Number(w.candidateLiquiditySeen[0]?.tMs || 0) < cutoff) w.candidateLiquiditySeen.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'candidateLiquiditySeen', reason: null, extra: { mint: String(extra?.mint || 'unknown'), source: String(extra?.source || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) } },
        });
      } catch {}
      return;
    }

    if (kind === 'shortlistPreCandidate') {
      if (!Array.isArray(w.shortlistPreCandidate)) w.shortlistPreCandidate = [];
      w.shortlistPreCandidate.push({ tMs: now, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
      while (w.shortlistPreCandidate.length && Number(w.shortlistPreCandidate[0]?.tMs || 0) < cutoff) w.shortlistPreCandidate.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'shortlistPreCandidate', reason: null, extra: { mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) } },
        });
      } catch {}
      return;
    }

    if (kind === 'shortlistSelected') {
      if (!Array.isArray(w.shortlistSelected)) w.shortlistSelected = [];
      w.shortlistSelected.push({ tMs: now, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) });
      while (w.shortlistSelected.length && Number(w.shortlistSelected[0]?.tMs || 0) < cutoff) w.shortlistSelected.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'shortlistSelected', reason: null, extra: { mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0) } },
        });
      } catch {}
      return;
    }

    if (kind === 'shortlistDropped') {
      if (!Array.isArray(w.shortlistDropped)) w.shortlistDropped = [];
      w.shortlistDropped.push({ tMs: now, mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0), reason: String(extra?.reason || 'unknown') });
      while (w.shortlistDropped.length && Number(w.shortlistDropped[0]?.tMs || 0) < cutoff) w.shortlistDropped.shift();
      try {
        appendDiagEvent({
          appendJsonl,
          statePath: cfg.STATE_PATH,
          event: { tMs: now, kind: 'shortlistDropped', reason: null, extra: { mint: String(extra?.mint || 'unknown'), liqUsd: Number(extra?.liqUsd || 0), reason: String(extra?.reason || 'unknown') } },
        });
      } catch {}
    }
  };
}
