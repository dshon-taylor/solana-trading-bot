import { safeErr } from '../observability/logger.mjs';
import { TELEGRAM_COMMANDS } from './commands.mjs';

const tgRetryQueue = [];
let tgRetryTimer = null;
const TG_RETRY_MAX_ATTEMPTS = 6;
const TG_RETRY_BASE_MS = 10_000;
const TG_RETRY_MAX_MS = 120_000;
const TG_RETRY_QUEUE_MAX = 200;

// Telegram is very aggressive about rate limits; when we get 429, we should stop
// trying for the suggested retry window, otherwise we can spam stderr forever.
let tgCooldownUntilMs = 0;
let lastCooldownLogMs = 0;
let lastSkipLogMs = 0;

function logCooldownOncePerMinute(msg) {
  const now = Date.now();
  if (now - lastCooldownLogMs < 60_000) return;
  lastCooldownLogMs = now;
  console.warn('[telegram]', msg);
}

function logSkipOncePerHour(msg) {
  const now = Date.now();
  if (now - lastSkipLogMs < 60 * 60_000) return;
  lastSkipLogMs = now;
  console.warn('[telegram]', msg);
}

function parseTelegramErrorFromText(t) {
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function parseRetryAfterSecondsFromTelegramError(j) {
  const v = j?.parameters?.retry_after;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ensureRetryLoop(cfg) {
  if (tgRetryTimer) return;
  tgRetryTimer = setInterval(async () => {
    if (!tgRetryQueue.length) return;
    const now = Date.now();
    const due = tgRetryQueue.filter((x) => Number(x?.nextAtMs || 0) <= now);
    if (!due.length) return;
    for (const item of due.slice(0, 5)) {
      const idx = tgRetryQueue.indexOf(item);
      if (idx < 0) continue;
      const ok = await tgSend(cfg, item.text, { fromRetryQueue: true });
      if (ok) {
        tgRetryQueue.splice(idx, 1);
      } else {
        item.attempt = Number(item.attempt || 0) + 1;
        if (item.attempt >= TG_RETRY_MAX_ATTEMPTS) {
          tgRetryQueue.splice(idx, 1);
        } else {
          const backoff = Math.min(TG_RETRY_MAX_MS, TG_RETRY_BASE_MS * (2 ** Math.max(0, item.attempt - 1)));
          item.nextAtMs = Date.now() + backoff;
        }
      }
    }
  }, 2_000);
  tgRetryTimer.unref?.();
}

function enqueueRetry(cfg, text) {
  if (!text) return;
  if (tgRetryQueue.length >= TG_RETRY_QUEUE_MAX) tgRetryQueue.shift();
  tgRetryQueue.push({ text, attempt: 0, nextAtMs: Date.now() + TG_RETRY_BASE_MS });
  ensureRetryLoop(cfg);
}

export async function tgSend(cfg, text, opts = {}) {
  if (!cfg?.TELEGRAM_BOT_TOKEN || !cfg?.TELEGRAM_CHAT_ID) return false;

  const fromRetryQueue = !!opts?.fromRetryQueue;
  const now = Date.now();
  if (now < tgCooldownUntilMs) {
    logSkipOncePerHour(
      `cooldown active; skipping send for ${Math.ceil((tgCooldownUntilMs - now) / 1000)}s`
    );
    if (!fromRetryQueue) enqueueRetry(cfg, text);
    return false;
  }

  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: cfg.TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) return true;

    // Read the error body ONCE. Some Telegram 429 responses have odd headers and can
    // make res.json() unreliable; parsing from text is more robust.
    const t = await res.text().catch(() => '');
    const j = parseTelegramErrorFromText(t);

    // 429: enter cooldown even if we cannot parse retry_after (use a safe default).
    // NOTE: In rare cases the HTTP status can be something other than 429 while the
    // body still contains { error_code: 429, parameters: { retry_after } }.
    const isRateLimit = res.status === 429 || j?.error_code === 429;
    if (isRateLimit) {
      const retryAfterSec = parseRetryAfterSecondsFromTelegramError(j) ?? 60;
      // Give it a small cushion (Telegram's window can be strict).
      tgCooldownUntilMs = Date.now() + (Number(retryAfterSec) + 5) * 1000;
      logCooldownOncePerMinute(
        `rate limited (429); entering cooldown for ~${Number(retryAfterSec) + 5}s`
      );
      if (!fromRetryQueue) enqueueRetry(cfg, text);
      return false;
    }

    // Non-429 errors: log, but do not throw.
    console.error('[telegram]', {
      name: 'Error',
      message: `Telegram send failed: ${res.status} ${String(t).slice(0, 200)}`,
    });
    if (!fromRetryQueue) enqueueRetry(cfg, text);
    return false;
  } catch (e) {
    // Last resort: do not throw (we don't want alert failures to kill trading).
    console.error('[telegram]', safeErr(e));
    if (!fromRetryQueue) enqueueRetry(cfg, text);
    return false;
  }
}

export async function tgSetMyCommands(cfg) {
  // This enables Telegram's UI command picker (/ menu) for the bot.
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const body = {
    commands: TELEGRAM_COMMANDS,
  };

  // Try a few times with a short abort timeout to avoid long-hanging fetches.
  const attempts = 3;
  const baseTimeoutMs = 10_000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeoutMs = baseTimeoutMs * attempt; // small backoff
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[telegram.commands]', `setMyCommands failed (attempt ${attempt}): ${res.status} ${String(t).slice(0,200)}`);
        // If last attempt, return.
        if (attempt === attempts) return;
        // Otherwise small delay before retrying
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      // success
      return;
    } catch (e) {
      console.error('[telegram.commands]', safeErr(e));
      if (attempt === attempts) return;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    } finally {
      clearTimeout(to);
    }
  }
}
