const BASE = 'https://api.rugcheck.xyz';

const MAX_TOP_HOLDER_PCT = Number(process.env.MAX_TOP_HOLDER_PCT || 3.5);
const MAX_TOP10_PCT = Number(process.env.MAX_TOP10_PCT || 38);
const MAX_BUNDLE_CLUSTER_PCT = Number(process.env.MAX_BUNDLE_CLUSTER_PCT || 15);
const MAX_CREATOR_CLUSTER_PCT = Number(process.env.MAX_CREATOR_CLUSTER_PCT || 2);
const MIN_LP_LOCK_PCT = Number(process.env.MIN_LP_LOCK_PCT || 90);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getRugcheckReport(mint, { retries = 3 } = {}) {
  const url = `${BASE}/v1/tokens/${mint}/report`;
  let last;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`RugCheck report failed: ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (i === retries) break;
      await sleep(400 + i * 800);
    }
  }

  throw last;
}

function deepFindNumberByKey(obj, keyRegex, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);

  for (const [k, v] of Object.entries(obj)) {
    if (keyRegex.test(String(k))) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    if (v && typeof v === 'object') {
      const hit = deepFindNumberByKey(v, keyRegex, seen);
      if (Number.isFinite(Number(hit))) return Number(hit);
    }
  }
  return null;
}

function deepFindBoolByKey(obj, keyRegex, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);

  for (const [k, v] of Object.entries(obj)) {
    if (keyRegex.test(String(k))) {
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      if (['true', 'yes', '1', 'locked'].includes(s)) return true;
      if (['false', 'no', '0', 'unlocked'].includes(s)) return false;
    }
    if (v && typeof v === 'object') {
      const hit = deepFindBoolByKey(v, keyRegex, seen);
      if (typeof hit === 'boolean') return hit;
    }
  }
  return null;
}

function normalizePct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  // If API returns fraction (0..1), convert to percent.
  return x <= 1 ? x * 100 : x;
}

export function getConcentrationMetrics(report) {
  if (!report || typeof report !== 'object') {
    return { topHolderPct: null, top10Pct: null, bundleClusterPct: null, creatorClusterPct: null, lpLockPct: null, lpUnlocked: null };
  }

  const topHolderRaw =
    report?.topHolderPct ?? report?.top_holder_pct ?? report?.topHolderPercent ?? report?.top_holder_percent
    ?? deepFindNumberByKey(report, /top.?holder.*(pct|percent|percentage|share|ratio)/i)
    ?? deepFindNumberByKey(report, /^top1$/i);

  const top10Raw =
    report?.top10Pct ?? report?.top_10_pct ?? report?.top10Percent ?? report?.top_10_percent
    ?? deepFindNumberByKey(report, /top.?10.*(pct|percent|percentage|share|ratio)/i)
    ?? deepFindNumberByKey(report, /^top10$/i);

  const bundleRaw =
    report?.bundleClusterPct ?? report?.bundle_cluster_pct ?? report?.bundlePercent ?? report?.bundle_percent
    ?? deepFindNumberByKey(report, /bundle.*(cluster)?.*(pct|percent|percentage|share|ratio)/i)
    ?? deepFindNumberByKey(report, /sniper.*bundle.*(pct|percent|share|ratio)/i);

  const creatorRaw =
    report?.creatorClusterPct ?? report?.creator_cluster_pct ?? report?.creatorPercent ?? report?.creator_percent
    ?? deepFindNumberByKey(report, /creator.*(cluster)?.*(pct|percent|percentage|share|ratio)/i)
    ?? deepFindNumberByKey(report, /deployer.*(pct|percent|share|ratio)/i);

  const lpLockRaw =
    report?.lpLockPct ?? report?.lp_lock_pct ?? report?.liquidityLockPct ?? report?.liquidity_lock_pct
    ?? deepFindNumberByKey(report, /(lp|liquidity).*(lock|locked).*(pct|percent|percentage|share|ratio)/i);

  const lpUnlockedRaw =
    report?.lpUnlocked ?? report?.lp_unlocked
    ?? deepFindBoolByKey(report, /(lp|liquidity).*(unlock|unlocked)/i);

  return {
    topHolderPct: normalizePct(topHolderRaw),
    top10Pct: normalizePct(top10Raw),
    bundleClusterPct: normalizePct(bundleRaw),
    creatorClusterPct: normalizePct(creatorRaw),
    lpLockPct: normalizePct(lpLockRaw),
    lpUnlocked: (typeof lpUnlockedRaw === 'boolean') ? lpUnlockedRaw : null,
  };
}

export function isTokenSafe(report) {
  // Conservative rules. If we're unsure, reject.
  if (!report) return { ok: false, reason: 'no report' };
  if (report.rugged) return { ok: false, reason: 'rugged=true' };

  // If mint or freeze authority exists, treat as elevated risk.
  // Some legit tokens may have these; we can relax later.
  if (report.mintAuthority) return { ok: false, reason: 'mintAuthority present' };
  if (report.freezeAuthority) return { ok: false, reason: 'freezeAuthority present' };

  // score_normalised seems higher=better. If missing, reject.
  const score = report.score_normalised;
  if (typeof score !== 'number') return { ok: false, reason: 'missing score_normalised' };
  if (score < 60) return { ok: false, reason: `score_normalised<60 (${score})` };

  const conc = getConcentrationMetrics(report);
  if (conc.topHolderPct != null && conc.topHolderPct > MAX_TOP_HOLDER_PCT) return { ok: false, reason: `topHolder>${MAX_TOP_HOLDER_PCT}% (${conc.topHolderPct.toFixed(2)}%)`, concentration: conc };
  if (conc.top10Pct != null && conc.top10Pct > MAX_TOP10_PCT) return { ok: false, reason: `top10>${MAX_TOP10_PCT}% (${conc.top10Pct.toFixed(2)}%)`, concentration: conc };
  if (conc.bundleClusterPct != null && conc.bundleClusterPct > MAX_BUNDLE_CLUSTER_PCT) return { ok: false, reason: `bundleCluster>${MAX_BUNDLE_CLUSTER_PCT}% (${conc.bundleClusterPct.toFixed(2)}%)`, concentration: conc };
  if (conc.creatorClusterPct != null && conc.creatorClusterPct > MAX_CREATOR_CLUSTER_PCT) return { ok: false, reason: `creatorCluster>${MAX_CREATOR_CLUSTER_PCT}% (${conc.creatorClusterPct.toFixed(2)}%)`, concentration: conc };
  if (conc.lpUnlocked === true) return { ok: false, reason: 'lpUnlocked=true', concentration: conc };
  if (conc.lpLockPct != null && conc.lpLockPct < MIN_LP_LOCK_PCT) return { ok: false, reason: `lpLock<${MIN_LP_LOCK_PCT}% (${conc.lpLockPct.toFixed(2)}%)`, concentration: conc };

  return { ok: true, reason: 'ok', concentration: conc };
}
