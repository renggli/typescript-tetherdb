import { AdminClient, decodeAdminToken } from '../../server/admin.js';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/shared/lock.js';

/**
 * Handles the 'stop' command to gracefully shut down a running TetherDB server.
 *
 * @param dir - Data directory.
 * @param token - Optional admin connection token.
 */
export async function handleStopCommand(
  dir = '.data',
  token?: string,
): Promise<void> {
  let client: AdminClient;
  if (token) {
    const { host, port, secret } = decodeAdminToken(token);
    client = new AdminClient(port, host, secret);
  } else {
    const lock = readServerLock(dir);
    if (!lock?.adminSecret) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'No running TetherDB server found on this data directory',
      );
    }
    client = new AdminClient(lock.port, lock.host, lock.adminSecret);
  }

  const result = await client.stop();
  console.log(result.message);
}
