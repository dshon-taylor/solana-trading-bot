import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  parseReplayRequest,
  parseOptimizeRequest,
  parseLastArg,
  parseSpendArg,
  parseSetFilterArgs,
} from '../src/telegram_control.mjs';

describe('telegram_control parsing', () => {
  it('parses slash command and args', () => {
    expect(parseCommand('/replay 7 windowh=24')).toEqual({ cmd: '/replay', args: ['7', 'windowh=24'] });
    expect(parseCommand('hello')).toBeNull();
  });

  it('parses replay defaults, presets, and overrides', () => {
    const d = parseReplayRequest([]);
    expect(d.req.days).toBe(7);
    expect(d.req.preset).toBe('standard');

    const p = parseReplayRequest(['quick']);
    expect(p.req).toMatchObject({ preset: 'quick', days: 3, windowHours: 24 });

    const o = parseReplayRequest(['deep', '10', 'windowh=12', 'activate=0.08', 'distance=0.11', 'stopbuf=0.0009']);
    expect(o.req).toMatchObject({
      preset: 'deep',
      days: 10,
      windowHours: 12,
      trailActivatePct: 0.08,
      trailDistancePct: 0.11,
      stopEntryBufferPct: 0.0009,
    });
  });

  it('rejects bad replay input', () => {
    expect(parseReplayRequest(['99']).error).toMatch(/days/);
    expect(parseReplayRequest(['7', 'windowh=0']).error).toMatch(/windowh/);
  });

  it('parses optimize preset and override ranges', () => {
    const p = parseOptimizeRequest(['quick', '7', 'top=5']);
    expect(p.req).toMatchObject({ days: 7, preset: 'quick', top: 5 });

    const o = parseOptimizeRequest(['distance=0.1:0.2:0.02', 'activate=0.05:0.1:0.01', 'stopbuf=0.001:0.002:0.001']);
    expect(o.req.preset).toBe('standard');
    expect(o.req.trailDistanceRange).toBe('0.1:0.2:0.02');
    expect(o.req.trailActivateRange).toBe('0.05:0.1:0.01');
    expect(o.req.stopEntryBufferRange).toBe('0.001:0.002:0.001');
  });

  it('enforces /last bounds', () => {
    expect(parseLastArg(undefined)).toEqual({ ok: true, value: 20 });
    expect(parseLastArg('1')).toEqual({ ok: true, value: 1 });
    expect(parseLastArg('100')).toEqual({ ok: true, value: 100 });
    expect(parseLastArg('0').ok).toBe(false);
    expect(parseLastArg('-1').ok).toBe(false);
    expect(parseLastArg('500').ok).toBe(false);
  });

  it('enforces /spend arg validity', () => {
    expect(parseSpendArg('24h')).toEqual({ ok: true, value: '24h' });
    expect(parseSpendArg('7d')).toEqual({ ok: true, value: '7d' });
    expect(parseSpendArg('last')).toEqual({ ok: true, value: 'last' });
    expect(parseSpendArg('')).toEqual({ ok: true, value: '24h' });
    expect(parseSpendArg('abc').ok).toBe(false);
    expect(parseSpendArg('0h').ok).toBe(false);
  });

  it('enforces /setfilter bounds', () => {
    expect(parseSetFilterArgs(['liq', '50000'])).toMatchObject({ ok: true, stateKey: 'MIN_LIQUIDITY_USD' });
    expect(parseSetFilterArgs(['liqratio', '0.25'])).toMatchObject({ ok: true, stateKey: 'LIQUIDITY_TO_MCAP_RATIO' });
    expect(parseSetFilterArgs(['liqratio', '0']).ok).toBe(false);
    expect(parseSetFilterArgs(['age', '-1']).ok).toBe(false);
    expect(parseSetFilterArgs(['nope', '1']).ok).toBe(false);
  });
});
