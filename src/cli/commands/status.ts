import type { StorageStatus } from '../../server/index.js';
import type { ServerLockInfo } from '../../server/shared/lock.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'status' command to display storage backend statistics.
 *
 * @param target - Active administration target.
 * @param _positionalArgs - Positional CLI arguments.
 * @param lock - Server lock info if connected to a running server.
 */
export async function handleStatusCommand(
  target: AdminTarget,
  _positionalArgs: string[] = [],
  lock: ServerLockInfo | null = null,
): Promise<StorageStatus> {
  const status = await target.getStatus();
  printStatus(status, lock);
  return status;
}

function printStatus(status: StorageStatus, lock: ServerLockInfo | null): void {
  console.log('TetherDB Storage Status:');
  console.log(`  Type:        ${status.type}`);
  if (status.baseDir) {
    console.log(`  Directory:   ${status.baseDir}`);
  }
  if (lock) {
    console.log(
      `  Server:      Running (PID: ${lock.pid}, Port: ${lock.port}, Host: ${lock.host})`,
    );
  } else {
    console.log('  Server:      Stopped');
  }
  console.log(`  Users:       ${status.usersCount}`);
  console.log(`  Tables:      ${status.tablesCount}`);
}
