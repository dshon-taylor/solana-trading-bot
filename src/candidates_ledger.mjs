import fs from 'node:fs';
import path from 'node:path';

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

export function appendJsonl(filePath, obj) {
  if (!filePath) return;
  try {
    ensureDir(filePath);
    // Augment with audit fields for better traceability. Do not overwrite existing keys.
    const audit = {
      t_audit: new Date().toISOString(),
      host: process.env.HOSTNAME || null,
      pid: process.pid,
      requestId: (Math.random().toString(36).slice(2, 10)),
    };
    const out = { ...audit, ...obj };
    fs.appendFileSync(filePath, JSON.stringify(out) + '\n', 'utf8');
  } catch {
    // Never crash trading due to logging.
  }
}

function yyyyMmDd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function candidateDailyPath(dir, d = new Date()) {
  return path.join(dir, `${yyyyMmDd(d)}.jsonl`);
}

export function pruneDailyDir({ dir, retentionDays }) {
  if (!dir || !retentionDays) return;
  try {
    ensureDir(path.join(dir, 'x'));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;

    for (const f of files) {
      // Expect YYYY-MM-DD.jsonl
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const ts = Date.parse(m[1] + 'T00:00:00Z');
      if (ts && ts < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

export function logCandidateDaily({ dir, retentionDays, event }) {
  const p = candidateDailyPath(dir, new Date());
  appendJsonl(p, event);
  // prune occasionally (cheap enough)
  pruneDailyDir({ dir, retentionDays });
}
