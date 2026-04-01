import { saveState } from '../../persistence/state.mjs';
import { handlePositionsCommands } from './stage_positions_commands.mjs';
import { handleStatusCommands } from './stage_status_commands.mjs';
import { handleConfigFilterCommands } from './stage_config_filter_commands.mjs';
import { handleDiagReplayCommands } from './stage_diag_replay_commands.mjs';
export { bootstrapOperatorSurfaces } from './stage_bootstrap.mjs';

export function createOperatorSurfaces(context) {
  async function processOperatorCommands(t) {
    const { cfg, state } = context;

    if (state.flags?.saveStateNow) {
      state.flags.saveStateNow = false;
      saveState(cfg.STATE_PATH, state);
    }

    await handlePositionsCommands({ ...context, t });
    await handleStatusCommands({ ...context, t });
    await handleConfigFilterCommands({ ...context, t });
    await handleDiagReplayCommands({ ...context, t });
  }

  return { processOperatorCommands };
}
