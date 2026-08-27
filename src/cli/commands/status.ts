import type { Storage } from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'status' command to display storage backend statistics.
 *
 * @param storage - Instantiated Storage engine (used if offline).
 * @param positionalArgs - Positional CLI arguments.
 * @param dir - Data directory.
 */
export async function handleStatusCommand(
  storage: Storage,
  _positionalArgs: string[],
  dir = '.data',
): Promise<void> {
  const lock = readServerLock(dir);
  if (lock?.adminSecret) {
    const admin = new AdminClient(lock.port, lock.host, lock.adminSecret);
    const status = await admin.getStatus();
    printStatus(status, lock);
    return;
  }

  const status = await storage.getStatus();
  printStatus(status, lock);
}

function printStatus(
  status: import('../../server/storage/storage.js').StorageStatus,
  lock: import('../../server/lock.js').ServerLockInfo | null,
): void {
  console.log('TetherDB Storage Status:');
  console.log(`  Backend:     ${status.backend}`);
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

  if (status.tables && status.tables.length > 0) {
    console.log('\nTables:');
    for (const t of status.tables) {
      console.log(
        `  • ${t.name} (read: ${t.read}, records: ${t.recordsCount})`,
      );
    }
  }
}
