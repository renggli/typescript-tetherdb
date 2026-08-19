import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';

/**
 * Handles the 'apps' command family (list, add, rm).
 *
 * @param storage - Instantiated Storage engine.
 * @param args - Positional arguments: `[command, action, appId]`.
 */
export async function handleAppsCommand(
  storage: Storage,
  [, action = 'list', appId]: string[],
): Promise<void> {
  if (action === 'list') {
    const apps = await storage.getApps();
    if (!apps.length) return console.log('No applications found.');
    console.log(`Applications (${apps.length}):`);
    for (const app of apps) {
      const tables = await app.getTables();
      const tableList = tables.map((t) => t.name).join(', ') || 'no tables';
      console.log(`  • ${app.id} (tables: ${tableList})`);
    }
  } else if (action === 'add') {
    if (!appId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing application ID.',
      );
    }
    if (await storage.getApp(appId)) {
      return console.log(`Application already exists: ${appId}`);
    }
    await storage.createApp(appId);
    console.log(`Created application: ${appId}`);
  } else if (action === 'rm') {
    if (!appId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing application ID.',
      );
    }
    const app = await storage.getApp(appId);
    if (!app) return console.log(`Application not found: ${appId}`);
    await app.delete();
    console.log(`Deleted application: ${appId}`);
  } else {
    throw new TetherServerError(
      TetherServerErrorCode.ConfigurationError,
      `Unknown apps action: "${action}".`,
    );
  }
}
