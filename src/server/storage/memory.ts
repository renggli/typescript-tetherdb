import { shouldOverwrite } from '../../shared/clock.js';
import {
  calculateByteSize,
  validateRecordId,
  validateStoreName,
  validateUserId,
} from '../../shared/sanitize.js';
import {
  type ChangeRecord,
  OperationType,
  type RecordSnapshotItem,
  type ServerLimits,
  type StoredRecord,
} from '../../shared/types.js';
import type { StorageAdapter } from './adapter.js';

interface UserState {
  currentSeq: number;
  minSeq: number;
  stores: Map<string, Map<string, StoredRecord>>;
  changelog: Array<ChangeRecord & { seq: number }>;
}

/**
 * Options for configuring the in-memory storage adapter.
 */
export interface MemoryStorageOptions {
  /** Optional limits and quota configurations. */
  limits?: ServerLimits;
}

/**
 * In-memory implementation of `StorageAdapter` providing zero-dependency persistence
 * with per-user data isolation, changelog compaction, and quota enforcement.
 * Ideal for unit and integration testing.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private users: Map<string, UserState> = new Map();
  private limits: ServerLimits;

  /**
   * Initializes a new MemoryStorageAdapter.
   *
   * @param options - Optional configuration for quotas and limits.
   */
  constructor(options: MemoryStorageOptions = {}) {
    this.limits = options.limits ?? {};
  }

  private getUserState(userId: string): UserState {
    const safeUserId = validateUserId(userId);
    let state = this.users.get(safeUserId);
    if (!state) {
      state = {
        currentSeq: 0,
        minSeq: 0,
        stores: new Map(),
        changelog: [],
      };
      this.users.set(safeUserId, state);
    }
    return state;
  }

  /**
   * Retrieves a single stored record by table and ID for a user.
   *
   * @param userId - Target user account identifier.
   * @param store - Table/store name.
   * @param id - Record identifier.
   * @returns The stored record, or `undefined` if not found.
   */
  async getRecord(
    userId: string,
    store: string,
    id: string,
  ): Promise<StoredRecord | undefined> {
    validateStoreName(store, this.limits.allowedStores, userId);
    validateRecordId(id, store, userId);
    const userState = this.getUserState(userId);
    const storeMap = userState.stores.get(store);
    return storeMap?.get(id);
  }

  /**
   * Retrieves all non-deleted records for a user across all stores (or a specified store).
   *
   * @param userId - Target user account identifier.
   * @param store - Optional specific table name to filter.
   * @returns Array of snapshot items.
   */
  async getAllRecords(
    userId: string,
    store?: string,
  ): Promise<RecordSnapshotItem[]> {
    if (store !== undefined) {
      validateStoreName(store, this.limits.allowedStores, userId);
    }
    const userState = this.getUserState(userId);
    const items: RecordSnapshotItem[] = [];

    const storesToIterate = store
      ? [store]
      : Array.from(userState.stores.keys());

    for (const s of storesToIterate) {
      const storeMap = userState.stores.get(s);
      if (!storeMap) continue;
      for (const [id, record] of storeMap.entries()) {
        if (!record.deleted) {
          items.push({
            store: s,
            id,
            data: record.data,
            timestamp: record.timestamp,
            version: record.version,
            deleted: false,
          });
        }
      }
    }

    return items;
  }

  /**
   * Applies an array of mutation change operations applying Last-Write-Wins rules,
   * enforcing quotas, and compacting old changelog entries.
   *
   * @param userId - Target user account identifier.
   * @param changes - Array of change records to apply.
   * @returns Object with applied changes and new sequence number.
   */
  async applyChanges(
    userId: string,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const userState = this.getUserState(userId);
    const applied: ChangeRecord[] = [];

    const maxStores = this.limits.maxStoresPerUser ?? 50;
    const maxRecords = this.limits.maxRecordsPerStore ?? 10000;
    const maxRecordSize = this.limits.maxRecordSizeBytes ?? 512 * 1024;
    const maxChangelog = this.limits.maxChangelogEntries ?? 1000;

    for (const change of changes) {
      const storeName = validateStoreName(
        change.store,
        this.limits.allowedStores,
        userId,
      );
      const recordId = validateRecordId(change.id, change.store, userId);

      if (
        !userState.stores.has(storeName) &&
        userState.stores.size >= maxStores
      ) {
        throw new Error(
          `Store limit reached. Maximum ${maxStores} tables allowed for user "${userId}".`,
        );
      }

      let storeMap = userState.stores.get(storeName);
      if (!storeMap) {
        storeMap = new Map();
        userState.stores.set(storeName, storeMap);
      }

      if (change.data !== undefined) {
        const payloadSize = calculateByteSize(change.data);
        if (payloadSize > maxRecordSize) {
          throw new Error(
            `Record size (${payloadSize} bytes) for record "${recordId}" in table "${storeName}" exceeds maximum allowed size of ${maxRecordSize} bytes for user "${userId}".`,
          );
        }
      }

      const existing = storeMap.get(recordId);
      const isInsertingActive =
        (!existing || existing.deleted) &&
        !change.deleted &&
        change.op !== OperationType.Delete;

      if (isInsertingActive) {
        let activeCount = 0;
        for (const r of storeMap.values()) {
          if (!r.deleted) activeCount++;
        }
        if (activeCount >= maxRecords) {
          throw new Error(
            `Table "${storeName}" has reached the maximum capacity of ${maxRecords} records for user "${userId}".`,
          );
        }
      }

      if (shouldOverwrite(change, existing)) {
        userState.currentSeq += 1;
        const seq = userState.currentSeq;

        const isDelete =
          change.op === OperationType.Delete || Boolean(change.deleted);
        const record: StoredRecord = {
          id: recordId,
          data: change.data,
          timestamp: change.timestamp,
          version: (existing?.version ?? 0) + 1,
          deleted: isDelete,
        };

        storeMap.set(recordId, record);

        const appliedChange: ChangeRecord & { seq: number } = {
          ...change,
          store: storeName,
          id: recordId,
          seq,
          version: record.version,
          deleted: isDelete,
        };

        userState.changelog.push(appliedChange);
        applied.push(appliedChange);
      }
    }

    // Changelog Compaction
    if (userState.changelog.length > maxChangelog) {
      const excess = userState.changelog.length - maxChangelog;
      const pruned = userState.changelog.splice(0, excess);
      if (pruned.length > 0) {
        const oldestRetained = userState.changelog[0];
        userState.minSeq = oldestRetained?.seq ?? userState.currentSeq;
      }
    }

    return { applied, newSeq: userState.currentSeq };
  }

  /**
   * Retrieves all changes applied since the given sequence number for a user.
   * If `fromSeq < minSeq` (compacted window), `requiresSnapshot` is true.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Object with change records, current sequence number, and snapshot requirement flag.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const userState = this.getUserState(userId);

    if (userState.minSeq > 0 && fromSeq < userState.minSeq) {
      return {
        changes: [],
        currentSeq: userState.currentSeq,
        requiresSnapshot: true,
      };
    }

    const changes = userState.changelog.filter((c) => (c.seq ?? 0) > fromSeq);
    return {
      changes,
      currentSeq: userState.currentSeq,
      requiresSnapshot: false,
    };
  }

  /**
   * Retrieves the current global sequence number for a user.
   *
   * @param userId - Target user account identifier.
   * @returns Current integer sequence number.
   */
  async getCurrentSeq(userId: string): Promise<number> {
    const userState = this.getUserState(userId);
    return userState.currentSeq;
  }

  /**
   * Clears in-memory storage state.
   */
  async close(): Promise<void> {
    this.users.clear();
  }
}
