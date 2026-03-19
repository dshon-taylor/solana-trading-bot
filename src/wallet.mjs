import { Keypair } from '@solana/web3.js';
import { execFileSync } from 'node:child_process';

function parseSecretJson(text) {
  const v = JSON.parse(text);
  const arr = Array.isArray(v) ? v : (v && Array.isArray(v.keypair) ? v.keypair : null);
  if (!arr || arr.length < 32) throw new Error('Secret key JSON must be an array of bytes');
  return Uint8Array.from(arr);
}

export function loadKeypairFromEnv() {
  // Provide secret key via environment (not committed, not written by bot).
  // This is convenient, but riskier than using SOPS_WALLET_FILE.
  //
  // To reduce "oops I left the raw key in the process env" risk, env-based keys are
  // disabled by default and must be explicitly allowed.
  //
  // - ALLOW_WALLET_SECRET_KEY_ENV=true  (required to enable)
  // - WALLET_SECRET_KEY_JSON: JSON array of bytes (Solana Keypair secretKey)
  // - WALLET_SECRET_KEY_B64: base64 of the same bytes
  const allow = String(process.env.ALLOW_WALLET_SECRET_KEY_ENV || '').toLowerCase() === 'true';
  const json = process.env.WALLET_SECRET_KEY_JSON;
  const b64 = process.env.WALLET_SECRET_KEY_B64;

  if (!allow) {
    // Don't leak whether a key is present; just refuse the mechanism.
    throw new Error(
      'Env wallet secret keys are disabled by default. Prefer SOPS_WALLET_FILE. ' +
        'If you must use env keys, set ALLOW_WALLET_SECRET_KEY_ENV=true.'
    );
  }

  if (json) {
    try {
      const secret = parseSecretJson(json);
      return Keypair.fromSecretKey(secret);
    } catch {
      // Never echo the env var content.
      throw new Error('Invalid WALLET_SECRET_KEY_JSON (must be JSON array of bytes)');
    }
  }

  if (b64) {
    try {
      const buf = Buffer.from(b64, 'base64');
      return Keypair.fromSecretKey(Uint8Array.from(buf));
    } catch {
      throw new Error('Invalid WALLET_SECRET_KEY_B64 (must be base64-encoded bytes)');
    }
  }

  throw new Error('Missing wallet secret: set WALLET_SECRET_KEY_JSON or WALLET_SECRET_KEY_B64');
}

export function loadKeypairFromSopsFile(encPath) {
  // Decrypt an encrypted file at runtime without persisting plaintext.
  // Requires: `sops` installed and configured (e.g., age).
  // File format: JSON array of bytes (same as WALLET_SECRET_KEY_JSON).
  if (!encPath) throw new Error('SOPS_WALLET_FILE is set but empty');
  try {
    const out = execFileSync('sops', ['-d', encPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const secret = parseSecretJson(out);
    return Keypair.fromSecretKey(secret);
  } catch {
    // Never include decrypted content in errors.
    // Also avoid printing the full path if you consider it sensitive.
    throw new Error('Failed to load wallet from SOPS_WALLET_FILE (is sops configured and file valid?)');
  }
}

export function getPublicKeyBase58(keypair) {
  return keypair.publicKey.toBase58();
}
