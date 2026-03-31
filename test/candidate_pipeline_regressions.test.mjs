import { describe, it, expect, vi } from 'vitest';
import { runJupExpansionStage } from '../src/control_tower/candidate_pipeline/stage_jup_expansion.mjs';

describe('candidate pipeline regressions', () => {
  it('jup expansion does not crash when birdseye.listJupiterTokens is missing', async () => {
    const tgSend = vi.fn(async () => {});
    const saveState = vi.fn(() => {});
    const boostedRaw = [{ tokenAddress: 'AAA', _source: 'dex' }];

    const out = await runJupExpansionStage({
      cfg: { MIN_LIQ_USD: 20_000, STATE_PATH: '/tmp/state.json' },
      state: { watchlist: { mints: {} } },
      birdseye: {},
      tgSend,
      saveState,
      cacheState: {
        jupTokens: null,
        jupTokensAt: 0,
        trendingTokens: [],
        marketTrendingTokens: [],
        birdEyeBoostedTokens: [],
      },
      t: Date.now(),
      scanPhase: { candidateJupExpandMs: 0, candidateSourceMergingMs: 0, candidateJupSourceMapMs: 0, candidateJupFilterMs: 0, candidateJupMapMs: 0 },
      solUsdNow: 100,
      boostedRaw,
    });

    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(1);
    expect(out[0].tokenAddress).toBe('AAA');
    expect(tgSend).not.toHaveBeenCalledWith(expect.stringContaining('JUP expansion skipped'));
  });

  it('candidate pipeline returns back-compat boosted alias from finalized candidates', async () => {
    vi.resetModules();
    vi.doMock('../src/control_tower/candidate_pipeline/stage_source_discovery.mjs', () => ({
      runSourceDiscoveryStage: vi.fn(async () => ({
        boostedRaw: [{ tokenAddress: 'M1' }],
        newDexCooldownUntil: 123,
      })),
    }));
    vi.doMock('../src/control_tower/candidate_pipeline/stage_jup_expansion.mjs', () => ({
      runJupExpansionStage: vi.fn(async ({ boostedRaw }) => boostedRaw),
    }));
    vi.doMock('../src/control_tower/candidate_pipeline/stage_finalize_candidates.mjs', () => ({
      runFinalizeCandidatesStage: vi.fn(() => ({
        candidates: [{ mint: 'M1' }, { mint: 'M2' }],
      })),
    }));

    const { createCandidatePipeline } = await import('../src/control_tower/candidate_pipeline/index.mjs');

    const { fetchCandidateSources } = createCandidatePipeline({
      cfg: {},
      state: {},
      birdseye: null,
      streamingProvider: null,
      tgSend: async () => {},
      saveState: () => {},
    });

    const out = await fetchCandidateSources({
      t: Date.now(),
      scanPhase: {},
      solUsdNow: 100,
      counters: {},
    });

    expect(out.candidates).toEqual([{ mint: 'M1' }, { mint: 'M2' }]);
    expect(out.boosted).toEqual(out.candidates);
    expect(out.newDexCooldownUntil).toBe(123);
  });
});
