import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import type { SnapshotRecord, StoredRecord } from '../../shared/types.js';
import type { AdminTarget } from '../admin.js';

/**
 * Handles the 'records' command family (list, put, rm).
 *
 * @param target - Active administration target.
 * @param args - Positional arguments: `[command, action, tableName, idOrData, ...options]`.
 */
export async function handleRecordsCommand(
  target: AdminTarget,
  args: string[],
): Promise<void> {
  const action = args[1] ?? 'list';
  const tableName = args[2];

  if (!tableName) {
    throw new TetherServerError(
      TetherServerErrorCode.ConfigurationError,
      'Missing table name',
    );
  }

  const userId = parseUserOption(args);

  if (action === 'list') {
    const records = await target.getRecords(tableName, userId);
    printRecords(tableName, records);
    return;
  }

  if (action === 'put') {
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

    await target.putRecord(tableName, recordId, parsedData, userId);
    console.log(`Put record "${recordId}" in table "${tableName}"`);
    return;
  }

  if (action === 'rm') {
    const recordId = args[3];
    if (!recordId) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        'Missing record ID',
      );
    }

    await target.deleteRecord(tableName, recordId, userId);
    console.log(`Deleted record "${recordId}" from table "${tableName}"`);
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
  records: Array<StoredRecord | SnapshotRecord>,
): void {
  if (!records.length) {
    console.log(`No records found in table "${tableName}".`);
    return;
  }
  console.log(`Records in "${tableName}" (${records.length}):`);
  for (const r of records) {
    const dataStr =
      typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data);
    const userStr = r.userName ? ` [user: ${r.userName}]` : '';
    console.log(`  • [${r.id}] v${r.version}${userStr}: ${dataStr}`);
  }
}
