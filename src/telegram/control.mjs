import { safeErr } from '../core/logger.mjs';
import { buildHelpText } from './commands.mjs';

const REPLAY_USAGE =
  'Usage: /replay [quick|standard|deep] [days 1-30] [windowh=1..168] [activate=0..1] [distance=0..1] [stopbuf=0..0.05]';
const OPTIMIZE_USAGE =
  'Usage: /optimize [quick|standard|deep] [days 1-30] [top=1..20] [windowh=1..168] [activate=<range>] [distance=<range>] [stopbuf=<range>]';

const SPEND_USAGE = 'Usage: /spend [last|<hours>h|<days>d] (examples: /spend 24h, /spend 7d, /spend last)';
const LAST_USAGE = 'Usage: /last [n] where n is 1..100 (example: /last 20)';
const SETFILTER_USAGE = 'Usage: /setfilter <liq|mcap|age|liqratio> <number>';
const UNKNOWN_COMMAND = '❓ Unknown command. Use /help for available commands.';

const FILTER_BOUNDS = {
  liq: { key: 'MIN_LIQUIDITY_USD', min: 1_000, max: 10_000_000, label: 'liq' },
  mcap: { key: 'MIN_MCAP_USD', min: 1_000, max: 2_000_000_000, label: 'mcap' },
  age: { key: 'MIN_TOKEN_AGE_HOURS', min: 0, max: 24 * 365, label: 'age (hours)' },
  liqratio: { key: 'LIQUIDITY_TO_MCAP_RATIO', min: 0.01, max: 0.95, label: 'liqratio' },
};

const OPTIMIZE_PRESETS = {
  quick: {
    activate: '0.06:0.18:0.02',
    distance: '0.08:0.18:0.02',
    stopbuf: '0.0003:0.0015:0.0003',
  },
  standard: {
    activate: '0.05:0.20:0.01',
    distance: '0.08:0.20:0.02',
    stopbuf: '0.0003:0.003:0.0003',
  },
  deep: {
    activate: '0.03:0.35:0.01',
    distance: '0.05:0.30:0.01',
    stopbuf: '0.0002:0.005:0.0002',
  },
};

const REPLAY_PRESETS = {
  quick: { days: 3, windowHours: 24 },
  standard: { days: 7, windowHours: null },
  deep: { days: 21, windowHours: null },
};

export async function tgGetUpdates(cfg, offset) {
  const url = new URL(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/getUpdates`);
  if (typeof offset === 'number') url.searchParams.set('offset', String(offset));
  url.searchParams.set('timeout', '0');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.status}`);
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram getUpdates not ok');
  return json.result || [];
}

function normalizeText(msg) {
  return (msg?.text || '').trim();
}

