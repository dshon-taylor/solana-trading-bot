import { upsertWatchlistMint } from './stage_upsert_watchlist_mint.mjs';
import { promoteRouteAvailableCandidate } from './stage_promote_route_available.mjs';
import { evaluateWatchlistRows } from './stage_runtime_delegate.mjs';

export function createWatchlistPipeline({
  confirmQualityGate,
  confirmContinuationGate,
  recordConfirmCarryTrace,
  resolveConfirmTxMetrics,
  resolveMintCreatedAtFromRpc,
  computeMcapUsd,
  openPosition,
  wsmgr,
}) {
  return {
    upsertWatchlistMint: (args) => upsertWatchlistMint({
      ...args,
      deps: { recordConfirmCarryTrace },
    }),
    promoteRouteAvailableCandidate: (args) => promoteRouteAvailableCandidate({
      ...args,
      deps: {
        upsertWatchlistMint: (upsertArgs) => upsertWatchlistMint({ ...upsertArgs, deps: { recordConfirmCarryTrace } }),
      },
    }),
    evaluateWatchlistRows: (args) => evaluateWatchlistRows({
      args,
      deps: {
        confirmQualityGate,
        confirmContinuationGate,
        recordConfirmCarryTrace,
        resolveConfirmTxMetrics,
        resolveMintCreatedAtFromRpc,
        computeMcapUsd,
        openPosition,
        wsmgr,
      },
    }),
  };
}

export default createWatchlistPipeline;
