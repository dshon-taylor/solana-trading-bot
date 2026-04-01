import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../src/config.mjs';

const REQUIRED = {
  HELIUS_API_KEY: 'x',
  TELEGRAM_BOT_TOKEN: 'x',
  TELEGRAM_CHAT_ID: '1',
};

const ENV_KEYS = [
  'HELIUS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'SOLANA_RPC_URL',
  'LASERSTREAM_DEVNET_RPC_URL',
  'LASERSTREAM_DEVNET_WS_URL',
  'JUP_TOKENLIST_URL',
  'ALIVE_PING_URL',
];

let snapshot = {};

beforeEach(() => {
  snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('config endpoint validation', () => {
  it('accepts valid endpoint URLs for startup/runtime paths', () => {
    process.env.SOLANA_RPC_URL = 'https://rpc.example.com';
    process.env.LASERSTREAM_DEVNET_RPC_URL = 'https://devnet-rpc.example.com';
    process.env.LASERSTREAM_DEVNET_WS_URL = 'wss://devnet-ws.example.com/stream';
    process.env.JUP_TOKENLIST_URL = 'https://cache.jup.ag/tokens';
    process.env.ALIVE_PING_URL = 'https://healthchecks.example.com/ping/123';

    const cfg = getConfig();

    expect(() => new URL(cfg.SOLANA_RPC_URL)).not.toThrow();
    expect(() => new URL(cfg.LASERSTREAM_DEVNET_RPC_URL)).not.toThrow();
    expect(() => new URL(cfg.LASERSTREAM_DEVNET_WS_URL)).not.toThrow();
    expect(() => new URL(cfg.JUP_TOKENLIST_URL)).not.toThrow();
    expect(() => new URL(cfg.ALIVE_PING_URL)).not.toThrow();
  });

  it('rejects invalid endpoint protocols', () => {
    process.env.SOLANA_RPC_URL = 'ftp://rpc.example.com';
    expect(() => getConfig()).toThrow(/SOLANA_RPC_URL/);
  });

  it('allows empty optional ALIVE_PING_URL', () => {
    process.env.ALIVE_PING_URL = '';
    const cfg = getConfig();
    expect(cfg.ALIVE_PING_URL).toBe('');
  });
});
