import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'stop' command to gracefully shut down a running TetherDB server.
 *
 * @param dir - Data directory.
 */
export async function handleStopCommand(dir = '.data'): Promise<void> {
  const lock = readServerLock(dir);
  if (!lock?.adminSecret) {
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      'No running TetherDB server found on this data directory',
    );
  }

  const admin = new AdminClient(lock.port, lock.host, lock.adminSecret);
  const result = await admin.stop();
  console.log(result.message);
}
