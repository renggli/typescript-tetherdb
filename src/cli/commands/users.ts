import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'users' command family (list, add, rm).
 *
 * @param storage - Instantiated Storage engine (used if offline).
 * @param args - Positional arguments: `[command, action, arg1, arg2]`.
 * @param dir - Data directory.
 */
export async function handleUsersCommand(
  storage: Storage,
  [, action = 'list', arg1, arg2]: string[],
  dir = '.data',
): Promise<void> {
  const lock = readServerLock(dir);
  const admin = lock?.adminSecret
    ? new AdminClient(lock.port, lock.host, lock.adminSecret)
    : null;

  if (action === 'list') {
    if (admin) {
      const users = await admin.getUsers();
      printUsers(users);
    } else {
      const users = await storage.getUsers();
      printUsers(
        users.map((u) => ({
          id: u.id,
          username: u.username,
          createdAt: u.createdAt,
        })),
      );
    }
  } else if (action === 'add' || action === 'create') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing username',
      );
    }
    if (!arg2) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing password',
      );
    }
    if (admin) {
      const user = await admin.createUser(arg1, arg2);
      console.log(`Created user: [${user.id}] ${user.username}`);
    } else {
      const user = await storage.createUser(arg1, arg2);
      console.log(`Created user: [${user.id}] ${user.username}`);
    }
  } else if (action === 'rm' || action === 'delete') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing user ID',
      );
    }
    if (admin) {
      await admin.deleteUser(arg1);
      console.log(`Deleted user: ${arg1}`);
    } else {
      const user = await storage.getUser(arg1);
      if (!user) {
        console.log(`User not found: ${arg1}`);
      } else {
        await user.delete();
        console.log(`Deleted user: ${arg1}`);
      }
    }
  } else {
    throw new TetherServerError(
      TetherServerErrorCode.ConfigurationError,
      `Unknown users action: "${action}". Expected "list", "add", or "rm"`,
    );
  }
}

function printUsers(
  users: Array<{ id: string; username: string; createdAt: number }>,
): void {
  if (!users.length) {
    console.log('No registered users found.');
    return;
  }
  console.log(`Registered users (${users.length}):`);
  for (const u of users) {
    console.log(
      `  • [${u.id}] ${u.username} (created: ${new Date(u.createdAt).toISOString()})`,
    );
  }
}
