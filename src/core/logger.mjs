import fs from 'node:fs';

export function nowIso() {
  return new Date().toISOString();
}

export function appendTradingLog(path, md) {
  fs.appendFileSync(path, md, { encoding: 'utf8' });
}

export function safeErr(e) {
  if (!e) return { name: 'Error', message: 'Unknown error' };
  return { name: e.name || 'Error', message: e.message || String(e), code: e.code };
}
