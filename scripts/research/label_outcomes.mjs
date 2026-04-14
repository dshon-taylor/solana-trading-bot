#!/usr/bin/env node
import { buildOutcomeLabels, writeOutcomeLabels } from '../../src/outcome_labeler.mjs';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const candidateDir = getArg('--candidate-dir', './state/candidates');
const trackDir = getArg('--track-dir', './state/track');
const paperTradesPath = getArg('--paper-trades', './state/paper_trades.jsonl');
const outDir = getArg('--out-dir', './state/outcome_labels');
const asJson = process.argv.includes('--json');

const labels = buildOutcomeLabels({ candidateDir, trackDir, paperTradesPath });
const res = writeOutcomeLabels({ outDir, labels });

if (asJson) {
  console.log(
    JSON.stringify(
      {
        config: { candidateDir, trackDir, paperTradesPath, outDir },
        ...res,
      },
      null,
      2
    )
  );
} else {
  console.log('=== Outcome labeling ===');
  console.log(`candidateDir=${candidateDir}`);
  console.log(`trackDir=${trackDir}`);
  console.log(`paperTrades=${paperTradesPath}`);
  console.log(`outDir=${outDir}`);
  console.log(`labels=${labels.length} withOutcome=${res.summary.withOutcome}`);
  console.log(`classCounts=${JSON.stringify(res.summary.classCounts)}`);
  console.log(`sourceCounts=${JSON.stringify(res.summary.sourceCounts)}`);
  console.log(`wrote: ${res.jsonlPath}`);
  console.log(`wrote: ${res.summaryPath}`);
}
