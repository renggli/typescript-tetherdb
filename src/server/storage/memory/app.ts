import { shouldOverwrite } from '../../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import {
  calculateByteSize,
  validateRecordId,
  validateTableName,
  validateTimestamp,
} from '../../validate.js';
import { AppBaseStorage, applyChangeToRecord } from '../base/index.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { MemoryStorage } from './storage.js';
import { TableMemoryStorage } from './table.js';

/**
 * In-memory implementation of `AppStorage`.
 */
export class AppMemoryStorage extends AppBaseStorage {
  private tables: Map<string, TableMemoryStorage> = new Map();
  private storage: MemoryStorage;

  constructor(id: string, storage: MemoryStorage) {
    super(id);
    this.storage = storage;
  }

  async createTable(tableName: string): Promise<TableStorage> {
    const safeName = validateTableName(tableName);
    if (this.tables.has(safeName)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Table already exists in this application',
      );
    }
    const table = new TableMemoryStorage(safeName, this, this.storage);
    this.tables.set(safeName, table);
    return table;
  }

  async getTable(tableName: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(tableName);
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

    const maxRecords = this.storage.options.maxRecordsPerTable ?? 10000;
    const maxRecordSize = this.storage.options.maxRecordSizeBytes ?? 512 * 1024;
    const maxChangelog = this.storage.options.maxChangelogEntries ?? 1000;

    // Phase 1: Pre-validate all changes in the batch
    for (const change of changes) {
      const tableName = validateTableName(change.table);
      validateRecordId(change.id);
      validateTimestamp(change.timestamp);

      if (!this.tables.has(tableName)) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          'Table not found',
        );
      }

      const payloadBytes = calculateByteSize(change.data);
      if (payloadBytes > maxRecordSize) {
        throw new TetherServerError(
          TetherServerErrorCode.LimitExceeded,
          'Record payload exceeds maximum allowed size',
        );
      }
    }

    // Phase 2: Stage mutations against cloned table maps
    const stagedTables = new Map<string, Map<string, StoredRecord>>();
    const stagedApplied: (ChangeRecord & { seq: number })[] = [];
    let stagedCurrentSeq = userState.currentSeq;
    let stagedMinSeq = userState.minSeq;

    for (const change of changes) {
      const tableName = validateTableName(change.table);
      const recordId = validateRecordId(change.id);

      let tableMap = stagedTables.get(tableName);
      if (!tableMap) {
        const existingTableMap = userState.tables.get(tableName);
        tableMap = new Map(existingTableMap);
        stagedTables.set(tableName, tableMap);
      }

      if (
        change.op === OperationType.Put &&
        !tableMap.has(recordId) &&
        tableMap.size >= maxRecords
      ) {
        throw new TetherServerError(
          TetherServerErrorCode.LimitExceeded,
          'Table record limit reached',
        );
      }

      const existing = tableMap.get(recordId);
      const shouldApply = !existing || shouldOverwrite(change, existing);

      if (shouldApply) {
        stagedCurrentSeq++;
        const assignedSeq = stagedCurrentSeq;

        if (stagedMinSeq === 0) {
          stagedMinSeq = 1;
        }

        const { updatedRecord, appliedChange } = applyChangeToRecord(
          change,
          existing,
          assignedSeq,
        );

        tableMap.set(recordId, updatedRecord);
        stagedApplied.push(appliedChange);
      }
    }

    // Phase 3: Commit staged modifications atomically to userState
    for (const [tableName, stagedMap] of stagedTables.entries()) {
      userState.tables.set(tableName, stagedMap);
    }
    userState.currentSeq = stagedCurrentSeq;
    userState.minSeq = stagedMinSeq;
    userState.changelog.push(...stagedApplied);

    if (userState.changelog.length > maxChangelog) {
      const pruneCount = userState.changelog.length - maxChangelog;
      userState.changelog.splice(0, pruneCount);
      if (userState.changelog.length > 0) {
        userState.minSeq = userState.changelog[0].seq;
      }
    }

    return { applied: stagedApplied, newSeq: userState.currentSeq };
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

    if ((fromSeq < minSeq && minSeq > 0) || fromSeq > currentSeq) {
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
