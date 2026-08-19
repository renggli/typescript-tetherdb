import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';

/**
 * Handles the 'users' command family (list, add, rm).
 *
 * @param storage - Instantiated Storage engine.
 * @param args - Positional arguments: `[command, action, arg1, arg2]`.
 */
export async function handleUsersCommand(
  storage: Storage,
  [, action = 'list', arg1, arg2]: string[],
): Promise<void> {
  if (action === 'list') {
    const users = await storage.getUsers();
    if (!users.length) return console.log('No registered users found.');
    console.log(`Registered users (${users.length}):`);
    for (const u of users) {
      console.log(
        `  • [${u.id}] ${u.username} (created: ${new Date(u.createdAt).toISOString()})`,
      );
    }
  } else if (action === 'add') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing username.',
      );
    }
    if (!arg2) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing password.',
      );
    }
    const user = await storage.createUser(arg1, arg2);
    console.log(`Created user: [${user.id}] ${user.username}`);
  } else if (action === 'rm') {
    if (!arg1) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing user ID.',
      );
    }
    const user = await storage.getUser(arg1);
    if (!user) return console.log(`User not found: ${arg1}`);
    await user.delete();
    console.log(`Deleted user: ${arg1}`);
  } else {
    throw new TetherServerError(
      TetherServerErrorCode.ConfigurationError,
      `Unknown users action: "${action}".`,
    );
  }
}
