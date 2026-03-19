import fs from 'node:fs';
import path from 'node:path';

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch {}
}

export function maybePruneJsonlByAge({ filePath, maxAgeDays, nowMs }) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, skipped: true, reason: 'missing' };
  if (!Number.isFinite(Number(maxAgeDays)) || Number(maxAgeDays) <= 0) return { ok: true, skipped: true, reason: 'disabled' };

  const keepAfterMs = nowMs - Number(maxAgeDays) * 24 * 60 * 60_000;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  let kept = [];
  let dropped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const t = obj?.t ? Date.parse(obj.t) : null;
      if (t && t >= keepAfterMs) {
        kept.push(line);
      } else {
        dropped += 1;
      }
    } catch {
      // If parsing fails, keep the line (data is better than losing it).
      kept.push(line);
    }
  }

  if (!dropped) return { ok: true, skipped: true, reason: 'nothing_to_drop' };

  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, kept.join('\n') + '\n');
  fs.renameSync(tmp, filePath);
  return { ok: true, skipped: false, dropped, kept: kept.length };
}

export function maybeRotateBySize({ filePath, maxBytes, nowMs }) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, skipped: true, reason: 'missing' };
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) <= 0) return { ok: true, skipped: true, reason: 'disabled' };

  const st = fs.statSync(filePath);
  if (st.size <= maxBytes) return { ok: true, skipped: true, reason: 'under_limit', size: st.size };

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const rotated = path.join(dir, `${base}.${stamp}.bak`);

  fs.renameSync(filePath, rotated);
  fs.writeFileSync(filePath, '');

  // Best-effort: don't keep too many backups.
  try {
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f.endsWith('.bak'))
      .sort();
    while (backups.length > 5) {
      const f = backups.shift();
      safeUnlink(path.join(dir, f));
    }
  } catch {}

  return { ok: true, skipped: false, rotated };
}
