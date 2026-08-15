import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../shared/types.js';
import type { IDBManager, LocalMutationItem } from './idb.js';

/**
 * Event describing a mutation (insert, update, delete) on a table record.
 *
 * @typeParam T - Data payload type.
 */
export interface TableChangeEvent<T = unknown> {
  /** The mutation operation type. */
  op: OperationType;
  /** The affected record identifier. */
  id: string;
  /** The new record data (defined on 'put' operations). */
  data?: T;
  /** `true` if the change originated from remote synchronization; `false` if triggered locally. */
  isRemote?: boolean;
}

/**
 * Entry item for bulk insertion/update via `Table.putAll`.
 *
 * @typeParam T - Data payload type.
 */
export interface TablePutEntry<T = unknown> {
  /** Target record identifier. */
  id: string;
  /** Record data payload. */
  data: T;
}

/**
 * Event notification callback fired when records are inserted, updated, or deleted.
 * Always receives a list of change events.
 *
 * @typeParam T - Data payload type.
 * @param events - List of change events that occurred.
 */
export type TableChangeListener<T = unknown> = (
  events: TableChangeEvent<T>[],
) => void;

/**
 * Abstract interface representing an object store table capable of ingesting remote sync records.
 */
export interface ITable {
  /** The unique name of the table / object store. */
  readonly name: string;
  /**
   * Notifies registered table subscribers of remote change events.
   *
   * @param events - The remote change events.
   */
  notifyRemoteChanges(events: TableChangeEvent<unknown>[]): void;
}

/**
 * Typed table wrapper providing local-first CRUD operations and reactive event subscriptions
 * against an underlying IndexedDB object store.
 * Operations are batched by default for maximum performance.
 *
 * @typeParam T - The data type of records stored in this table.
 */
export class Table<T = unknown> implements ITable {
  private storeName: string;
  private idb: IDBManager;
  private getClientId: () => string;
  private onLocalChange?: () => void;
  private listeners: Set<TableChangeListener<T>> = new Set();

  /**
   * Creates a new Table instance.
   *
   * @param storeName - Name of the IndexedDB object store.
   * @param idb - IndexedDB transaction coordinator.
   * @param getClientId - Function providing the current client identifier.
   * @param onLocalChange - Optional callback invoked after local mutations are committed.
   */
  constructor(
    storeName: string,
    idb: IDBManager,
    getClientId: () => string,
    onLocalChange?: () => void,
  ) {
    this.storeName = storeName;
    this.idb = idb;
    this.getClientId = getClientId;
    this.onLocalChange = onLocalChange;
  }

  /**
   * The name of the underlying object store.
   */
  get name(): string {
    return this.storeName;
  }

  /**
   * Retrieves a single record by its identifier.
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the record data, or `null` if not found or marked deleted.
   */
  async get(id: string): Promise<T | null> {
    const record = await this.idb.getRecord<T>(this.storeName, id);
    if (!record || record.deleted) return null;
    return record.data;
  }

  /**
   * Retrieves non-deleted records stored in this table, optionally filtered by a list of IDs.
   *
   * @param ids - Optional list of record identifiers to fetch. If omitted, retrieves all records.
   * @returns A promise resolving to an array of record data objects.
   */
  async getAll(ids?: string[]): Promise<T[]> {
    if (ids !== undefined) {
      if (ids.length === 0) return [];
      const map = await this.idb.getRecords<T>(this.storeName, ids);
      const results: T[] = [];
      for (const id of ids) {
        const rec = map.get(id);
        if (rec && !rec.deleted) {
          results.push(rec.data);
        }
      }
      return results;
    }
    const records = await this.idb.getAllRecords<T>(this.storeName);
    return records.filter((r) => !r.deleted).map((r) => r.data);
  }

  /**
   * Retrieves a single stored record including metadata (version, timestamp, deleted flag).
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the stored record with metadata, or `undefined` if not found.
   */
  async getWithMetadata(id: string): Promise<StoredRecord<T> | undefined> {
    return this.idb.getRecord<T>(this.storeName, id);
  }

  /**
   * Retrieves all records including deleted tombstones and metadata.
   *
   * @returns A promise resolving to an array of stored records with metadata.
   */
  async getAllWithMetadata(): Promise<StoredRecord<T>[]> {
    return this.idb.getAllRecords<T>(this.storeName, true);
  }

