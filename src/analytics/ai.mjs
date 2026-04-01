import { safeErr } from '../core/logger.mjs';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractText(json) {
  const direct = json.output_text;
  if (direct && String(direct).trim()) return String(direct);
  const parts = [];
  for (const item of (json.output || [])) {
    for (const c of (item.content || [])) {
      if (c.type === 'output_text' && c.text) parts.push(c.text);
      if (c.type === 'text' && c.text) parts.push(c.text);
    }
  }
  const out = parts.join('').trim();
  return out || null;
}

export function safeParseJson(text) {
  try { return { ok: true, json: JSON.parse(text) }; } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return { ok: true, json: JSON.parse(slice) }; } catch {}
  }
  return { ok: false, error: 'Could not parse JSON' };
}

export async function openaiJson({ model, system, user, maxOutputTokens = 900, retries = 3 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'text' } },
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Retry 429s.
      if (res.status === 429 && attempt < retries) {
        await sleep(400 + attempt * 800);
        continue;
      }
      throw new Error(`OpenAI error: ${res.status} ${(json?.error?.message || '').slice(0, 200)}`);
    }

    const out = extractText(json);
    if (!out) {
      if (attempt < retries) {
        await sleep(250 + attempt * 400);
        continue;
      }
      throw new Error('OpenAI returned empty text');
    }

    const parsed = safeParseJson(out);
    if (parsed.ok) return { json: parsed.json, usage: json.usage || null };

    if (attempt < retries) {
      await sleep(250 + attempt * 400);
      continue;
    }

    throw new Error('OpenAI returned non-JSON output');
  }
}

export function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function safeDecision(obj, fallback) {
  try { return obj ?? fallback; } catch { return fallback; }
}

export function safeMsg(e) {
  return safeErr(e).message;
}
