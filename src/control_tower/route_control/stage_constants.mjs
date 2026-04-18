const AGGRESSIVE_BOOT_MODE = (process.env.AGGRESSIVE_MODE ?? 'false') === 'true';
const NO_PAIR_RETRY_ATTEMPTS = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS || 5));
export const NO_PAIR_RETRY_BASE_MS = Math.max(50, Number(process.env.NO_PAIR_RETRY_BASE_MS || (AGGRESSIVE_BOOT_MODE ? 90 : 200)));
export const NO_PAIR_RETRY_MAX_BACKOFF_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_MAX_BACKOFF_MS || (AGGRESSIVE_BOOT_MODE ? 900 : 4_000)));
export const NO_PAIR_RETRY_TOTAL_BUDGET_MS = Math.max(NO_PAIR_RETRY_BASE_MS, Number(process.env.NO_PAIR_RETRY_TOTAL_BUDGET_MS || (AGGRESSIVE_BOOT_MODE ? 1_500 : 6_000)));
const NO_PAIR_RETRY_ATTEMPTS_CAP = Math.max(1, Number(process.env.NO_PAIR_RETRY_ATTEMPTS_CAP || 10));

export const NO_PAIR_TEMP_TTL_MS = Math.max(5_000, Number(process.env.NO_PAIR_TEMP_TTL_MS || (AGGRESSIVE_BOOT_MODE ? 40_000 : 120_000)));
export const NO_PAIR_TEMP_TTL_ROUTEABLE_MS = Math.max(10_000, Number(process.env.NO_PAIR_TEMP_TTL_ROUTEABLE_MS || (AGGRESSIVE_BOOT_MODE ? 18_000 : 45_000)));
export const NO_PAIR_NON_TRADABLE_TTL_MS = Math.max(NO_PAIR_TEMP_TTL_MS, Number(process.env.NO_PAIR_NON_TRADABLE_TTL_MS || 20 * 60_000));
export const NO_PAIR_DEAD_MINT_TTL_MS = Math.max(NO_PAIR_NON_TRADABLE_TTL_MS, Number(process.env.NO_PAIR_DEAD_MINT_TTL_MS || 90 * 60_000));
export const NO_PAIR_REVISIT_MIN_MS = Math.max(150, Number(process.env.NO_PAIR_REVISIT_MIN_MS || (AGGRESSIVE_BOOT_MODE ? 450 : 1_500)));
export const NO_PAIR_REVISIT_MAX_MS = Math.max(NO_PAIR_REVISIT_MIN_MS, Number(process.env.NO_PAIR_REVISIT_MAX_MS || (AGGRESSIVE_BOOT_MODE ? 120_000 : 6 * 60_000)));
export const NO_PAIR_DEAD_MINT_STRIKES = Math.max(2, Number(process.env.NO_PAIR_DEAD_MINT_STRIKES || 3));

export const JUP_ROUTE_FIRST_ENABLED = (process.env.JUP_ROUTE_FIRST_ENABLED ?? 'true') === 'true';
export const JUP_SOURCE_PREFLIGHT_ENABLED = (process.env.JUP_SOURCE_PREFLIGHT_ENABLED ?? 'true') === 'true';

export function effectiveNoPairRetryAttempts() {
  return Math.max(1, Math.min(NO_PAIR_RETRY_ATTEMPTS, NO_PAIR_RETRY_ATTEMPTS_CAP));
}
