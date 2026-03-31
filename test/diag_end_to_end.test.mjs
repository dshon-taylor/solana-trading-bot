import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeCounters } from '../src/metrics.mjs';
import { handleTelegramControls } from '../src/telegram_control.mjs';
import { createDiagReporting } from '../src/control_tower/diag_reporting.mjs';
import { handleDiagReplayCommands } from '../src/control_tower/operator_surfaces/stage_diag_replay_commands.mjs';

function seedCounters(nowMs) {
  const counters = makeCounters();
  counters.lastFlushAt = nowMs - (8 * 60 * 60_000);
  counters.watchlist ||= {};
  counters.watchlist.compactWindow = {
    scanCycles: [
      { tMs: nowMs - (5 * 60 * 60_000), candidatesFound: 3, durationMs: 1200, intervalMs: 1500 },
      { tMs: nowMs - (7 * 60 * 60_000), candidatesFound: 2, durationMs: 1100, intervalMs: 1400 },
    ],
    watchlistEvaluated: [nowMs - (5 * 60 * 60_000), nowMs - (7 * 60 * 60_000)],
    momentumEval: [nowMs - (5 * 60 * 60_000), nowMs - (7 * 60 * 60_000)],
    momentumPassed: [nowMs - (5 * 60 * 60_000)],
    confirmReached: [nowMs - (5 * 60 * 60_000)],
    confirmPassed: [nowMs - (5 * 60 * 60_000)],
    attempt: [nowMs - (5 * 60 * 60_000)],
    fill: [nowMs - (5 * 60 * 60_000)],
    candidateSeen: [
      { tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', source: 'tokenlist' },
      { tMs: nowMs - (7 * 60 * 60_000), mint: 'MINT2', source: 'tokenlist' },
    ],
    candidateRouteable: [
      { tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', source: 'tokenlist' },
      { tMs: nowMs - (7 * 60 * 60_000), mint: 'MINT2', source: 'tokenlist' },
    ],
    candidateLiquiditySeen: [
      { tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', source: 'tokenlist', liqUsd: 50_000 },
      { tMs: nowMs - (7 * 60 * 60_000), mint: 'MINT2', source: 'tokenlist', liqUsd: 20_000 },
    ],
    momentumLiqValues: [{ tMs: nowMs - (5 * 60 * 60_000), liqUsd: 50_000 }],
    momentumAgeSamples: [{ tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', ageMin: 20, early: true, branch: 'early_2_of_3', source: 'snapshot' }],
    momentumRecent: [{ tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', liq: 50_000, mcap: 100_000, ageMin: 20, early: true, branch: 'early_2_of_3', final: 'momentum.passed' }],
    postMomentumFlow: [
      { tMs: nowMs - (5 * 60 * 60_000), mint: 'MINT1', stage: 'attempt', outcome: 'reached', liq: 50_000, mcap: 100_000, priceImpactPct: 0.01, slippageBps: 30 },
      { tMs: nowMs - (5 * 60 * 60_000) + 1000, mint: 'MINT1', stage: 'fill', outcome: 'passed', liq: 50_000, mcap: 100_000, fillLatencyMs: 2000 },
    ],
    blockers: [],
    momentumFailChecks: [],
    repeatSuppressed: [],
    stalkableSeen: [],
    momentumInputSamples: [],
    momentumScoreSamples: [],
  };
  return counters;
}

function makeHarness({ nowMs, counters }) {
  const state = {
    flags: {},
    positions: {},
    watchlist: {
      mints: {
        MINT1: { pair: { baseToken: { symbol: 'M1', name: 'Mint One' } } },
      },
      hotQueue: ['MINT1'],
    },
    marketData: {
      providers: {
        birdeye: { requests: 10, hits: 7 },
        jupiter: { requests: 10, hits: 9 },
        dexscreener: { requests: 5, hits: 2 },
      },
    },
    runtime: {
      diagCounters: counters,
      diagSnapshot: {
        updatedAtMs: nowMs,
        builtInMs: 5,
        message: 'persisted snapshot body',
      },
    },
  };

  const cfg = {
    TELEGRAM_CHAT_ID: '123',
    TELEGRAM_BOT_TOKEN: 'fake-token',
    STATE_PATH: '/tmp/state.json',
    DIAG_RETENTION_MS: 90 * 24 * 60 * 60_000,
  };

  const reporting = createDiagReporting({
    state,
    getCounters: () => state.runtime.diagCounters,
    cfg,
    birdseye: null,
    nowIso: () => new Date(nowMs).toISOString(),
    fmtCt: (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : 'n/a'),
  });

  return { state, cfg, getDiagSnapshotMessage: reporting.getDiagSnapshotMessage };
}

async function runDiagCommand({ command, state, cfg, getDiagSnapshotMessage }) {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      result: [
        {
          update_id: 1,
          message: {
            chat: { id: Number(cfg.TELEGRAM_CHAT_ID) },
            text: command,
          },
        },
      ],
    }),
  }));

  const sentAcks = [];
  await handleTelegramControls({
    cfg,
    state,
    counters: makeCounters(),
    send: async (_cfg, msg) => { sentAcks.push(msg); },
    nowIso: () => new Date().toISOString(),
  });

  const sentChunks = [];
  await handleDiagReplayCommands({
    cfg,
    state,
    tgSend: async () => {},
    tgSendChunked: async (msg) => { sentChunks.push(msg); },
    getDiagSnapshotMessage,
    runNodeScriptJson: async () => ({}),
    appendLearningNote: () => {},
  });

  return { sentAcks, sentChunks };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('diag modes end-to-end', () => {
  const nowMs = Date.UTC(2026, 2, 31, 18, 0, 0);

  it.each([
    ['/diag 6', 'Diag (compact)'],
    ['/diag momentum 6', 'Diag (momentum)'],
    ['/diag confirm 6', 'Diag (confirm)'],
    ['/diag execution 6', 'Diag (execution)'],
    ['/diag scanner 6', 'Diag (scanner)'],
    ['/diag full 6', 'Diag Snapshot'],
  ])('renders %s via telegram -> flags -> operator diag pipeline', async (command, header) => {
    const counters = seedCounters(nowMs);
    const { state, cfg, getDiagSnapshotMessage } = makeHarness({ nowMs, counters });

    const { sentChunks } = await runDiagCommand({ command, state, cfg, getDiagSnapshotMessage });

    expect(sentChunks.length).toBe(1);
    expect(sentChunks[0]).toContain(header);
    expect(sentChunks[0]).toContain('window=6h');
  });
});

describe('diag 6h survives restart', () => {
  it('includes pre-restart events within 6h window after restart', async () => {
    const nowMs = Date.UTC(2026, 2, 31, 18, 0, 0);

    const preRestartCounters = seedCounters(nowMs);
    const persistedCounters = JSON.parse(JSON.stringify(preRestartCounters));

    const { state, cfg, getDiagSnapshotMessage } = makeHarness({
      nowMs,
      counters: persistedCounters,
    });

    // Simulate PM2 restart: runtime compact window cache is empty, only persisted diagCounters remain.
    state.runtime.compactWindow = undefined;

    const { sentChunks } = await runDiagCommand({
      command: '/diag scanner 6',
      state,
      cfg,
      getDiagSnapshotMessage,
    });

    expect(sentChunks.length).toBe(1);
    const msg = sentChunks[0];
    expect(msg).toContain('Diag (scanner)');
    expect(msg).toContain('window=6h');

    // One scan cycle at T-5h should be included; one at T-7h should be excluded.
    expect(msg).toContain('scannerCycleCount=1');
    expect(msg).toContain('tokenlistPath=1->1->1');
  });
});
