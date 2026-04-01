import { describe, it, expect, vi } from 'vitest';
import { announceBootStatus, bootRuntimeContext } from '../src/control_tower/startup.mjs';

describe('startup runtime path', () => {
  it('retries boot online message and eventually sends wallet announcement', async () => {
    const sent = [];
    const cfg = { BOOT_ANNOUNCE_RETRY_ATTEMPTS: 3, BOOT_ANNOUNCE_RETRY_DELAY_MS: 1 };
    const pub = 'WalletPubKey123';
    const tgSetMyCommands = vi.fn();

    let tries = 0;
    await announceBootStatus({
      cfg,
      pub,
      tgSend: async (_cfg, msg) => {
        sent.push(msg);
        tries += 1;
        return tries >= 3;
      },
      tgSetMyCommands,
    });

    expect(tries).toBe(3);
    expect(sent.length).toBe(3);
    expect(sent[2]).toContain('Candle Carl online');
    expect(sent[2]).toContain(pub);
    expect(sent[2]).toContain('Base: SOL');
    expect(tgSetMyCommands).toHaveBeenCalledTimes(1);
  });

  it('bootRuntimeContext executes startup/runtime wiring and returns context', async () => {
    const calls = {
      bindWsManagerExitHandler: 0,
      startWatchlistCleanupTimer: 0,
      seedOpenPositionsOnBoot: 0,
      announceBootStatus: 0,
      reconcileStartupState: 0,
    };

    const cfg = {
      SOLANA_RPC_URL: 'https://rpc.example.com',
      STATE_PATH: './state/state.json',
      STARTING_CAPITAL_USDC: 100,
      BIRDEYE_LITE_ENABLED: false,
      BIRDEYE_API_KEY: '',
      BIRDEYE_LITE_CHAIN: 'solana',
      BIRDEYE_LITE_MAX_RPS: 10,
      BIRDEYE_LITE_CACHE_TTL_MS: 1000,
      BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS: 1000,
    };

    const state = { positions: {}, runtime: {} };
    const tgSend = vi.fn(async () => {});

    const out = await bootRuntimeContext({
      getConfig: () => cfg,
      summarizeConfigForBoot: () => '[config] ok',
      loadWallet: () => ({ secretKey: 'k' }),
      getPublicKeyBase58: () => 'WalletPubKey123',
      makeConnection: () => ({ rpc: true }),
      loadState: () => state,
      createBirdseyeLiteClient: () => ({ enabled: false, getTokenSnapshot: async () => null }),
      initBirdEyeRuntimeListeners: () => {},
      wsmgr: {},
      birdEyeWs: { start: () => {} },
      safeErr: (e) => ({ message: String(e?.message || e) }),
      bindWsManagerExitHandler: () => { calls.bindWsManagerExitHandler += 1; },
      getSplBalance: async () => ({ amount: 0 }),
      executeSwap: async () => ({}),
      getSolUsdPrice: async () => ({ solUsd: 100 }),
      closePosition: async () => {},
      startWatchlistCleanupTimer: () => { calls.startWatchlistCleanupTimer += 1; },
      globalTimers: {},
      ensureWatchlistState: (s) => { s.watchlist ||= { mints: {} }; return s.watchlist; },
      seedOpenPositionsOnBoot: async () => { calls.seedOpenPositionsOnBoot += 1; },
      cache: { set: () => {} },
      announceBootStatus: async () => { calls.announceBootStatus += 1; },
      tgSend,
      tgSetMyCommands: vi.fn(),
      resolveBootSolUsdWithRetry: async () => 123.45,
      safeMsg: (e) => String(e?.message || e),
      sendBootBalancesMessage: async () => {},
      getSolBalanceLamports: async () => 0,
      fmtUsd: (n) => `$${n}`,
      reconcileStartupState: async () => { calls.reconcileStartupState += 1; },
      reconcilePositions: async () => ({}),
      positionCount: () => 0,
      syncExposureStateWithPositions: () => {},
    });

    expect(out.cfg).toBe(cfg);
    expect(out.state).toBe(state);
    expect(out.pub).toBe('WalletPubKey123');
    expect(out.solUsd).toBe(123.45);
    expect(calls.bindWsManagerExitHandler).toBe(1);
    expect(calls.startWatchlistCleanupTimer).toBe(1);
    expect(calls.seedOpenPositionsOnBoot).toBe(1);
    expect(calls.announceBootStatus).toBe(1);
    expect(calls.reconcileStartupState).toBe(1);
    expect(state.runtime.botStartTimeMs).toBeTypeOf('number');
  });
});
