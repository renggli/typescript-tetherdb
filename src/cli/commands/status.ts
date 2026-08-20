import type { Storage } from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';

/**
 * Handles the 'status' command to display storage backend statistics.
 *
 * @param storage - Instantiated Storage engine.
 * @param positionalArgs - Positional CLI arguments (e.g. ['status', 'my-app']).
 */
export async function handleStatusCommand(
  storage: Storage,
  positionalArgs: string[],
): Promise<void> {
  const appId = positionalArgs[1];
  const status = await storage.getStatus(appId);

  console.log('TetherDB Storage Status:');
  console.log(`  Backend:     ${status.backend}`);
  if (status.baseDir) {
    console.log(`  Directory:   ${status.baseDir}`);
  }
  if (status.baseDir && status.backend !== 'memory') {
    const lock = readServerLock(status.baseDir);
    if (lock) {
      console.log(
        `  Server:      Running (PID: ${lock.pid}, Port: ${lock.port}, Host: ${lock.host})`,
      );
    } else {
      console.log('  Server:      Stopped');
    }
  }
  console.log(`  Users:       ${status.usersCount}`);
  console.log(`  Total Apps:  ${status.appsCount}`);

  if (status.apps && status.apps.length > 0) {
    console.log('\nApplications:');
    for (const app of status.apps) {
      console.log(`  - App: ${app.id}`);
      console.log(
        `    Tables (${app.tables.length}): ${app.tables.join(', ') || '(none)'}`,
      );
    }
  } else if (appId) {
    console.log(`\nNo tables found for application "${appId}".`);
  }
}
