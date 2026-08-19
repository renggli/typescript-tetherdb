import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';

/**
 * Handles the 'tables' command family (list, add, rm, <appid>).
 *
 * @param storage - Instantiated Storage engine.
 * @param args - Positional arguments: `[command, action, appId, ...tableNames]`.
 */
export async function handleTablesCommand(
  storage: Storage,
  args: string[],
): Promise<void> {
  const action = args[1] ?? 'list';
  if (action === 'add' || action === 'rm') {
    const appId = args[2];
    if (!appId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing application ID.',
      );
    }
    const tableNames = args.slice(3);
    if (!tableNames.length) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing table name.',
      );
    }
    const app = await storage.getApp(appId);
    if (!app) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Application "${appId}" not found.`,
      );
    }
    for (const tableName of tableNames) {
      if (action === 'add') {
        if (await app.getTable(tableName)) {
          console.log(
            `Table "${tableName}" already exists in application "${appId}"`,
          );
        } else {
          await app.createTable(tableName);
          console.log(`Added table "${tableName}" to application "${appId}"`);
        }
      } else {
        const table = await app.getTable(tableName);
        if (!table) {
          console.log(
            `Table "${tableName}" not found in application "${appId}"`,
          );
        } else {
          await table.delete();
          console.log(
            `Removed table "${tableName}" from application "${appId}"`,
          );
        }
      }
    }
  } else {
    const appId = action === 'list' ? args[2] : action;
    if (!appId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing application ID.',
      );
    }
    const app = await storage.getApp(appId);
    if (!app) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Application "${appId}" not found.`,
      );
    }
    const tables = await app.getTables();
    if (!tables.length) {
      console.log(`No tables found for application "${appId}".`);
    } else {
      console.log(`Tables for application "${appId}" (${tables.length}):`);
      for (const t of tables) console.log(`  • ${t.name}`);
    }
  }
}
