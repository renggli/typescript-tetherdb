import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { Permission, type TableSettings } from '../../shared/types.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'tables' command family (list, add, show, update, rm).
 *
 * @param target - Active administration target.
 * @param args - Positional arguments: `[command, action, tableName, ...options]`.
 */
export async function handleTablesCommand(
  target: AdminTarget,
  args: string[],
): Promise<void> {
  const action = args[1] ?? 'list';

  if (action === 'list') {
    const tables = await target.getTables();
    printTables(tables);
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
    await target.createTable(tableName, settings);
    console.log(`Created table "${tableName}"`);
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
    const table = await target.getTable(tableName);
    if (!table) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Table "${tableName}" not found`,
      );
    }
    printTableDetails(table);
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
    const res = await target.updateTable(tableName, settings);
    console.log(`Updated table "${tableName}":`, res.settings);
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
    await target.deleteTable(tableName);
    console.log(`Deleted table "${tableName}"`);
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
