import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import {
  DEFAULT_TABLE_PERMISSIONS,
  Permission,
  PUBLIC_READ_PERMISSIONS,
  PUBLIC_READ_WRITE_PERMISSIONS,
  SHARED_PERMISSIONS,
  type TablePermissions,
  type TableSettings,
  USER_PRIVATE_PERMISSIONS,
} from '../../shared/types.js';
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

  if (action === 'add') {
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

  if (action === 'show') {
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
    console.log(`Updated table "${tableName}"`);
    printTableDetails(res);
    return;
  }

  if (action === 'rm') {
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

// -- Private Helpers --------------------------------------------------------

const PERMISSION_MODES: ReadonlyMap<string, TablePermissions> = new Map([
  ['user-private', USER_PRIVATE_PERMISSIONS],
  ['public-read', PUBLIC_READ_PERMISSIONS],
  ['public-read-write', PUBLIC_READ_WRITE_PERMISSIONS],
  ['shared', SHARED_PERMISSIONS],
]);

function parsePermissionMode(val: string): TablePermissions {
  const normalized = val.toLowerCase();
  if (normalized === 'default') return DEFAULT_TABLE_PERMISSIONS;
  if (normalized === 'public') return PUBLIC_READ_WRITE_PERMISSIONS;
  const mode = PERMISSION_MODES.get(normalized);
  if (mode) return mode;
  const validModes = Array.from(PERMISSION_MODES.keys())
    .map((k) => `"${k}"`)
    .join(', ');
  throw new TetherServerError(
    TetherServerErrorCode.InvalidInput,
    `Invalid permission mode: "${val}". Expected one of ${validModes}, or "default"`,
  );
}

function getPermissionMode(permissions?: TablePermissions): string {
  const perms = permissions ?? DEFAULT_TABLE_PERMISSIONS;
  for (const [mode, preset] of PERMISSION_MODES) {
    if (
      perms.create === preset.create &&
      perms.read === preset.read &&
      perms.update === preset.update &&
      perms.delete === preset.delete
    ) {
      return mode;
    }
  }
  return 'custom';
}

function parsePermission(
  val: string,
  action: keyof TablePermissions,
): Permission {
  const normalized = val.toLowerCase();
  if (normalized === 'default') return DEFAULT_TABLE_PERMISSIONS[action];
  if (normalized === 'everybody') return Permission.Everybody;
  if (normalized === 'authenticated') return Permission.Authenticated;
  if (normalized === 'owner') return Permission.Owner;
  if (normalized === 'nobody') return Permission.Nobody;
  throw new TetherServerError(
    TetherServerErrorCode.InvalidInput,
    `Invalid permission value: "${val}". Expected "everybody", "authenticated", "owner", "nobody", or "default"`,
  );
}

function parseNumericLimit(val: string): number {
  const normalized = val.toLowerCase();
  if (normalized === 'default' || normalized === 'none' || normalized === '0') {
    return 0;
  }
  const num = Number.parseInt(val, 10);
  if (Number.isNaN(num) || num < 0) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      `Invalid numeric limit: "${val}". Expected a positive integer, "0", or "default"`,
    );
  }
  return num;
}

function parseTableOptions(args: string[]): Partial<TableSettings> {
  const settings: Partial<TableSettings> = {};
  for (const arg of args) {
    if (arg === '--reset' || arg === '--defaults') {
      settings.permissions = { ...DEFAULT_TABLE_PERMISSIONS };
      settings.maxRecords = 0;
      settings.maxRecordSizeBytes = 0;
      settings.maxHistoryEntries = 0;
    } else if (arg.startsWith('--mode=')) {
      settings.permissions = {
        ...settings.permissions,
        ...parsePermissionMode(arg.slice(7)),
      };
    } else if (arg.startsWith('--create=')) {
      settings.permissions = {
        ...DEFAULT_TABLE_PERMISSIONS,
        ...settings.permissions,
        create: parsePermission(arg.slice(9), 'create'),
      };
    } else if (arg.startsWith('--read=')) {
      settings.permissions = {
        ...DEFAULT_TABLE_PERMISSIONS,
        ...settings.permissions,
        read: parsePermission(arg.slice(7), 'read'),
      };
    } else if (arg.startsWith('--update=')) {
      settings.permissions = {
        ...DEFAULT_TABLE_PERMISSIONS,
        ...settings.permissions,
        update: parsePermission(arg.slice(9), 'update'),
      };
    } else if (arg.startsWith('--delete=')) {
      settings.permissions = {
        ...DEFAULT_TABLE_PERMISSIONS,
        ...settings.permissions,
        delete: parsePermission(arg.slice(9), 'delete'),
      };
    } else if (arg.startsWith('--max-records=')) {
      settings.maxRecords = parseNumericLimit(arg.slice(14));
    } else if (arg.startsWith('--max-size=')) {
      settings.maxRecordSizeBytes = parseNumericLimit(arg.slice(11));
    } else if (arg.startsWith('--max-history=')) {
      settings.maxHistoryEntries = parseNumericLimit(arg.slice(14));
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
    const mode = getPermissionMode(t.settings?.permissions);
    console.log(`  • ${t.name} (${mode})`);
  }
}

function printTableDetails(table: {
  name: string;
  settings?: TableSettings;
}): void {
  console.log(`Table "${table.name}":`);
  const perms = table.settings?.permissions ?? DEFAULT_TABLE_PERMISSIONS;
  const mode = getPermissionMode(perms);
  console.log(`  Mode:         ${mode}`);
  console.log(
    `  Permissions:  create=${perms.create}, read=${perms.read}, update=${perms.update}, delete=${perms.delete}`,
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
