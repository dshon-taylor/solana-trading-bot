import { openaiJson, clamp } from './ai.mjs';

export function getModels(cfg, state) {
  return {
    preprocess: state.modelOverrides?.preprocess ?? cfg.MODEL_PREPROCESS,
    analyze: state.modelOverrides?.analyze ?? cfg.MODEL_ANALYZE,
    gatekeeper: state.modelOverrides?.gatekeeper ?? cfg.MODEL_GATEKEEPER,
  };
}

export async function preprocessCandidate({ model, candidate }) {
  const system = 'You extract structured signals for a Solana trading bot. Output only JSON.';
  const user = [
    'Return ONLY JSON:',
    '{"ok":true|false,"reasons":["..."],"signals":{"momentum":true|false,"liqUsd":number,"mcapUsd":number,"ageHours":number,"rugScore":number}}',
    '',
    'Candidate:',
    JSON.stringify(candidate),
  ].join('\n');
  const { json, usage } = await openaiJson({ model, system, user, maxOutputTokens: 500, retries: 2 });
  return { json, usage };
}

export async function analyzeTrade({ model, context }) {
  const system = 'You decide whether to trade. Output only JSON. Be conservative.';
  const user = [
    'Return ONLY JSON:',
    '{"decision":"TRADE"|"NO_TRADE","sizeMultiplier":number,"slippageBps":number,"note":"..."}',
    'Constraints:',
    '- sizeMultiplier between 0.1 and 1.1',
    '- slippageBps between 50 and 400',
    '',
    'Context:',
    JSON.stringify(context),
  ].join('\n');
  const out = await openaiJson({ model, system, user, maxOutputTokens: 700, retries: 2 });
  out.sizeMultiplier = clamp(out.sizeMultiplier ?? 1.0, 0.1, 1.1);
  out.slippageBps = Math.round(clamp(out.slippageBps ?? 250, 50, 400));
  return out;
}

export async function gatekeep({ model, context }) {
  const system = 'You are the final gatekeeper before a real trade. Output only JSON. Prefer rejecting if uncertain.';
  const user = [
    'Return ONLY JSON:',
    '{"decision":"APPROVE"|"REJECT","sizeMultiplier":number,"slippageBps":number,"note":"..."}',
    'Constraints:',
    '- sizeMultiplier between 0.1 and 1.1 (can increase up to +10%)',
    '- slippageBps between 50 and 400',
    '',
    'Context:',
    JSON.stringify(context),
  ].join('\n');
  const out = await openaiJson({ model, system, user, maxOutputTokens: 700, retries: 2 });
  out.sizeMultiplier = clamp(out.sizeMultiplier ?? 1.0, 0.1, 1.1);
  out.slippageBps = Math.round(clamp(out.slippageBps ?? 250, 50, 400));
  return out;
}
