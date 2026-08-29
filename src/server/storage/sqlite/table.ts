import type {
  SnapshotRecord,
  StoredRecord,
  TableSettings,
} from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../shared/validate.js';
import { canRead, isPrivateTable, TableBaseStorage } from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { SqliteStorage } from './storage.js';

interface RawRecordRow {
  table_name: string;
  id: string;
  version: number;
  timestamp: number;
  client_id: string;
  deleted: number;
  data: string | null;
  user_id?: string | null;
}

/**
 * SQLite-backed implementation of `TableStorage`.
 */
export class TableSqliteStorage extends TableBaseStorage<SqliteStorage> {
  constructor(
    name: string,
    storage: SqliteStorage,
    settings: Partial<TableSettings> = {},
  ) {
    super(name, storage, settings);
  }

  override async updateSettings(
    settings: Partial<TableSettings>,
  ): Promise<TableSettings> {
    const updated = await super.updateSettings(settings);
    this.storage.updateTableSettingsInDb(this.name, updated);
    return updated;
  }

  private parseData(raw: string | null): unknown {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  private resolveEffectiveUserId(user?: UserStorage): string | undefined {
    const isPrivate = isPrivateTable(this);
    if (isPrivate) {
      return user ? validateUserId(user.userId) : undefined;
    }
    return '__shared__';
  }

  async getRecord(
    user: UserStorage | undefined,
    id: string,
  ): Promise<StoredRecord | undefined> {
    if (!canRead(this, user)) {
      return undefined;
    }
    const effectiveUserId = this.resolveEffectiveUserId(user);
    if (!effectiveUserId) return undefined;

    const safeId = validateRecordId(id);
    const dbHandle = this.storage.getTablesDb();

    const row = dbHandle.stmtGetRecord.get(
      this.name,
      effectiveUserId,
      safeId,
    ) as RawRecordRow | undefined;
    if (!row || row.deleted) return undefined;

    return {
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? undefined,
      deleted: Boolean(row.deleted),
      data: this.parseData(row.data),
      ...({ userId: row.user_id ?? undefined } as { userId?: string }),
    };
  }

  async getAllRecords(user?: UserStorage): Promise<SnapshotRecord[]> {
    if (!canRead(this, user)) {
      return [];
    }
    const effectiveUserId = this.resolveEffectiveUserId(user);
    if (!effectiveUserId) return [];

    const dbHandle = this.storage.getTablesDb();
    const rows = dbHandle.stmtGetSnapshotByTable.all(
      this.name,
      effectiveUserId,
    ) as unknown as RawRecordRow[];

    return rows.map((row) => ({
      table: row.table_name,
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? undefined,
      data: this.parseData(row.data),
      ...({ userId: row.user_id ?? undefined } as { userId?: string }),
    }));
  }
}
