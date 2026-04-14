#!/usr/bin/env node
import { formatLifecycleSummary, summarizeTradeLifecycle } from '../../src/trade_lifecycle_analytics.mjs';

function parseArgs(argv) {
  const args = {
    paperFile: './state/paper_trades.jsonl',
    stateFile: './state/state.json',
    attemptsFile: './state/paper_live_attempts.jsonl',
    labelsFile: './state/outcome_labels/labels.jsonl',
    sinceHours: null,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--paper-file') args.paperFile = argv[++i];
    else if (a === '--state-file') args.stateFile = argv[++i];
    else if (a === '--attempts-file') args.attemptsFile = argv[++i];
    else if (a === '--labels-file') args.labelsFile = argv[++i];
    else if (a === '--since-hours') args.sinceHours = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        'Usage: trade_lifecycle_summary.mjs [--paper-file path] [--state-file path] [--attempts-file path] [--labels-file path] [--since-hours H] [--json]',
        '',
        'Builds lifecycle analytics for closed paper/live trades and buckets performance by:',
        '- entry quality',
        '- hold time',
        '- exit reason',
        '- slippage (or volatility proxy when explicit slippage is unavailable)',
      ].join('\n'));
      process.exit(0);
    }
  }

  return args;
}

const args = parseArgs(process.argv);
const summary = summarizeTradeLifecycle({
  paperTradesPath: args.paperFile,
  attemptsPath: args.attemptsFile,
  labelsPath: args.labelsFile,
  statePath: args.stateFile,
  sinceHours: args.sinceHours,
});

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(formatLifecycleSummary(summary));
}
