import type { SnapshotRecord, StoredRecord } from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../validate.js';
import { TableBaseStorage } from '../base/table.js';
import type { UserStorage } from '../user.js';
import type { AppSqliteStorage } from './app.js';

interface RawRecordRow {
  table_name: string;
  id: string;
  version: number;
  timestamp: number;
  client_id: string;
  deleted: number;
  data: string | null;
}

/**
 * SQLite-backed implementation of `TableStorage`.
 */
export class TableSqliteStorage extends TableBaseStorage {
  declare readonly app: AppSqliteStorage;

  async delete(): Promise<boolean> {
    return this.app.deleteTable(this.name);
  }
  private parseData(raw: string | null): unknown {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async getRecord(
    user: UserStorage,
    id: string,
  ): Promise<StoredRecord | undefined> {
    const safeUserId = validateUserId(user.id);
    const safeId = validateRecordId(id);
    const handle = this.app.getUserDb(safeUserId);

    const row = handle.stmtGetRecord.get(this.name, safeId) as
      | RawRecordRow
      | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? '',
      deleted: Boolean(row.deleted),
      data: this.parseData(row.data),
    };
  }

  async getAllRecords(user: UserStorage): Promise<SnapshotRecord[]> {
    const safeUserId = validateUserId(user.id);
    const handle = this.app.getUserDb(safeUserId);
    const rows = handle.stmtGetSnapshotByTable.all(
      this.name,
    ) as unknown as RawRecordRow[];

    return rows.map((row) => ({
      table: row.table_name,
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? '',
      data: this.parseData(row.data),
    }));
  }
}
