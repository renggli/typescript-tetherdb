import { shouldOverwrite } from '../../../shared/clock.js';
import {
  calculateByteSize,
  validateRecordId,
  validateTableName,
} from '../../../shared/sanitize.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../../../shared/types.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { MemoryStorage } from './storage.js';
import { TableMemoryStorage } from './table.js';

/**
 * In-memory implementation of `AppStorage`.
 */
export class AppMemoryStorage implements AppStorage {
  readonly id: string;
  private tables: Map<string, TableMemoryStorage> = new Map();
  private storage: MemoryStorage;

  constructor(id: string, storage: MemoryStorage) {
    this.id = id;
    this.storage = storage;
  }

  async createTable(name: string): Promise<TableStorage> {
    const safeName = validateTableName(name);
    let table = this.tables.get(safeName);
    if (!table) {
      table = new TableMemoryStorage(safeName, this, this.storage);
      this.tables.set(safeName, table);
    }
    return table;
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    return this.tables.get(safeName);
  }

  async getTables(): Promise<TableStorage[]> {
    return Array.from(this.tables.values());
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const userState = this.storage.getUserState(user.id, this.id);
    const applied: ChangeRecord[] = [];

    const maxRecords = this.storage.limits.maxRecordsPerTable ?? 10000;
    const maxRecordSize = this.storage.limits.maxRecordSizeBytes ?? 512 * 1024;
    const maxChangelog = this.storage.limits.maxChangelogEntries ?? 1000;

    for (const change of changes) {
      const tableName = validateTableName(change.table);
      const recordId = validateRecordId(change.id, tableName, user.id);

      if (!this.tables.has(tableName)) {
        throw new Error(
          `Table "${tableName}" does not exist in app "${this.id}". Create it first using "tetherdb tables add ${this.id} ${tableName}".`,
        );
      }

      let tableMap = userState.tables.get(tableName);
      if (!tableMap) {
        tableMap = new Map();
        userState.tables.set(tableName, tableMap);
      }

      if (
        change.op === OperationType.Put &&
        !tableMap.has(recordId) &&
        tableMap.size >= maxRecords
      ) {
        throw new Error(
          `Table "${tableName}" has reached the maximum capacity of ${maxRecords} records for user "${user.id}".`,
        );
      }

      const payloadBytes = calculateByteSize(change.data);
      if (payloadBytes > maxRecordSize) {
        throw new Error(
          `Record payload size (${payloadBytes} bytes) exceeds maximum allowed size of ${maxRecordSize} bytes for record "${recordId}" in table "${tableName}".`,
        );
      }

      const existing = tableMap.get(recordId);
      const shouldApply = !existing || shouldOverwrite(change, existing);

      if (shouldApply) {
        userState.currentSeq++;
        const assignedSeq = userState.currentSeq;

        if (userState.minSeq === 0) {
          userState.minSeq = 1;
        }

        const isDeleted = change.op === OperationType.Delete;
        const nextVersion = (existing?.version ?? 0) + 1;

        const updatedRecord: StoredRecord = {
          id: recordId,
          version: nextVersion,
          timestamp: change.timestamp,
          clientId: change.clientId,
          deleted: isDeleted,
          data: isDeleted ? null : (change.data ?? null),
        };

        tableMap.set(recordId, updatedRecord);

        const appliedChange: ChangeRecord & { seq: number } = {
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
        };

        applied.push(appliedChange);
        userState.changelog.push(appliedChange);

        if (userState.changelog.length > maxChangelog) {
          const pruneCount = userState.changelog.length - maxChangelog;
          userState.changelog.splice(0, pruneCount);
          if (userState.changelog.length > 0) {
            userState.minSeq = userState.changelog[0].seq;
          }
        }
      }
    }

    return { applied, newSeq: userState.currentSeq };
  }

  async getChangesSince(
    user: UserStorage,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const userState = this.storage.getUserState(user.id, this.id);
    const currentSeq = userState.currentSeq;
    const minSeq = userState.minSeq;

    if (fromSeq < minSeq && minSeq > 0) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const changes = userState.changelog.filter((c) => c.seq > fromSeq);
    return { changes, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(user: UserStorage): Promise<number> {
    const userState = this.storage.getUserState(user.id, this.id);
    return userState.currentSeq;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteApp(this.id);
  }

  deleteTable(name: string): boolean {
    const safeName = validateTableName(name);
    const deleted = this.tables.delete(safeName);
    this.storage.deleteTableInUserStates(this.id, safeName);
    return deleted;
  }
}
