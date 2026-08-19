import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../shared/types.js';
import { EventRegistry } from './shared/event.js';
import type { LocalMutationItem, Storage } from './storage.js';

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
 * Typed table wrapper providing local-first CRUD operations and reactive event subscriptions
 * against an underlying IndexedDB table.
 * Operations are batched by default for maximum performance.
 *
 * @typeParam T - The data type of records stored in this table.
 */
export class Table<T = unknown> {
  /** Reactive event registry triggered when records in this table are created, updated, or deleted. */
  readonly onChange = new EventRegistry<TableChangeEvent<T>[]>();
  private tableName: string;
  private storage: Storage;

  /**
   * Creates a new Table instance.
   *
   * @param tableName - Name of the table.
   * @param storage - Local storage coordinator.
   */
  constructor(tableName: string, storage: Storage) {
    this.tableName = tableName;
    this.storage = storage;
  }

  /**
   * The name of the table.
   */
  get name(): string {
    return this.tableName;
  }

  /**
   * The client identifier for local mutations.
   */
  get clientId(): string {
    return this.storage.clientId;
  }

  /**
   * Retrieves a single record by its identifier.
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the record data, or `undefined` if not found.
   */
  async get(id: string): Promise<T | undefined> {
    const record = await this.storage.getRecord<T>(this.tableName, id);
    return record?.data;
  }

  /**
   * Retrieves records stored in this table, optionally filtered by a list of IDs.
   *
   * @param ids - Optional list of record identifiers to fetch. If omitted, retrieves all records.
   * @returns A promise resolving to an array of record data objects.
   */
  async getAll(ids?: string[]): Promise<T[]> {
    if (ids !== undefined) {
      if (ids.length === 0) return [];
      const map = await this.storage.getRecords<T>(this.tableName, ids);
      const results: T[] = [];
      for (const id of ids) {
        const rec = map.get(id);
        if (rec) {
          results.push(rec.data);
        }
      }
      return results;
    }
    const records = await this.storage.getAllRecords<T>(this.tableName);
    return records.map((r) => r.data);
  }

  /**
   * Deletes all records in this table and queues tombstones for synchronization.
   *
   * @returns A promise resolving to the number of deleted records.
   */
  async clear(): Promise<number> {
    const records = await this.storage.getAllRecords<T>(this.tableName);
    const ids = records.map((r) => r.id);
    return this.deleteAll(ids);
  }

  /**
   * Retrieves a single stored record including metadata (version, timestamp).
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the stored record with metadata, or `undefined` if not found.
   */
  async getWithMetadata(id: string): Promise<StoredRecord<T> | undefined> {
    return this.storage.getRecord<T>(this.tableName, id);
  }

  /**
   * Retrieves all records with storage metadata (version, timestamp).
   *
   * @returns A promise resolving to an array of stored records with metadata.
   */
  async getAllWithMetadata(): Promise<StoredRecord<T>[]> {
    return this.storage.getAllRecords<T>(this.tableName);
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
    const existingMap = await this.storage.getRecords<T>(this.tableName, ids);
    const now = Date.now();
    const clientId = this.clientId;

    const mutations: LocalMutationItem<T>[] = [];
    const events: TableChangeEvent<T>[] = [];
    const savedData: T[] = [];

    for (const entry of entries) {
      const existing = existingMap.get(entry.id);
      const version = (existing?.version ?? 0) + 1;
      const timestamp = Math.max(now, (existing?.timestamp ?? 0) + 1);

      const change: ChangeRecord<T> = {
        table: this.tableName,
        id: entry.id,
        op: OperationType.Put,
        data: entry.data,
        timestamp,
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

    await this.storage.applyLocalChanges(this.tableName, mutations);
    this.onChange.publish(events);
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

    const existingMap = await this.storage.getRecords<T>(this.tableName, ids);
    const now = Date.now();
    const clientId = this.clientId;

    const mutations: LocalMutationItem<T>[] = [];
    const events: TableChangeEvent<T>[] = [];

    for (const id of ids) {
      const existing = existingMap.get(id);
      if (!existing || existing.deleted) continue;

      const version = (existing.version ?? 0) + 1;
      const timestamp = Math.max(now, (existing.timestamp ?? 0) + 1);
      const change: ChangeRecord<T> = {
        table: this.tableName,
        id,
        op: OperationType.Delete,
        timestamp,
        clientId,
        version,
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
      await this.storage.applyLocalChanges(this.tableName, mutations);
      this.onChange.publish(events);
    }

    return mutations.length;
  }

  /**
   * Subscribes to the complete list of records in this table.
   * Immediately invokes the listener with the current records, and re-invokes it
   * whenever any local or remote mutations occur on this table.
   *
   * @param listener - Callback receiving the latest array of records.
   * @returns An unsubscribe function.
   */
  subscribeAll(listener: (items: T[]) => void): () => void {
    let isActive = true;
    let currentVersion = 0;
    const fetchAndNotify = () => {
      const version = ++currentVersion;
      this.getAll()
        .then((items) => {
          if (isActive && version === currentVersion) {
            listener(items);
          }
        })
        .catch(() => {
          // Ignore fetch error during unmounted subscription initialization
        });
    };

    fetchAndNotify();
    const unsubscribe = this.onChange.register(() => {
      fetchAndNotify();
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }

  /**
   * Notifies registered subscribers of remote change events.
   *
   * @param events - The list of remote change events.
   */
  notifyRemoteChanges(events: TableChangeEvent<unknown>[]): void {
    if (events.length === 0) return;
    this.onChange.publish(events as TableChangeEvent<T>[]);
  }
}
