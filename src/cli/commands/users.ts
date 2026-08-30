import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'users' command family (list, add, rm, mv).
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

  if (action === 'add') {
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

  if (action === 'rm') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing username',
      );
    }
    const userId = await resolveUserId(target, arg1);
    await target.deleteUser(userId);
    console.log(`Deleted user: ${arg1}`);
    return;
  }

  if (action === 'mv') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing username',
      );
    }
    if (!arg2) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing new username',
      );
    }
    const userId = await resolveUserId(target, arg1);
    const user = await target.renameUser(userId, arg2);
    console.log(`Renamed user: [${user.userId}] ${arg1} → ${user.userName}`);
    return;
  }

  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Unknown users action: "${action}". Expected "list", "add", "rm", or "mv"`,
  );
}

/**
 * Resolves a user ID from either a direct userId or a userName lookup.
 *
 * @param target - Active administration target.
 * @param nameOrId - Username or user ID string.
 * @returns Resolved user ID.
 */
async function resolveUserId(
  target: AdminTarget,
  nameOrId: string,
): Promise<string> {
  const users = await target.getUsers();
  const byName = users.find(
    (u) => u.userName.toLowerCase() === nameOrId.toLowerCase(),
  );
  if (byName) return byName.userId;
  const byId = users.find((u) => u.userId === nameOrId);
  if (byId) return byId.userId;
  throw new TetherServerError(
    TetherServerErrorCode.NotFound,
    `User "${nameOrId}" not found`,
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
