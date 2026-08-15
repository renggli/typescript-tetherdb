import { shouldOverwrite } from '../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../shared/types.js';
import type { IDBManager } from './idb.js';

/**
 * Event notification callback fired when a record is inserted, updated, or deleted.
 *
 * @typeParam T - Data payload type.
 * @param event - Change event details including operation type, record ID, and origin flag.
 */
export type TableChangeListener<T> = (event: {
  /** The mutation operation type. */
  op: OperationType;
  /** The affected record identifier. */
  id: string;
  /** The new record data (defined on 'put' operations). */
  data?: T;
  /** `true` if the change originated from remote synchronization; `false` if triggered locally. */
  isRemote?: boolean;
}) => void;

/**
 * Abstract interface representing an object store table capable of ingesting remote sync records.
 */
export interface ITable {
  /** The unique name of the table / object store. */
  readonly name: string;
  /**
   * Applies a remote record with Last-Write-Wins conflict resolution.
   *
   * @param record - The remote record to apply.
   * @returns A promise resolving to `true` if applied, or `false` if rejected due to conflict resolution.
   */
  applyRemoteRecord(record: StoredRecord<unknown>): Promise<boolean>;
}

/**
 * Typed table wrapper providing local-first CRUD operations and reactive event subscriptions
 * against an underlying IndexedDB object store.
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
   * @param onLocalChange - Optional callback invoked after a local mutation is committed.
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
   * The name of this table.
   */
  get name(): string {
    return this.storeName;
  }

  /**
   * Retrieves a record payload by identifier.
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the record data payload, or `null` if not found or deleted.
   */
  async get(id: string): Promise<T | null> {
    const record = await this.idb.getRecord<T>(this.storeName, id);
    if (!record || record.deleted) return null;
    return record.data;
  }

  /**
   * Retrieves a record along with its internal metadata (timestamp, version, deleted status).
   *
   * @param id - The unique record identifier.
   * @returns A promise resolving to the stored record with metadata, or `null` if not found or deleted.
   */
  async getWithMetadata(id: string): Promise<StoredRecord<T> | null> {
    const record = await this.idb.getRecord<T>(this.storeName, id);
    if (!record || record.deleted) return null;
    return record;
  }

  /**
   * Retrieves all non-deleted record payloads in this table.
   *
   * @returns A promise resolving to an array of record data payloads.
   */
  async getAll(): Promise<T[]> {
    const records = await this.idb.getAllRecords<T>(this.storeName);
    return records.map((r) => r.data);
  }

  /**
   * Retrieves all active records along with their metadata.
   *
   * @returns A promise resolving to an array of stored records with metadata.
   */
  async getAllWithMetadata(): Promise<StoredRecord<T>[]> {
    return this.idb.getAllRecords<T>(this.storeName);
  }

  /**
   * Stores or updates a record locally, queues an outbox mutation entry,
   * notifies subscribers, and triggers background synchronization.
   *
   * @param id - The unique record identifier.
   * @param data - The data payload to save.
   * @returns A promise resolving to the saved data.
   */
  async put(id: string, data: T): Promise<T> {
    const existing = await this.idb.getRecord<T>(this.storeName, id);
    const now = Date.now();
    const version = (existing?.version ?? 0) + 1;
    const clientId = this.getClientId();

    const change: ChangeRecord<T> = {
      store: this.storeName,
      id,
      op: OperationType.Put,
      data,
      timestamp: now,
      clientId,
      version,
    };

    await this.idb.applyLocalChange(
      this.storeName,
      id,
      OperationType.Put,
      data,
      change,
    );
    this.notifyListeners({ op: OperationType.Put, id, data, isRemote: false });
    this.onLocalChange?.();
    return data;
  }

  /**
   * Deletes a record locally by creating a tombstone, queues an outbox mutation entry,
   * notifies subscribers, and triggers background synchronization.
   *
   * @param id - The unique record identifier to delete.
   * @returns A promise resolving to `true` if the record existed and was deleted; otherwise `false`.
   */
  async delete(id: string): Promise<boolean> {
    const existing = await this.idb.getRecord<T>(this.storeName, id);
    if (!existing || existing.deleted) return false;

    const now = Date.now();
    const version = (existing?.version ?? 0) + 1;
    const clientId = this.getClientId();

    const change: ChangeRecord<T> = {
      store: this.storeName,
      id,
      op: OperationType.Delete,
      timestamp: now,
      clientId,
      version,
      deleted: true,
    };

    await this.idb.applyLocalChange(
      this.storeName,
      id,
      OperationType.Delete,
      undefined,
      change,
    );
    this.notifyListeners({ op: OperationType.Delete, id, isRemote: false });
    this.onLocalChange?.();
    return true;
  }

  /**
   * Subscribes to mutation events occurring on this table (both local and remote sync changes).
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
   * Ingests a remote record into local storage applying Last-Write-Wins rules.
   *
   * @param record - The remote record to apply.
   * @returns A promise resolving to `true` if accepted and applied; otherwise `false`.
   */
  async applyRemoteRecord(record: StoredRecord<T>): Promise<boolean> {
    const existing = await this.idb.getRecord<T>(this.storeName, record.id);
    if (existing && !shouldOverwrite(record, existing)) {
      return false;
    }

    await this.idb.applyRemoteRecord(this.storeName, record);
    this.notifyListeners({
      op: record.deleted ? OperationType.Delete : OperationType.Put,
      id: record.id,
      data: record.deleted ? undefined : record.data,
      isRemote: true,
    });
    return true;
  }

  private notifyListeners(event: {
    op: OperationType;
    id: string;
    data?: T;
    isRemote?: boolean;
  }) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(
          `[BeamedDB] Error in listener for ${this.storeName}:`,
          err,
        );
      }
    }
  }
}
