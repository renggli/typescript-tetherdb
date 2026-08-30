import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'maintenance' command to execute maintenance routines.
 *
 * @param target - Active administration target.
 * @param positionalArgs - Positional CLI arguments (e.g. ['maintenance', 'checkpoint', 'my-table']).
 */
export async function handleMaintenanceCommand(
  target: AdminTarget,
  positionalArgs: string[],
): Promise<void> {
  const action = positionalArgs[1];

  if (!action) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Missing maintenance action. Expected "checkpoint", "vacuum", or "prune"',
    );
  }

  switch (action) {
    case 'checkpoint': {
      const result = await target.checkpoint();
      console.log(result.message);
      break;
    }

    case 'vacuum': {
      const result = await target.vacuum();
      console.log(result.message);
      break;
    }

    case 'prune': {
      const keepStr = positionalArgs[2];
      const keepCount = keepStr ? Number.parseInt(keepStr, 10) : undefined;
      const result = await target.prune(keepCount);
      console.log(result.message);
      break;
    }

    default:
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        `Unknown maintenance action: "${action}". Expected "checkpoint", "vacuum", or "prune"`,
      );
  }
}
