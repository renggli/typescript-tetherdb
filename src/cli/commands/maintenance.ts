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
      // CLI may pass ['maintenance', 'prune', keepCount] or ['maintenance', 'prune', tableName, keepCount]
      let keepStr: string | undefined;
      if (positionalArgs[3] !== undefined) {
        keepStr = positionalArgs[3];
      } else if (positionalArgs[2] !== undefined) {
        keepStr = positionalArgs[2];
      }
      let keepCount: number | undefined;
      if (keepStr !== undefined) {
        keepCount = Number.parseInt(keepStr, 10);
        if (!Number.isFinite(keepCount) || keepCount < 0) {
          throw new TetherServerError(
            TetherServerErrorCode.InvalidInput,
            `Invalid keep count: "${keepStr}". Expected a non-negative integer`,
          );
        }
      }
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
