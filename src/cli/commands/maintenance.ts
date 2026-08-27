import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'maintenance' command to execute maintenance routines.
 *
 * @param storage - Instantiated Storage engine (used if offline).
 * @param positionalArgs - Positional CLI arguments (e.g. ['maintenance', 'checkpoint', 'my-table']).
 * @param dir - Data directory.
 */
export async function handleMaintenanceCommand(
  storage: Storage,
  positionalArgs: string[],
  dir = '.data',
): Promise<void> {
  const action = positionalArgs[1];
  const targetTable = positionalArgs[2];
  const lock = readServerLock(dir);
  const admin = lock?.adminSecret
    ? new AdminClient(lock.port, lock.host, lock.adminSecret)
    : null;

  if (!action) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Missing maintenance action. Expected "checkpoint", "vacuum", or "prune"',
    );
  }

  switch (action) {
    case 'checkpoint': {
      const result = admin
        ? await admin.runMaintenance('checkpoint', undefined, targetTable)
        : await storage.checkpoint(targetTable);
      console.log(result.message);
      break;
    }

    case 'vacuum': {
      const result = admin
        ? await admin.runMaintenance('vacuum')
        : await storage.vacuum();
      console.log(result.message);
      break;
    }

    case 'prune': {
      const keepStr = positionalArgs[3];
      const keepCount = keepStr ? Number.parseInt(keepStr, 10) : undefined;
      const result = admin
        ? await admin.runMaintenance('prune', keepCount, targetTable)
        : await storage.prune(keepCount, targetTable);
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
