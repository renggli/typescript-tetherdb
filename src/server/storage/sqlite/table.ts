import { validateRecordId, validateUserId } from '../../../shared/sanitize.js';
import type {
  ChangeRecord,
  RecordSnapshotItem,
  StoredRecord,
} from '../../../shared/types.js';
import type { TableStorage } from '../table.js';
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
export class TableSqliteStorage implements TableStorage {
  readonly name: string;
  readonly app: AppSqliteStorage;

  constructor(name: string, app: AppSqliteStorage) {
    this.name = name;
    this.app = app;
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
    const safeId = validateRecordId(id, this.name, safeUserId);
    const handle = this.app.getDbHandle();

    const row = handle.stmtGetRecord.get(safeUserId, this.name, safeId) as
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

  async getAllRecords(user: UserStorage): Promise<RecordSnapshotItem[]> {
    const safeUserId = validateUserId(user.id);
    const handle = this.app.getDbHandle();
    const rows = handle.stmtGetSnapshotByTable.all(
      safeUserId,
      this.name,
    ) as unknown as RawRecordRow[];

    return rows.map((row) => ({
      appId: this.app.id,
      table: row.table_name,
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? '',
      data: this.parseData(row.data),
    }));
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const targetedChanges = changes.map((c) => ({
      ...c,
      table: this.name,
      appId: this.app.id,
    }));
    return this.app.applyChanges(user, targetedChanges);
  }

  async delete(): Promise<boolean> {
    return this.app.deleteTable(this.name);
  }
}
