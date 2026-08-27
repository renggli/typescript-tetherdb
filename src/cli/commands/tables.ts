import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { Permission, type TableSettings } from '../../shared/types.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'tables' command family (list, add, show, update, rm).
 *
 * @param storage - Instantiated Storage engine (used if offline).
 * @param args - Positional arguments: `[command, action, tableName, ...options]`.
 * @param dir - Data directory.
 */
export async function handleTablesCommand(
  storage: Storage,
  args: string[],
  dir = '.data',
): Promise<void> {
  const action = args[1] ?? 'list';
  const lock = readServerLock(dir);
  const admin = lock?.adminSecret
    ? new AdminClient(lock.port, lock.host, lock.adminSecret)
    : null;

  if (action === 'list') {
    if (admin) {
      const tables = await admin.getTables();
      printTables(tables);
    } else {
      const tables = await storage.getTables();
      printTables(tables.map((t) => ({ name: t.name, settings: t.settings })));
    }
    return;
  }

  if (action === 'add' || action === 'create') {
    const tableName = args[2];
    if (!tableName) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing table name',
      );
    }
    const settings = parseTableOptions(args.slice(3));

    if (admin) {
      await admin.createTable(tableName, settings);
      console.log(`Created table "${tableName}"`);
    } else {
      await storage.createTable(tableName, settings);
      console.log(`Created table "${tableName}"`);
    }
    return;
  }

  if (action === 'show' || action === 'get') {
    const tableName = args[2];
    if (!tableName) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing table name',
      );
    }

    if (admin) {
      const table = await admin.getTable(tableName);
      printTableDetails(table);
    } else {
      const table = await storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      printTableDetails({ name: table.name, settings: table.settings });
    }
    return;
  }

  if (action === 'update') {
    const tableName = args[2];
    if (!tableName) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing table name',
      );
    }
    const settings = parseTableOptions(args.slice(3));

    if (admin) {
      const res = await admin.updateTable(tableName, settings);
      console.log(`Updated table "${tableName}":`, res.settings);
    } else {
      const table = await storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      const updated = await table.updateSettings(settings);
      console.log(`Updated table "${tableName}":`, updated);
    }
    return;
  }

  if (action === 'rm' || action === 'delete') {
    const tableName = args[2];
    if (!tableName) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing table name',
      );
    }

    if (admin) {
      await admin.deleteTable(tableName);
      console.log(`Deleted table "${tableName}"`);
    } else {
      const table = await storage.getTable(tableName);
      if (!table) {
        console.log(`Table "${tableName}" not found`);
      } else {
        await table.delete();
        console.log(`Deleted table "${tableName}"`);
      }
    }
    return;
  }

  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Unknown tables action: "${action}". Expected "list", "add", "show", "update", or "rm"`,
  );
}

function parsePermission(val: string): Permission {
  const normalized = val.toLowerCase();
  if (normalized === 'everybody' || normalized === 'public')
    return Permission.Everybody;
  if (normalized === 'authenticated' || normalized === 'auth')
    return Permission.Authenticated;
  if (normalized === 'owner') return Permission.Owner;
  if (normalized === 'nobody' || normalized === 'none')
    return Permission.Nobody;
  throw new TetherServerError(
    TetherServerErrorCode.InvalidInput,
    `Invalid permission value: "${val}". Expected "everybody", "authenticated", "owner", or "nobody"`,
  );
}

function parseTableOptions(args: string[]): TableSettings {
  const settings: TableSettings = {};
  for (const arg of args) {
    if (arg.startsWith('--create=')) {
      settings.permissions = {
        ...settings.permissions,
        create: parsePermission(arg.slice(9)),
      };
    } else if (arg.startsWith('--read=')) {
      settings.permissions = {
        ...settings.permissions,
        read: parsePermission(arg.slice(7)),
      };
    } else if (arg.startsWith('--update=')) {
      settings.permissions = {
        ...settings.permissions,
        update: parsePermission(arg.slice(9)),
      };
    } else if (arg.startsWith('--delete=')) {
      settings.permissions = {
        ...settings.permissions,
        delete: parsePermission(arg.slice(9)),
      };
    } else if (arg.startsWith('--max-records=')) {
      settings.maxRecords = Number.parseInt(arg.slice(14), 10);
    } else if (arg.startsWith('--max-size=')) {
      settings.maxRecordSizeBytes = Number.parseInt(arg.slice(11), 10);
    } else if (arg.startsWith('--max-history=')) {
      settings.maxHistoryEntries = Number.parseInt(arg.slice(14), 10);
    }
  }
  return settings;
}

function printTables(
  tables: Array<{ name: string; settings?: TableSettings }>,
): void {
  if (!tables.length) {
    console.log('No tables found.');
    return;
  }
  console.log(`Tables (${tables.length}):`);
  for (const t of tables) {
    const read = t.settings?.permissions?.read ?? Permission.Owner;
    console.log(`  • ${t.name} (read: ${read})`);
  }
}

function printTableDetails(table: {
  name: string;
  settings?: TableSettings;
}): void {
  console.log(`Table "${table.name}":`);
  const perms = table.settings?.permissions;
  console.log(
    `  Permissions:  create=${perms?.create ?? Permission.Authenticated}, read=${perms?.read ?? Permission.Owner}, update=${perms?.update ?? Permission.Owner}, delete=${perms?.delete ?? Permission.Owner}`,
  );
  if (table.settings?.maxRecords) {
    console.log(`  Max Records:  ${table.settings.maxRecords}`);
  }
  if (table.settings?.maxRecordSizeBytes) {
    console.log(`  Max Size:     ${table.settings.maxRecordSizeBytes} bytes`);
  }
  if (table.settings?.maxHistoryEntries) {
    console.log(`  Max History:  ${table.settings.maxHistoryEntries}`);
  }
}
