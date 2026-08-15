import { shouldOverwrite } from '../../../shared/clock.js';
import {
  calculateByteSize,
  validateRecordId,
  validateTableName,
  validateUserId,
} from '../../../shared/sanitize.js';
import { type ChangeRecord, OperationType } from '../../../shared/types.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { AppDbHandle, SqliteStorage } from './storage.js';
import { TableSqliteStorage } from './table.js';

interface RawRecordRow {
  table_name: string;
  id: string;
  version: number;
  timestamp: number;
  client_id: string;
  deleted: number;
  data: string | null;
}

interface RawChangelogRow {
  seq: number;
  table_name: string;
  id: string;
  op: string;
  version: number;
  timestamp: number;
  client_id: string;
  deleted: number;
  data: string | null;
}

interface RawMetaRow {
  current_seq: number;
  min_seq: number;
}

/**
 * SQLite-backed application namespace storage implementation.
 */
export class AppSqliteStorage implements AppStorage {
  readonly id: string;
  readonly storage: SqliteStorage;

  constructor(id: string, storage: SqliteStorage) {
    this.id = id;
    this.storage = storage;
  }

  get handle(): AppDbHandle {
    return this.storage.getAppDb(this.id).handle;
  }

  getDbHandle(): AppDbHandle {
    return this.handle;
  }

  private parseData(raw: string | null): unknown {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  private serializeData(data: unknown): string | null {
    if (data === null || data === undefined) return null;
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
  }

  async createTable(name: string): Promise<TableStorage> {
    const safeName = validateTableName(name);
    this.handle.stmtInsertTable.run(safeName, Date.now());
    return new TableSqliteStorage(safeName, this);
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    const row = this.handle.stmtCheckTable.get(safeName);
    if (row) {
      return new TableSqliteStorage(safeName, this);
    }
    return undefined;
  }

  async getTables(): Promise<TableStorage[]> {
    const rows = this.handle.stmtListTables.all() as unknown as Array<{
      name: string;
    }>;
    return rows.map((r) => new TableSqliteStorage(r.name, this));
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const safeUserId = validateUserId(user.id);
    const applied: ChangeRecord[] = [];
    const handle = this.handle;

    const maxRecords = this.storage.limits.maxRecordsPerTable ?? 10000;
    const maxRecordSize = this.storage.limits.maxRecordSizeBytes ?? 512 * 1024;
    const maxChangelog = this.storage.limits.maxChangelogEntries ?? 1000;

    handle.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const metaRow = handle.stmtGetMeta.get(safeUserId) as
        | RawMetaRow
        | undefined;
      let currentSeq = metaRow?.current_seq ?? 0;
      let minSeq = metaRow?.min_seq ?? 0;

      for (const change of changes) {
        const tableName = validateTableName(change.table);
        const recordId = validateRecordId(change.id, tableName, safeUserId);

        const tableExists = handle.stmtCheckTable.get(tableName);
        if (!tableExists) {
          throw new Error(
            `Table "${tableName}" does not exist in app "${this.id}". Create it first using "tetherdb tables add ${this.id} ${tableName}".`,
          );
        }

        const existingRecord = handle.stmtGetRecordForUpdate.get(
          safeUserId,
          tableName,
          recordId,
        ) as RawRecordRow | undefined;

        if (change.op === OperationType.Put && !existingRecord) {
          const countRow = handle.stmtCountTableRecords.get(
            safeUserId,
            tableName,
          ) as { count: number } | undefined;
          const tableCount = countRow?.count ?? 0;
          if (tableCount >= maxRecords) {
            throw new Error(
              `Table "${tableName}" has reached the maximum capacity of ${maxRecords} records for user "${safeUserId}".`,
            );
          }
        }

        const payloadBytes = calculateByteSize(change.data);
        if (payloadBytes > maxRecordSize) {
          throw new Error(
            `Record payload size (${payloadBytes} bytes) exceeds maximum allowed size of ${maxRecordSize} bytes for record "${recordId}" in table "${tableName}".`,
          );
        }

        const shouldApply =
          !existingRecord ||
          shouldOverwrite(
            {
              timestamp: change.timestamp,
              clientId: change.clientId,
              version: change.version,
            },
            {
              timestamp: existingRecord.timestamp,
              clientId: existingRecord.client_id ?? '',
              version: existingRecord.version,
            },
          );

        if (shouldApply) {
          currentSeq++;
          const assignedSeq = currentSeq;

          if (minSeq === 0) {
            minSeq = 1;
          }

          const isDeleted = change.op === OperationType.Delete;
          const nextVersion = (existingRecord?.version ?? 0) + 1;
          const serializedData = isDeleted
            ? null
            : this.serializeData(change.data);

          if (existingRecord) {
            handle.stmtUpdateRecord.run(
              nextVersion,
              change.timestamp,
              change.clientId ?? '',
              isDeleted ? 1 : 0,
              serializedData,
              safeUserId,
              tableName,
              recordId,
            );
          } else {
            handle.stmtInsertRecord.run(
              safeUserId,
              tableName,
              recordId,
              nextVersion,
              change.timestamp,
              change.clientId ?? '',
              isDeleted ? 1 : 0,
              serializedData,
            );
          }

          handle.stmtInsertChangelog.run(
            safeUserId,
            assignedSeq,
            tableName,
            recordId,
            change.op,
            nextVersion,
            change.timestamp,
            change.clientId ?? '',
            isDeleted ? 1 : 0,
            serializedData,
          );

          applied.push({
            appId: this.id,
            seq: assignedSeq,
            table: tableName,
            id: recordId,
            op: change.op,
            version: nextVersion,
            timestamp: change.timestamp,
            clientId: change.clientId,
            deleted: isDeleted,
            data: isDeleted ? null : change.data,
          });
        }
      }

      if (currentSeq - minSeq + 1 > maxChangelog) {
        const newMinSeq = currentSeq - maxChangelog + 1;
        handle.stmtPruneChangelog.run(safeUserId, newMinSeq);
        minSeq = newMinSeq;
      }

      if (applied.length > 0) {
        handle.stmtSetMeta.run(safeUserId, currentSeq, minSeq);
      }

      handle.db.exec('COMMIT');
      return { applied, newSeq: currentSeq };
    } catch (err) {
      handle.db.exec('ROLLBACK');
      throw err;
    }
  }

