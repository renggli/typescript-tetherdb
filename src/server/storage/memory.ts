import { shouldOverwrite } from '../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type RecordSnapshotItem,
  type StoredRecord,
} from '../../shared/types.js';
import type { StorageAdapter } from './adapter.js';

interface UserState {
  currentSeq: number;
  stores: Map<string, Map<string, StoredRecord>>;
  changelog: Array<ChangeRecord & { seq: number }>;
}

/**
 * In-memory implementation of `StorageAdapter` providing zero-dependency persistence
 * with per-user data isolation. Ideal for unit and integration testing.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  private users: Map<string, UserState> = new Map();

  private getUserState(userId: string): UserState {
    let state = this.users.get(userId);
    if (!state) {
      state = {
        currentSeq: 0,
        stores: new Map(),
        changelog: [],
      };
      this.users.set(userId, state);
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
   * Applies an array of mutation change operations applying Last-Write-Wins rules.
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

    for (const change of changes) {
      let storeMap = userState.stores.get(change.store);
      if (!storeMap) {
        storeMap = new Map();
        userState.stores.set(change.store, storeMap);
      }

      const existing = storeMap.get(change.id);
      if (shouldOverwrite(change, existing)) {
        userState.currentSeq += 1;
        const seq = userState.currentSeq;

        const isDelete =
          change.op === OperationType.Delete || Boolean(change.deleted);
        const record: StoredRecord = {
          id: change.id,
          data: change.data,
          timestamp: change.timestamp,
          version: (existing?.version ?? 0) + 1,
          deleted: isDelete,
        };

        storeMap.set(change.id, record);

        const appliedChange: ChangeRecord & { seq: number } = {
          ...change,
          seq,
          version: record.version,
          deleted: isDelete,
        };

        userState.changelog.push(appliedChange);
        applied.push(appliedChange);
      }
    }

    return { applied, newSeq: userState.currentSeq };
  }

  /**
   * Retrieves all changes applied since the given sequence number for a user.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Object with change records and current sequence number.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
  ): Promise<{ changes: ChangeRecord[]; currentSeq: number }> {
    const userState = this.getUserState(userId);
    const changes = userState.changelog.filter((c) => (c.seq ?? 0) > fromSeq);
    return {
      changes,
      currentSeq: userState.currentSeq,
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
