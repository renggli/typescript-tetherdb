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
 * Mutation item payload passed to `IDBManager.applyLocalChanges`.
 */
export interface LocalMutationItem<T = unknown> {
  /** Target record identifier. */
  id: string;
  /** Mutation operation type. */
  op: OperationType;
  /** Record data payload (defined on put). */
  data?: T;
  /** Correlated changelog entry to queue in outbox. */
  change: ChangeRecord<T>;
}

/**
 * Atomic transaction coordinator managing user object stores alongside
 * internal outbox changelogs and sync metadata stores.
 * All mutations and ingestion workflows are batched by default.
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
   * Dynamically ensures that multiple application object stores exist in IndexedDB.
   *
   * @param storeNames - Array of table/object store names to ensure.
   */
  async ensureStores(storeNames: string[]): Promise<void> {
    const missing = storeNames.filter((s) => !this.storeNames.has(s));
    if (missing.length === 0) return;

    for (const s of missing) {
      this.storeNames.add(s);
    }

    const db = await this.getDB();
    const needsUpgrade = missing.some((s) => !db.objectStoreNames.contains(s));
    if (!needsUpgrade) return;

    db.close();
    this.version += 1;
    this.dbPromise = null;
    await this.getDB();
  }

  /**
   * Ensures a single application object store exists in IndexedDB.
   *
   * @param storeName - Name of the store to ensure.
   */
  async ensureStore(storeName: string): Promise<void> {
    await this.ensureStores([storeName]);
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
   * Retrieves a single stored record by table and identifier.
   *
   * @typeParam T - Expected payload type.
   * @param storeName - Table/store name.
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found.
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
   * Retrieves multiple stored records by their identifiers in a single readonly transaction.
   *
   * @typeParam T - Expected payload type.
   * @param storeName - Table/store name.
   * @param ids - Array of record identifiers.
   * @returns Map of found stored records keyed by id.
   */
  async getRecords<T = unknown>(
    storeName: string,
    ids: string[],
  ): Promise<Map<string, StoredRecord<T>>> {
    if (ids.length === 0) return new Map();
    await this.ensureStore(storeName);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const results = new Map<string, StoredRecord<T>>();

      for (const id of ids) {
        const req = store.get(id);
        req.onsuccess = () => {
          if (req.result) {
            results.set(id, req.result);
          }
        };
      }

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves stored records from a specified table.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Table/store name.
   * @returns Array of stored records with metadata.
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
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Atomically persists a batch of local mutations alongside outbox changelog entries
   * within a single IndexedDB transaction.
   *
   * @typeParam T - Data payload type.
   * @param storeName - Target table name.
   * @param mutations - List of mutations to apply and queue into outbox.
   * @returns Array of newly stored records with updated metadata.
   */
  async applyLocalChanges<T = unknown>(
    storeName: string,
    mutations: LocalMutationItem<T>[],
  ): Promise<StoredRecord<T>[]> {
    if (mutations.length === 0) return [];
    await this.ensureStore(storeName);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName, OUTBOX_STORE], 'readwrite');
      const dataStore = tx.objectStore(storeName);
      const outboxStore = tx.objectStore(OUTBOX_STORE);
      const records: StoredRecord<T>[] = [];
      const now = Date.now();

      for (const item of mutations) {
        const isDelete = item.op === OperationType.Delete;
        const record: StoredRecord<T> = {
          id: item.id,
          data: (item.data ?? null) as T,
          timestamp: item.change.timestamp,
          version: item.change.version ?? 1,
          deleted: isDelete,
        };

        if (isDelete) {
          dataStore.delete(item.id);
        } else {
          dataStore.put(record);
        }

        outboxStore.add({
          change: item.change,
          createdAt: now,
        });
        records.push(record);
      }

      tx.oncomplete = () => resolve(records);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Ingests a complete snapshot of records across tables in a single atomic IndexedDB transaction.
   *
   * @param snapshot - All active snapshot record items across stores.
   * @param seq - Global sequence number corresponding to the snapshot.
   */
  async applySnapshotBatch(
    snapshot: Array<{
      store: string;
      id: string;
      data: unknown;
      timestamp: number;
      version: number;
      deleted?: boolean;
    }>,
    seq: number,
  ): Promise<void> {
    if (snapshot.length === 0) {
      await this.setMeta('lastSyncSeq', seq);
      return;
    }

    const storesInSnapshot = Array.from(new Set(snapshot.map((s) => s.store)));
    await this.ensureStores(storesInSnapshot);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const txStores = [...storesInSnapshot, META_STORE];
      const tx = db.transaction(txStores, 'readwrite');

      const storeObjects = new Map<string, IDBObjectStore>();
      for (const s of storesInSnapshot) {
        storeObjects.set(s, tx.objectStore(s));
      }

      for (const item of snapshot) {
        const objStore = storeObjects.get(item.store);
        if (objStore) {
          if (item.deleted) {
            objStore.delete(item.id);
          } else {
            const record: StoredRecord = {
              id: item.id,
              data: item.data,
              timestamp: item.timestamp,
              version: item.version,
            };
            objStore.put(record);
          }
        }
      }

      const metaStore = tx.objectStore(META_STORE);
      metaStore.put({ key: 'lastSyncSeq', value: seq });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Ingests an array of remote change diff operations in a single atomic IndexedDB transaction.
   *
   * @param changes - Array of change records received from server.
   * @param seq - New sequence number to store in metadata.
   */
  async applyRemoteChangesBatch(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    if (changes.length === 0) {
      await this.setMeta('lastSyncSeq', seq);
      return;
    }

    const storesInChanges = Array.from(new Set(changes.map((c) => c.store)));
    await this.ensureStores(storesInChanges);
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const txStores = [...storesInChanges, META_STORE];
      const tx = db.transaction(txStores, 'readwrite');

      const storeObjects = new Map<string, IDBObjectStore>();
      for (const s of storesInChanges) {
        storeObjects.set(s, tx.objectStore(s));
      }

      for (const change of changes) {
        const objStore = storeObjects.get(change.store);
        if (objStore) {
          const isDelete =
            change.op === OperationType.Delete || Boolean(change.deleted);
          if (isDelete) {
            objStore.delete(change.id);
          } else {
            const record: StoredRecord = {
              id: change.id,
              data: change.data,
              timestamp: change.timestamp,
              version: change.version ?? 1,
            };
            objStore.put(record);
          }
        }
      }

      const metaStore = tx.objectStore(META_STORE);
      metaStore.put({ key: 'lastSyncSeq', value: seq });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves all queued entries currently awaiting synchronization from the outbox.
   *
   * @param limit - Optional maximum number of entries to retrieve.
   * @returns Array of outbox queue entries.
   */
  async getPendingOutbox(limit?: number): Promise<OutboxEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);
      const req = store.getAll(undefined, limit);
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
   * Clears all user application object stores, outbox queue entries, and metadata.
   */
  async clearAllData(): Promise<void> {
    const db = await this.getDB();
    const stores = Array.from(db.objectStoreNames);
    if (stores.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const storeName of stores) {
        tx.objectStore(storeName).clear();
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
