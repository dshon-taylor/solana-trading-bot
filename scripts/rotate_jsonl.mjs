import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || './state';
const DAYS = Number(process.argv[3] || 30);
const now = Date.now();
const cutoff = now - DAYS * 24 * 60 * 60 * 1000;

function rotate(fp) {
  try {
    const st = fs.statSync(fp);
    if (st.mtimeMs < cutoff) {
      const dest = fp + '.old';
      fs.renameSync(fp, dest);
      console.log(`[rotated] ${fp} -> ${dest}`);
    }
  } catch (e) {
    // ignore
  }
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.jsonl')) rotate(p);
  }
}

if (!fs.existsSync(DIR)) {
  console.log(`[info] dir ${DIR} missing`);
  process.exit(0);
}

walk(DIR);
console.log('[done] rotate_jsonl complete');