  async getChangesSince(
    user: UserStorage,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const safeUserId = validateUserId(user.id);
    const metaRow = this.handle.stmtGetMeta.get(safeUserId) as
      | RawMetaRow
      | undefined;
    const currentSeq = metaRow?.current_seq ?? 0;
    const minSeq = metaRow?.min_seq ?? 0;

    if (fromSeq < minSeq && minSeq > 0) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const rows = this.handle.stmtGetChangelogSince.all(
      safeUserId,
      fromSeq,
    ) as unknown as RawChangelogRow[];

    const changes: ChangeRecord[] = rows.map((row) => ({
      appId: this.id,
      seq: row.seq,
      table: row.table_name,
      id: row.id,
      op:
        row.op === OperationType.Delete
          ? OperationType.Delete
          : OperationType.Put,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? '',
      deleted: Boolean(row.deleted),
      data: this.parseData(row.data),
    }));

    return { changes, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(user: UserStorage): Promise<number> {
    const safeUserId = validateUserId(user.id);
    const metaRow = this.handle.stmtGetMeta.get(safeUserId) as
      | RawMetaRow
      | undefined;
    return metaRow?.current_seq ?? 0;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteAppDb(this.id);
  }

  deleteTable(name: string): boolean {
    const safeName = validateTableName(name);
    const exists = this.handle.stmtCheckTable.get(safeName);
    if (!exists) return false;

    this.handle.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      this.handle.stmtDeleteTable.run(safeName);
      this.handle.db
        .prepare('DELETE FROM records WHERE table_name = ?')
        .run(safeName);
      this.handle.db
        .prepare('DELETE FROM changelog WHERE table_name = ?')
        .run(safeName);
      this.handle.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.handle.db.exec('ROLLBACK');
      throw err;
    }
  }
}