function parseNum(value, { min = null, max = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

function parseKeyValueArgs(args) {
  const kv = {};
  for (const a of args || []) {
    const i = a.indexOf('=');
    if (i <= 0) continue;
    const key = a.slice(0, i).trim().toLowerCase();
    const value = a.slice(i + 1).trim();
    if (!key || !value) continue;
    kv[key] = value;
  }
  return kv;
}

export function parseSpendArg(arg) {
  const a = String(arg || '24h').trim().toLowerCase();
  if (a === 'last') return { ok: true, value: a };
  const m = a.match(/^([0-9]+)\s*(h|d)$/);
  if (!m) return { ok: false, error: SPEND_USAGE };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: SPEND_USAGE };
  if (m[2] === 'h' && n > 24 * 365) return { ok: false, error: 'hours must be <= 8760' };
  if (m[2] === 'd' && n > 365) return { ok: false, error: 'days must be <= 365' };
  return { ok: true, value: `${n}${m[2]}` };
}

export function parseLastArg(arg) {
  if (arg == null || String(arg).trim() === '') return { ok: true, value: 20 };
  const n = Number(String(arg).trim());
  if (!Number.isInteger(n)) return { ok: false, error: LAST_USAGE };
  if (n < 1 || n > 100) return { ok: false, error: 'n must be between 1 and 100. Example: /last 20' };
  return { ok: true, value: n };
}

export function parseSetFilterArgs(args) {
  const key = String(args?.[0] || '').toLowerCase();
  const raw = args?.[1];
  const bound = FILTER_BOUNDS[key];
  if (!bound) {
    return { ok: false, error: `Unknown filter key. Use: ${Object.keys(FILTER_BOUNDS).join(', ')}` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `${SETFILTER_USAGE}\n${bound.label} must be a number` };
  }
  if (value < bound.min || value > bound.max) {
    return { ok: false, error: `${bound.label} must be between ${bound.min} and ${bound.max}` };
  }
  return { ok: true, key, stateKey: bound.key, value };
}

function getPresetArg(args, presetsMap, defaultPreset = 'standard') {
  const first = String(args?.[0] || '').toLowerCase();
  if (!first) return { preset: defaultPreset, consumed: false };
  if (!presetsMap[first]) return { preset: defaultPreset, consumed: false };
  return { preset: first, consumed: true };
}

export function parseReplayRequest(args) {
  const presetSel = getPresetArg(args, REPLAY_PRESETS, 'standard');
  const rest = presetSel.consumed ? args.slice(1) : args;
  const first = rest?.[0] || '';
  const firstN = Number(first);
  const hasNumericFirst = first !== '' && Number.isFinite(firstN);

  const kv = parseKeyValueArgs(rest);
  const presetCfg = REPLAY_PRESETS[presetSel.preset] || REPLAY_PRESETS.standard;

  const days = hasNumericFirst ? parseNum(firstN, { min: 1, max: 30 }) : presetCfg.days;
  if (days == null) return { error: 'days must be between 1 and 30' };

  const windowHours = kv.windowh ?? kv.windowhours ?? kv.window;
  const activate = kv.activate;
  const distance = kv.distance;
  const stopbuf = kv.stopbuf ?? kv.stopentrybuffer;

  const req = {
    days,
    preset: presetSel.preset,
    windowHours: windowHours == null ? presetCfg.windowHours : parseNum(windowHours, { min: 1, max: 168 }),
    trailActivatePct: activate == null ? null : parseNum(activate, { min: 0.0001, max: 0.99 }),
    trailDistancePct: distance == null ? null : parseNum(distance, { min: 0.0001, max: 0.99 }),
    stopEntryBufferPct: stopbuf == null ? null : parseNum(stopbuf, { min: 0.00001, max: 0.05 }),
  };

  if (windowHours != null && req.windowHours == null) return { error: 'windowh must be 1..168' };
  if (activate != null && req.trailActivatePct == null) return { error: 'activate must be >0 and <1' };
  if (distance != null && req.trailDistancePct == null) return { error: 'distance must be >0 and <1' };
  if (stopbuf != null && req.stopEntryBufferPct == null) return { error: 'stopbuf must be >0 and <=0.05' };

  return { req };
}

export function parseOptimizeRequest(args) {
  const presetSel = getPresetArg(args, OPTIMIZE_PRESETS, 'standard');
  const rest = presetSel.consumed ? args.slice(1) : args;
  const first = rest?.[0] || '';
  const firstN = Number(first);
  const hasNumericFirst = first !== '' && Number.isFinite(firstN);

  const kv = parseKeyValueArgs(rest);
  const preset = OPTIMIZE_PRESETS[presetSel.preset];

  const days = hasNumericFirst ? parseNum(firstN, { min: 1, max: 30 }) : REPLAY_PRESETS[presetSel.preset].days;
  if (days == null) return { error: 'days must be between 1 and 30' };

  const top = kv.top == null ? 10 : parseNum(kv.top, { min: 1, max: 20 });
  if (top == null) return { error: 'top must be between 1 and 20' };

  const windowHoursRaw = kv.windowh ?? kv.windowhours ?? kv.window;
  const windowHours = windowHoursRaw == null ? REPLAY_PRESETS[presetSel.preset].windowHours : parseNum(windowHoursRaw, { min: 1, max: 168 });
  if (windowHoursRaw != null && windowHours == null) return { error: 'windowh must be 1..168' };

  return {
    req: {
      days,
      top,
      windowHours,
      preset: presetSel.preset,
      trailActivateRange: kv.activate || preset.activate,
      trailDistanceRange: kv.distance || preset.distance,
      stopEntryBufferRange: kv.stopbuf || preset.stopbuf,
    },
  };
}

export function parseCommand(text) {
  if (!text.startsWith('/')) return null;
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const args = rest;
  return { cmd, args };
}

function setPersistFlag(state) {
  state.flags ||= {};
  state.flags.saveStateNow = true;
}

export async function handleTelegramControls({ cfg, state, counters, send, nowIso, onDiagRequest = null, onPositionsRequest = null }) {
  const allowedChatId = String(cfg.TELEGRAM_CHAT_ID);
  state.tg ||= { offset: null };

  let updates = [];
  try {
    const off = state.tg.offset == null ? undefined : Number(state.tg.offset);
    updates = await tgGetUpdates(cfg, off);
  } catch (e) {
    console.error('[tg-control]', safeErr(e));
    return;
  }

  for (const u of updates) {
    state.tg.offset = (u.update_id || 0) + 1;

    const msg = u.message || u.edited_message;
    if (!msg) continue;
    const chatId = String(msg.chat?.id ?? '');
    if (chatId !== allowedChatId) continue;

    const text = normalizeText(msg);
    const parsed = parseCommand(text);
    if (!parsed) continue;

    const { cmd, args } = parsed;

    if (cmd === '/help') {
      await send(cfg, buildHelpText());
      continue;
    }

    if (cmd === '/halt') {
      if (cfg.FORCE_TRADING_ENABLED) {
        await send(cfg, '🛑 /halt ignored (FORCE_TRADING_ENABLED=true).');
      } else {
        state.tradingEnabled = false;
        setPersistFlag(state);
        await send(cfg, `🛑 *Entries halted*\n\nExits/stops still active.\n${nowIso()}`);
      }
      continue;
    }

    if (cmd === '/resume') {
      state.tradingEnabled = true;
      setPersistFlag(state);
      await send(cfg, `✅ *Entries resumed*\n\n${nowIso()}`);
      continue;
    }

    if (cmd === '/debug' || cmd === '/debug_on') {
      state.debug ||= {};
      const mode = cmd === '/debug_on' ? 'on' : String(args?.[0] || '').toLowerCase();
      const minsRaw = cmd === '/debug_on' ? args?.[0] : args?.[1];
      if (!['on', 'off'].includes(mode)) {
        await send(cfg, 'Usage: /debug on|off [mins]');
        continue;
      }
      if (mode === 'off') {
        state.debug.rejections = false;
        setPersistFlag(state);
        await send(cfg, '🧪 *Debug OFF*');
        continue;
      }
      const mins = minsRaw == null ? 5 : Number(minsRaw);
      if (!Number.isFinite(mins) || mins <= 0 || mins > 180) {
        await send(cfg, 'mins must be between 1 and 180. Example: /debug on 10');
        continue;
      }
      state.debug.rejections = true;
      state.debug.rejectionsEveryMs = mins * 60_000;
      setPersistFlag(state);
      await send(cfg, `🧪 *Debug ON* — rejection summaries every ${Math.round(state.debug.rejectionsEveryMs / 60000)}m`);
      continue;
    }

    if (cmd === '/debug_off') {
      state.debug ||= {};
      state.debug.rejections = false;
      setPersistFlag(state);
      await send(cfg, '🧪 *Debug OFF*');
      continue;
    }

    if (cmd === '/pings' || cmd === '/pings_on' || cmd === '/pings_off') {
      const mode = cmd === '/pings_on' ? 'on' : cmd === '/pings_off' ? 'off' : String(args?.[0] || '').toLowerCase();
      if (!['on', 'off'].includes(mode)) {
        await send(cfg, 'Usage: /pings on|off');
        continue;
      }
      state.flags ||= {};
      state.flags.tgVisibilityPings = mode === 'on';
      state.flags.hourlyDiagEnabled = mode === 'on';
      setPersistFlag(state);
      await send(cfg, mode === 'on' ? '🔔 Pings: *ON* (scan-cycle + throughput)' : '🔕 Pings: *OFF* (scan-cycle + throughput)');
      continue;
    }

    if (cmd === '/paper' || cmd === '/paper_on' || cmd === '/paper_off') {
      state.paper ||= { enabledUntilMs: 0, positions: {} };
      let mode = String(args?.[0] || '').toLowerCase();
      let hoursRaw = args?.[1];
      if (cmd === '/paper_on') {
        mode = 'on';
        hoursRaw = args?.[0];
      } else if (cmd === '/paper_off') {
        mode = 'off';
      }
      if (!['on', 'off'].includes(mode)) {
        await send(cfg, 'Usage: /paper on [hours] | off');
        continue;
      }
      if (mode === 'off') {
        state.paper.enabledUntilMs = 0;
        setPersistFlag(state);
        await send(cfg, '📝 Paper momentum: *OFF*');
        continue;
      }
      const hours = hoursRaw == null ? 24 : Number(hoursRaw);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
        await send(cfg, 'hours must be between 1 and 168. Example: /paper on 24');
        continue;
      }
      state.paper.enabledUntilMs = Date.now() + hours * 60 * 60_000;
      setPersistFlag(state);
      await send(cfg, `📝 Paper momentum: *ON* for ${hours}h`);
      continue;
    }

    if (cmd === '/rejections') {
      const c = counters;
      await send(
        cfg,
        [
          '📊 *Scanner Summary*',
          `🕒 ${nowIso()}`,
          '',
          `• Scanned: ${c.scanned}`,
          `• Pairs considered: ${c.consideredPairs}`,
          '',
          '🚫 Rejects',
          `• noPair: ${c.reject.noPair}`,
          `  - providerEmpty: ${c.reject.noPairReasons?.providerEmpty ?? 0}`,
          `  - providerCooldown: ${c.reject.noPairReasons?.providerCooldown ?? 0}`,
          `  - rateLimited: ${c.reject.noPairReasons?.rateLimited ?? 0}`,
          `  - routeNotFound: ${c.reject.noPairReasons?.routeNotFound ?? 0}`,
          `  - nonTradableMint: ${c.reject.noPairReasons?.nonTradableMint ?? 0}`,
          `  - deadMint: ${c.reject.noPairReasons?.deadMint ?? 0}`,
          `  - routeableNoMarketData: ${c.reject.noPairReasons?.routeableNoMarketData ?? 0}`,
          `  - staleData: ${c.reject.noPairReasons?.staleData ?? 0}`,
          `  - retriesExhausted: ${c.reject.noPairReasons?.retriesExhausted ?? 0}`,
          `• baseFilters: ${c.reject.baseFilters}`,
          `• rugUnsafe: ${c.reject.rugUnsafe} (fetchFail=${c.reject.rugcheckFetch})`,
          `• mcap: ${c.reject.mcapLowOrMissing} (fetchFail=${c.reject.mcapFetch})`,
          `• momentum: ${c.reject.momentum}`,
          `• noSocial: ${c.reject.noSocialMeta}`,
          `• swapError: ${c.reject.swapError}`,
        ].join('\n')
      );
      continue;
    }

    if (cmd === '/last' || cmd === '/candidates') {
      const parsedLast = parseLastArg(args?.[0]);
      if (!parsedLast.ok) {
        await send(cfg, `❌ ${parsedLast.error}`);
        continue;
      }
      state.flags ||= {};
      state.flags.sendLast = parsedLast.value;
      await send(cfg, '⏳ Last-candidates requested…');
      continue;
    }

    if (cmd === '/status') {
      state.flags ||= {};
      state.flags.sendStatus = true;
      await send(cfg, '⏳ Status requested…');
      continue;
    }

    if (cmd === '/positions') {
      if (typeof onPositionsRequest === 'function') {
        try {
          await onPositionsRequest();
          continue;
        } catch {
          // fallback to flag path
        }
      }
      state.flags ||= {};
      state.flags.sendPositions = true;
      await send(cfg, '⏳ Positions requested…');
      continue;
    }

    if (cmd === '/opencheck') {
      state.flags ||= {};
      state.flags.sendOpencheck = true;
      await send(cfg, '⏳ Open-count reconciliation requested…');
      continue;
    }

    if (cmd === '/filters') {
      state.flags ||= {};
      state.flags.sendFilters = true;
      await send(cfg, '⏳ Filters requested…');
      continue;
    }

    if (cmd === '/hardrejects') {
      state.flags ||= {};
      state.flags.sendHardrejects = true;
      await send(cfg, '⏳ Hard rejects requested…');
      continue;
    }

    if (cmd === '/setfilter') {
      const parsedFilter = parseSetFilterArgs(args);
      if (!parsedFilter.ok) {
        await send(cfg, `❌ ${parsedFilter.error}`);
        continue;
      }
      state.filterOverrides ||= {};
      state.filterOverrides[parsedFilter.stateKey] = parsedFilter.value;
      setPersistFlag(state);
      await send(cfg, `✅ Updated filter ${parsedFilter.key} -> ${parsedFilter.value}`);
      continue;
    }

    if (cmd === '/resetfilters') {
      delete state.filterOverrides;
      setPersistFlag(state);
      await send(cfg, '✅ Filter overrides cleared (back to defaults)');
      continue;
    }

    if (cmd === '/models') {
      state.flags ||= {};
      state.flags.sendModels = true;
      await send(cfg, '⏳ Models requested…');
      continue;
    }

    if (cmd === '/setmodel') {
      const which = (args?.[0] || '').toLowerCase();
      const model = (args?.[1] || '').trim();
      if (!which || !model) {
        await send(cfg, 'Usage: /setmodel <preprocess|analyze|gatekeeper> <modelId>');
        continue;
      }
      state.modelOverrides ||= {};
      if (which === 'preprocess') state.modelOverrides.preprocess = model;
      else if (which === 'analyze') state.modelOverrides.analyze = model;
      else if (which === 'gatekeeper') state.modelOverrides.gatekeeper = model;
      else {
        await send(cfg, 'Unknown stage. Use: preprocess, analyze, gatekeeper');
        continue;
      }
      setPersistFlag(state);
      await send(cfg, `✅ Model set: ${which} -> ${model}`);
      continue;
    }

    if (cmd === '/spend') {
      const parsedSpend = parseSpendArg(args?.[0] || '24h');
      if (!parsedSpend.ok) {
        await send(cfg, `❌ ${parsedSpend.error}`);
        continue;
      }
      state.flags ||= {};
      state.flags.sendSpend = parsedSpend.value;
      await send(cfg, '⏳ Spend requested…');
      continue;
    }

    if (cmd === '/replay') {
      const parsedReplay = parseReplayRequest(args);
      if (parsedReplay.error) {
        await send(cfg, `❌ ${parsedReplay.error}\n${REPLAY_USAGE}`);
        continue;
      }
      state.flags ||= {};
      state.flags.runReplay = parsedReplay.req;
      await send(cfg, `⏳ Replay queued (preset=${parsedReplay.req.preset}, days=${parsedReplay.req.days})…`);
      continue;
    }

    if (cmd === '/optimize') {
      const parsedOptimize = parseOptimizeRequest(args);
      if (parsedOptimize.error) {
        await send(cfg, `❌ ${parsedOptimize.error}\n${OPTIMIZE_USAGE}`);
        continue;
      }
      state.flags ||= {};
      state.flags.runOptimize = parsedOptimize.req;
      await send(
        cfg,
        `⏳ Optimizer queued (preset=${parsedOptimize.req.preset}, days=${parsedOptimize.req.days}, top=${parsedOptimize.req.top})…`
      );
      continue;
    }

    if (cmd === '/health') {
      state.flags ||= {};
      state.flags.sendHealth = true;
      await send(cfg, '⏳ Health requested…');
      continue;
    }

    if (cmd === '/diagfull') {
      if (typeof onDiagRequest === 'function') {
        await send(cfg, '⏳ full diag requested… working on it.');
        setTimeout(async () => {
          try { onDiagRequest('full', null); } catch (e) { await send(cfg, `Diag request failed: ${safeErr(e).message}`); }
        }, 0);
      } else {
        state.flags ||= {};
        state.flags.sendDiag = true;
        state.flags.sendDiagMode = 'full';
        state.flags.sendDiagWindowHours = null;
        await send(cfg, '⏳ full diag requested…');
      }
      continue;
    }

    if (cmd === '/diagmomentum') {
      if (typeof onDiagRequest === 'function') {
        await send(cfg, '⏳ momentum diag requested… working on it.');
        setTimeout(async () => {
          try { onDiagRequest('momentum', null); } catch (e) { await send(cfg, `Diag request failed: ${safeErr(e).message}`); }
        }, 0);
      } else {
        state.flags ||= {};
        state.flags.sendDiag = true;
        state.flags.sendDiagMode = 'momentum';
        state.flags.sendDiagWindowHours = null;
        await send(cfg, '⏳ momentum diag requested…');
      }
      continue;
    }

    if (cmd === '/diagconfirm') {
      if (typeof onDiagRequest === 'function') {
        await send(cfg, '⏳ confirm diag requested… working on it.');
        setTimeout(async () => {
          try { onDiagRequest('confirm', null); } catch (e) { await send(cfg, `Diag request failed: ${safeErr(e).message}`); }
        }, 0);
      } else {
        state.flags ||= {};
        state.flags.sendDiag = true;
        state.flags.sendDiagMode = 'confirm';
        state.flags.sendDiagWindowHours = null;
        await send(cfg, '⏳ confirm diag requested…');
      }
      continue;
    }

    if (cmd === '/diagexecution') {
      if (typeof onDiagRequest === 'function') {
        await send(cfg, '⏳ execution diag requested… working on it.');
        setTimeout(async () => {
          try { onDiagRequest('execution', null); } catch (e) { await send(cfg, `Diag request failed: ${safeErr(e).message}`); }
        }, 0);
      } else {
        state.flags ||= {};
        state.flags.sendDiag = true;
        state.flags.sendDiagMode = 'execution';
        state.flags.sendDiagWindowHours = null;
        await send(cfg, '⏳ execution diag requested…');
      }
      continue;
    }

    if (cmd === '/diag') {
      const usage = [
        'Usage:',
        '• /diag',
        '• /diag <hours>',
        '• /diag full',
        '• /diag full <hours>',
        '• /diag momentum',
        '• /diag momentum <hours>',
        '• /diag confirm',
        '• /diag confirm <hours>',
        '• /diag execution',
        '• /diag execution <hours>',
        '• /diag scanner',
        '• /diag scanner <hours>',
        'Examples:',
        '• /diag 1',
        '• /diag 0.5',
        '• /diag momentum 3',
        '• /diag confirm 1',
        '• /diag execution 0.5',
        '• /diag scanner 6',
        '• /diag full 24',
      ].join('\n');

      const a0 = String(args?.[0] || '').trim().toLowerCase();
      const a1 = String(args?.[1] || '').trim().toLowerCase();
      let diagMode = 'compact';
      let hoursArg = null;

      if (a0 === 'full' || a0 === 'momentum' || a0 === 'confirm' || a0 === 'execution' || a0 === 'scanner') {
        diagMode = a0;
        hoursArg = a1 || null;
      } else if (a0) {
        hoursArg = a0;
      }

      let windowHours = null;
      if (hoursArg != null && hoursArg !== '') {
        const n = Number(hoursArg);
        if (!Number.isFinite(n) || n <= 0) {
          await send(cfg, usage);
          continue;
        }
        windowHours = n;
      }

      if (typeof onDiagRequest === 'function') {
        await send(cfg, `⏳ ${diagMode} diag requested${windowHours ? ` (${windowHours}h)` : ''}… working on it.`);
        setTimeout(async () => {
          try {
            onDiagRequest(diagMode, windowHours);
          } catch (e) {
            await send(cfg, `Diag request failed: ${safeErr(e).message}`);
          }
        }, 0);
      } else {
        state.flags ||= {};
        state.flags.sendDiag = true;
        state.flags.sendDiagMode = diagMode;
        state.flags.sendDiagWindowHours = windowHours;
        await send(cfg, `⏳ ${diagMode} diag requested${windowHours ? ` (${windowHours}h)` : ''}…`);
      }
      continue;
    }

    if (cmd === '/mode') {
      state.flags ||= {};
      state.flags.sendMode = true;
      await send(cfg, '⏳ Mode requested…');
      continue;
    }

    if (cmd === '/config') {
      state.flags ||= {};
      state.flags.sendConfig = true;
      await send(cfg, '⏳ Config requested…');
      continue;
    }

    if (cmd === '/why') {
      const target = String(args?.[0] || '').trim();
      if (!target) {
        await send(cfg, 'Usage: /why <symbol|mint>');
        continue;
      }
      state.flags ||= {};
      state.flags.sendWhy = target;
      await send(cfg, `⏳ Looking up latest rejection for ${target}…`);
      continue;
    }

    await send(cfg, UNKNOWN_COMMAND);
  }
}
