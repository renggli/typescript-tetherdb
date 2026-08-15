import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../shared/types.js';

/** Internal IndexedDB object store name used for queuing pending outgoing mutations. */
export const OUTBOX_STORE = '__beamed_outbox';

/** Internal IndexedDB object store name used for client metadata and sync progression tracking. */
export const META_STORE = '__beamed_meta';

/**
 * Represents a pending mutation queue item within the internal IndexedDB outbox.
 */
export interface OutboxEntry {
  /** Auto-incrementing primary key in the outbox object store. */
  localId?: number;
  /** Transient batch correlation identifier. */
  batchId?: string;
  /** The mutation change record to be beamed to the server. */
  change: ChangeRecord;
  /** Epoch timestamp when the entry was queued locally. */
  createdAt: number;
}

/**
 * Atomic transaction coordinator managing user object stores alongside
 * internal outbox changelogs and sync metadata stores.
 */
export class IDBManager {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private dbName: string;
  private version: number;
  private storeNames: Set<string>;

  /**
   * Creates a new IDBManager instance.
   *
   * @param dbName - Name of the IndexedDB database.
   * @param initialStores - Array of application table/store names to initialize.
   * @param version - Database schema version (defaults to 1).
   */
  constructor(dbName: string, initialStores: string[] = [], version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.storeNames = new Set(initialStores);
  }

  /**
   * Opens or returns the active IndexedDB connection, executing schema upgrades when needed.
   *
   * @returns A promise resolving to the open IDBDatabase instance.
   */
  async getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (_event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, {
            keyPath: 'localId',
            autoIncrement: true,
          });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
        for (const storeName of this.storeNames) {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /**
   * Dynamically ensures that an application object store exists in IndexedDB,
   * performing a version upgrade if necessary.
   *
   * @param storeName - Name of the table/object store to ensure.
   */
  async ensureStore(storeName: string): Promise<void> {
    if (this.storeNames.has(storeName)) return;
    this.storeNames.add(storeName);

    const db = await this.getDB();
    if (db.objectStoreNames.contains(storeName)) return;

    // Upgrade DB version to add new store
    db.close();
    this.version += 1;
    this.dbPromise = null;
    await this.getDB();
  }

  /**
   * Retrieves a metadata value from the internal metadata store.
   *
   * @typeParam T - Expected value type.
   * @param key - The metadata key identifier.
   * @returns The stored metadata value, or `undefined` if not set.
   */
  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Sets a metadata value in the internal metadata store.
   *
   * @typeParam T - Value type.
   * @param key - The metadata key identifier.
   * @param value - The value to store.
   */
  async setMeta<T = unknown>(key: string, value: T): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves a single record by identifier from a specified table.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Table/store name.
   * @param id - Record identifier.
   * @returns Stored record with metadata, or `undefined` if not found.
   */
  async getRecord<T = unknown>(
    storeName: string,
    id: string,
  ): Promise<StoredRecord<T> | undefined> {
    await this.ensureStore(storeName);
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves all non-deleted records from a specified table.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Table/store name.
   * @returns Array of active stored records with metadata.
   */
  async getAllRecords<T = unknown>(
    storeName: string,
  ): Promise<StoredRecord<T>[]> {
    await this.ensureStore(storeName);
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        const results: StoredRecord<T>[] = req.result ?? [];
        resolve(results.filter((r) => !r.deleted));
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Atomically persists a local record mutation alongside an outbox changelog entry
   * within a single IndexedDB transaction.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Table/store name.
   * @param id - Record identifier.
   * @param op - Operation type (`OperationType.Put` or `OperationType.Delete`).
   * @param data - Record data payload for 'put' operations.
   * @param change - Change record to queue in the outbox.
   * @returns The newly stored record with metadata.
   */
  async applyLocalChange<T = unknown>(
    storeName: string,
    id: string,
    op: OperationType,
    data: T | undefined,
    change: ChangeRecord<T>,
  ): Promise<StoredRecord<T>> {
    await this.ensureStore(storeName);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName, OUTBOX_STORE], 'readwrite');
      const dataStore = tx.objectStore(storeName);
      const outboxStore = tx.objectStore(OUTBOX_STORE);

      const record: StoredRecord<T> = {
        id,
        data: (data ?? null) as T,
        timestamp: change.timestamp,
        version: change.version ?? 1,
        deleted: op === OperationType.Delete,
      };

      dataStore.put(record);
      outboxStore.add({
        change,
        createdAt: Date.now(),
      });

      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Applies a remote record received from synchronization without creating an outbox entry.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Table/store name.
   * @param record - Remote record to store locally.
   */
  async applyRemoteRecord<T = unknown>(
    storeName: string,
    record: StoredRecord<T>,
  ): Promise<void> {
    await this.ensureStore(storeName);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves all queued entries currently awaiting synchronization from the outbox.
   *
   * @returns Array of outbox queue entries.
   */
  async getPendingOutbox(): Promise<OutboxEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Deletes acknowledged mutation entries from the outbox store by localId.
   *
   * @param localIds - Array of outbox primary keys to remove.
   */
  async removeOutboxEntries(localIds: number[]): Promise<void> {
    if (localIds.length === 0) return;
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);
      for (const id of localIds) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Closes the active IndexedDB connection.
   */
  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
