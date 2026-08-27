import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { type ChangeRecord, OperationType } from '../../shared/types.js';
import { AdminClient } from '../admin-client.js';

/**
 * Handles the 'records' command family (list, put, rm).
 *
 * @param storage - Instantiated Storage engine (used if offline).
 * @param args - Positional arguments: `[command, action, tableName, idOrData, ...options]`.
 * @param dir - Data directory.
 */
export async function handleRecordsCommand(
  storage: Storage,
  args: string[],
  dir = '.data',
): Promise<void> {
  const action = args[1] ?? 'list';
  const tableName = args[2];
  const lock = readServerLock(dir);
  const admin = lock?.adminSecret
    ? new AdminClient(lock.port, lock.host, lock.adminSecret)
    : null;

  if (!tableName) {
    throw new TetherServerError(
      TetherServerErrorCode.ConfigurationError,
      'Missing table name',
    );
  }

  const userId = parseUserOption(args);

  if (action === 'list') {
    if (admin) {
      const records = await admin.getRecords(tableName, userId);
      printRecords(tableName, records);
    } else {
      const table = await storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      const user = userId ? await storage.getUser(userId) : undefined;
      const records = await table.getAllRecords(user);
      printRecords(tableName, records);
    }
    return;
  }

  if (action === 'put' || action === 'set') {
    const recordId = args[3];
    const rawData = args[4];
    if (!recordId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing record ID',
      );
    }

    let parsedData: unknown = {};
    if (rawData) {
      try {
        parsedData = JSON.parse(rawData);
      } catch {
        parsedData = rawData;
      }
    }

    const change: ChangeRecord = {
      table: tableName,
      id: recordId,
      op: OperationType.Put,
      data: parsedData,
      timestamp: Date.now(),
      clientId: 'cli_admin',
    };

    if (admin) {
      const res = await admin.applyChanges([change], userId);
      console.log(
        `Put record "${recordId}" in table "${tableName}" (seq: ${res.newSeq})`,
      );
    } else {
      const user = userId ? await storage.getUser(userId) : undefined;
      const res = await storage.applyChanges(user, [change]);
      console.log(
        `Put record "${recordId}" in table "${tableName}" (seq: ${res.newSeq})`,
      );
    }
    return;
  }

  if (action === 'rm' || action === 'delete') {
    const recordId = args[3];
    if (!recordId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing record ID',
      );
    }

    const change: ChangeRecord = {
      table: tableName,
      id: recordId,
      op: OperationType.Delete,
      timestamp: Date.now(),
      clientId: 'cli_admin',
    };

    if (admin) {
      const res = await admin.applyChanges([change], userId);
      console.log(
        `Deleted record "${recordId}" from table "${tableName}" (seq: ${res.newSeq})`,
      );
    } else {
      const user = userId ? await storage.getUser(userId) : undefined;
      const res = await storage.applyChanges(user, [change]);
      console.log(
        `Deleted record "${recordId}" from table "${tableName}" (seq: ${res.newSeq})`,
      );
    }
    return;
  }

  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Unknown records action: "${action}". Expected "list", "put", or "rm"`,
  );
}

function parseUserOption(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--user=')) {
      return arg.slice(7);
    }
  }
  return undefined;
}

function printRecords(
  tableName: string,
  records: import('../../shared/types.js').SnapshotRecord[],
): void {
  if (!records.length) {
    console.log(`No records found in table "${tableName}".`);
    return;
  }
  console.log(`Records in "${tableName}" (${records.length}):`);
  for (const r of records) {
    console.log(
      `  • [${r.id}] (v${r.version}, updated: ${new Date(r.timestamp).toISOString()})`,
    );
    if (r.data !== undefined && r.data !== null) {
      console.log(`    ${JSON.stringify(r.data)}`);
    }
  }
}
