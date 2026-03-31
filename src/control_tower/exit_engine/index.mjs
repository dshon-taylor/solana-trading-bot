import { closePosition } from './stage_close_position.mjs';
import { updateStops } from './stage_update_stops.mjs';

export function createExitEngine({ getSolUsdPrice }) {
  async function closePositionBound(cfg, conn, wallet, state, mint, pair, reason) {
    return closePosition({ getSolUsdPrice, cfg, conn, wallet, state, mint, pair, reason });
  }

  async function updateStopsBound(cfg, state, mint, priceUsd) {
    return updateStops({ cfg, state, mint, priceUsd });
  }

  return {
    closePosition: closePositionBound,
    updateStops: updateStopsBound,
  };
}

export default createExitEngine;
