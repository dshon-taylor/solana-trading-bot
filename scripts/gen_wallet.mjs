import { Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';

const outPath = process.argv[2];
if (!outPath) {
  console.error('Usage: node gen_wallet.mjs <outPath.json>');
  process.exit(2);
}

const kp = Keypair.generate();
const secret = Array.from(kp.secretKey);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(secret), { mode: 0o600 });
console.log(kp.publicKey.toBase58());
