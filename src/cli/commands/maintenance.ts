import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';

/**
 * Handles the 'maintenance' command to execute maintenance routines.
 *
 * @param storage - Instantiated Storage engine.
 * @param positionalArgs - Positional CLI arguments (e.g. ['maintenance', 'checkpoint', 'my-app']).
 */
export async function handleMaintenanceCommand(
  storage: Storage,
  positionalArgs: string[],
): Promise<void> {
  const action = positionalArgs[1];
  const appId = positionalArgs[2];

  if (!action) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Missing maintenance action. Expected "checkpoint", "vacuum", or "prune".',
    );
  }

  switch (action) {
    case 'checkpoint': {
      const result = await storage.checkpoint(appId);
      console.log(result.message);
      break;
    }

    case 'vacuum': {
      const result = await storage.vacuum(appId);
      console.log(result.message);
      break;
    }

    case 'prune': {
      const keepStr = positionalArgs[3];
      const keepCount = keepStr ? Number.parseInt(keepStr, 10) : undefined;
      const result = await storage.prune(appId, keepCount);
      console.log(result.message);
      break;
    }

    default:
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        `Unknown maintenance action: "${action}". Expected "checkpoint", "vacuum", or "prune".`,
      );
  }
}
