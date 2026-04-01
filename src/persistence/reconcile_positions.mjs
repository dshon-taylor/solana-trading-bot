// Pure helpers for reconciling state positions against on-chain balances.
//
// Motivation: RPC/indexers can transiently report 0 balance; we debounce before
// marking a position as closed.

export function applyOnchainBalanceToPosition({ pos, bal, nowMs, nowIso }) {
  if (!pos || !bal) return { changed: false };

  let changed = false;

  pos.onchain ||= {};
  if (pos.onchain.amount !== bal.amount) changed = true;
  pos.onchain.amount = bal.amount;
  pos.onchain.ata = bal.ata ?? null;
  pos.onchain.source = bal.source ?? null;
  pos.onchain.fetchOk = bal.fetchOk;
  pos.onchain.checkedAt = nowIso;

  pos._zeroBalCount = pos._zeroBalCount || 0;
  pos._lastNonZeroBalAtMs = pos._lastNonZeroBalAtMs || 0;

  const entryMs = pos.entryAt ? Date.parse(pos.entryAt) : 0;
  const ageMs = entryMs ? (nowMs - entryMs) : null;

  if (bal.fetchOk && bal.amount > 0) {
    if (pos._zeroBalCount !== 0) changed = true;
    pos._zeroBalCount = 0;
    pos._lastNonZeroBalAtMs = nowMs;

    // If it was closed incorrectly, reopen.
    if (pos.status !== 'open') {
      pos.status = 'open';
      delete pos.exitAt;
      delete pos.exitReason;
      delete pos.exitTx;
      changed = true;
    }

    return { changed };
  }

  if (bal.fetchOk === false) return { changed };

  pos._zeroBalCount += 1;

  if (pos.status === 'open') {
    const oldEnough = (ageMs == null) ? true : ageMs > 2 * 60_000;
    const zeroStable = pos._zeroBalCount >= 3; // ~3 minutes at 60s cadence
    if (oldEnough && zeroStable) {
      pos.status = 'closed';
      pos.exitAt = nowIso;
      pos.exitReason = 'reconcile: onchain token balance=0 (assumed manual exit or already sold)';
      pos.exitTx = pos.exitTx || null;
      changed = true;
    }
  }

  return { changed };
}
