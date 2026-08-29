import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'users' command family (list, add, rm).
 *
 * @param target - Active administration target.
 * @param args - Positional arguments: `[command, action, arg1, arg2]`.
 */
export async function handleUsersCommand(
  target: AdminTarget,
  [, action = 'list', arg1, arg2]: string[],
): Promise<void> {
  if (action === 'list') {
    const users = await target.getUsers();
    printUsers(users);
    return;
  }

  if (action === 'add' || action === 'create') {
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
    const user = await target.createUser(arg1, arg2);
    console.log(`Created user: [${user.userId}] ${user.userName}`);
    return;
  }

  if (action === 'rm' || action === 'delete') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing user ID',
      );
    }
    await target.deleteUser(arg1);
    console.log(`Deleted user: ${arg1}`);
    return;
  }

  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Unknown users action: "${action}". Expected "list", "add", or "rm"`,
  );
}

function printUsers(
  users: Array<{
    userId: string;
    userName: string;
    createdAt: number;
  }>,
): void {
  if (!users.length) {
    console.log('No registered users found.');
    return;
  }
  console.log(`Registered users (${users.length}):`);
  for (const u of users) {
    console.log(
      `  • [${u.userId}] ${u.userName} (created: ${new Date(u.createdAt).toISOString()})`,
    );
  }
}
