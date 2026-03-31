export function buildExecutionDiagMessage(ctx) {
  const {
    windowHeaderLabel,
    fmtCt,
    effectiveWindowStartMs,
    updatedIso,
    elapsedHours,
    warmingUp,
    lastAttemptAgeSec,
    circuitOpen,
    circuitOpenReason,
    circuitOpenSinceMs,
    circuitOpenRemainingSec,
    hourAttemptReached,
    hourAttemptPassed,
    hourFill,
    hourSwapFailed,
    cumAttemptReached,
    cumAttemptPassed,
    cumFill,
    cumSwapFailed,
    attemptPassRate,
    fillFromAttemptRate,
    fillFromConfirmRate,
    cumConfirmPassed,
    topExecutionBlockers,
    medianLocal,
    quoteToSendMs,
    sendToFillMs,
    totalAttemptToFillMs,
    realizedSlippageBps,
    quotedPriceImpactPct,
    fmtMed,
    entryLiq,
    entryMcap,
    entryPi,
    entrySlip,
    routeMixStr,
    topHandoffBlocker,
    failedAttemptsCompact,
    filledAttemptsCompact,
    swapErrSummary,
    missingDecimalsN,
    reserveBlockedN,
    targetUsdTooSmallN,
  } = ctx;

  const lines = [
    `🧪 *Diag (execution)* window=${windowHeaderLabel} start=${fmtCt(effectiveWindowStartMs)}`,
    'HEADER',
    `snapshotAt=${updatedIso} windowHours=${elapsedHours.toFixed(2)} status=${warmingUp ? 'warming_up' : 'ready'} lastAttemptAgeSec=${lastAttemptAgeSec}`,
  ];
  if (circuitOpen) {
    lines.push(`circuit: open=true reason=${circuitOpenReason} since=${circuitOpenSinceMs ? fmtCt(circuitOpenSinceMs) : 'n/a'} cooldownRemainingSec=${circuitOpenRemainingSec}`);
  }
  lines.push('',
    'FLOW',
    `- lastHour: attemptReached=${hourAttemptReached} attemptPassed=${hourAttemptPassed} fill=${hourFill} swapFailed=${hourSwapFailed}`,
    `- cumulative: attemptReached=${cumAttemptReached} attemptPassed=${cumAttemptPassed} fill=${cumFill} swapFailed=${cumSwapFailed}`,
    `- attemptPassRate=${cumAttemptPassed}/${cumAttemptReached || 0} (${(attemptPassRate*100).toFixed(1)}%)`,
    `- fillFromAttemptRate=${cumFill}/${cumAttemptReached || 0} (${(fillFromAttemptRate*100).toFixed(1)}%)`,
    `- fillFromConfirmRate=${cumFill}/${cumConfirmPassed || 0} (${(fillFromConfirmRate*100).toFixed(1)}%)`,
    '',
    'EXECUTION BLOCKERS',
    ...(topExecutionBlockers.length ? topExecutionBlockers : ['- none']),
    '',
    'FILL QUALITY',
    `- median quoteToSendMs=${fmtMed(medianLocal(quoteToSendMs),0)}`,
    `- median sendToFillMs=${fmtMed(medianLocal(sendToFillMs),0)}`,
    `- median totalAttemptToFillMs=${fmtMed(medianLocal(totalAttemptToFillMs),0)}`,
    `- median realizedSlippageBps=${fmtMed(medianLocal(realizedSlippageBps),1)}`,
    `- median quotedPriceImpactPct=${fmtMed(medianLocal(quotedPriceImpactPct),4)}`,
    '',
    'ATTEMPT SHAPE',
    `- median entry liq=${fmtMed(medianLocal(entryLiq),0)}`,
    `- median entry mcap=${fmtMed(medianLocal(entryMcap),0)}`,
    `- median entry priceImpactPct=${fmtMed(medianLocal(entryPi),4)}`,
    `- median entry slippageBps=${fmtMed(medianLocal(entrySlip),0)}`,
    `- routeSourceMix=${routeMixStr}`,
    '',
    'HANDOFF SUMMARY',
    `- confirmPassed=${cumConfirmPassed} attemptReached=${cumAttemptReached} fill=${cumFill} topHandoffBlocker=${topHandoffBlocker}`,
    '',
    'TOP EXAMPLES',
    '- strongest failed attempts:',
    ...(failedAttemptsCompact.length ? failedAttemptsCompact : ['- none']),
    '- strongest filled attempts:',
    ...(filledAttemptsCompact.length ? filledAttemptsCompact : ['- none'])
  );

  if (swapErrSummary.length) {
    lines.push('', 'SWAP/PREFLIGHT ERRORS', ...swapErrSummary);
  }
  if (missingDecimalsN > 0) lines.push(`- missingDecimals=${missingDecimalsN}`);
  if (reserveBlockedN > 0) lines.push(`- reserveBlocked=${reserveBlockedN}`);
  if (targetUsdTooSmallN > 0) lines.push(`- targetUsdTooSmall=${targetUsdTooSmallN}`);

  return lines.join('\n');
}