  /**
   * Stores or updates a record locally and triggers synchronization.
   *
   * @param id - The unique record identifier.
   * @param data - The data payload to save.
   * @returns A promise resolving to the saved data.
   */
  async put(id: string, data: T): Promise<T> {
    await this.putAll([{ id, data }]);
    return data;
  }

  /**
   * Atomically stores or updates multiple records locally in a single batch,
   * queues outbox mutations, notifies subscribers with an event list, and triggers synchronization.
   *
   * @param entries - Array of record entries to save.
   * @returns A promise resolving to the array of saved data objects.
   */
  async putAll(entries: TablePutEntry<T>[]): Promise<T[]> {
    if (entries.length === 0) return [];

    const ids = entries.map((e) => e.id);
    const existingMap = await this.idb.getRecords<T>(this.storeName, ids);
    const now = Date.now();
    const clientId = this.getClientId();

    const mutations: LocalMutationItem<T>[] = [];
    const events: TableChangeEvent<T>[] = [];
    const savedData: T[] = [];

    for (const entry of entries) {
      const existing = existingMap.get(entry.id);
      const version = (existing?.version ?? 0) + 1;

      const change: ChangeRecord<T> = {
        store: this.storeName,
        id: entry.id,
        op: OperationType.Put,
        data: entry.data,
        timestamp: now,
        clientId,
        version,
      };

      mutations.push({
        id: entry.id,
        op: OperationType.Put,
        data: entry.data,
        change,
      });

      events.push({
        op: OperationType.Put,
        id: entry.id,
        data: entry.data,
        isRemote: false,
      });

      savedData.push(entry.data);
    }

    await this.idb.applyLocalChanges(this.storeName, mutations);
    this.notifyListeners(events);
    this.onLocalChange?.();
    return savedData;
  }

  /**
   * Deletes a record locally by creating a tombstone and triggers synchronization.
   *
   * @param id - The unique record identifier to delete.
   * @returns A promise resolving to `true` if the record existed and was deleted; otherwise `false`.
   */
  async delete(id: string): Promise<boolean> {
    const deletedCount = await this.deleteAll([id]);
    return deletedCount > 0;
  }

  /**
   * Atomically deletes multiple records locally in a single batch,
   * creates tombstones, notifies subscribers with an event list, and triggers synchronization.
   *
   * @param ids - Array of record identifiers to delete.
   * @returns A promise resolving to the count of records that existed and were deleted.
   */
  async deleteAll(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const existingMap = await this.idb.getRecords<T>(this.storeName, ids);
    const now = Date.now();
    const clientId = this.getClientId();

    const mutations: LocalMutationItem<T>[] = [];
    const events: TableChangeEvent<T>[] = [];

    for (const id of ids) {
      const existing = existingMap.get(id);
      if (!existing || existing.deleted) continue;

      const version = (existing.version ?? 0) + 1;
      const change: ChangeRecord<T> = {
        store: this.storeName,
        id,
        op: OperationType.Delete,
        timestamp: now,
        clientId,
        version,
        deleted: true,
      };

      mutations.push({
        id,
        op: OperationType.Delete,
        change,
      });

      events.push({
        op: OperationType.Delete,
        id,
        isRemote: false,
      });
    }

    if (mutations.length > 0) {
      await this.idb.applyLocalChanges(this.storeName, mutations);
      this.notifyListeners(events);
      this.onLocalChange?.();
    }

    return mutations.length;
  }

  /**
   * Subscribes to mutation events occurring on this table (both local and remote sync changes).
   * The listener always receives a list of `TableChangeEvent` objects.
   *
   * @param listener - The change listener function to invoke on mutations.
   * @returns An unsubscribe function to remove the listener.
   */
  subscribe(listener: TableChangeListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notifies registered subscribers of remote change events.
   *
   * @param events - The list of remote change events.
   */
  notifyRemoteChanges(events: TableChangeEvent<unknown>[]): void {
    this.notifyListeners(events as TableChangeEvent<T>[]);
  }

  private notifyListeners(events: TableChangeEvent<T>[]): void {
    if (events.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(events);
      } catch (err) {
        console.error(
          `[BeamedDB] Error in listener for ${this.storeName}:`,
          err,
        );
      }
    }
  }
}
