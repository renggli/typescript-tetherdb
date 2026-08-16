import { generateClientId } from '../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../shared/types.js';
import { type ITable, Table } from './table.js';

/** Internal IndexedDB object store name used for queuing pending outgoing mutations. */
export const OUTBOX_STORE = '__tether_outbox';

/** Internal IndexedDB object store name used for client metadata and sync progression tracking. */
export const META_STORE = '__tether_meta';

/**
 * Represents a pending mutation queue item within the internal IndexedDB outbox.
 */
export interface OutboxEntry {
  /** Auto-incrementing primary key in the outbox object store. */
  localId?: number;
  /** Transient batch correlation identifier. */
  batchId?: string;
  /** The mutation change record to be synced to the server. */
  change: ChangeRecord;
  /** Epoch timestamp when the entry was queued locally. */
  createdAt: number;
}

/**
 * Mutation item payload passed to `Storage.applyLocalChanges`.
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
 * Atomic transaction and local persistence manager wrapping IndexedDB.
 * Coordinates user table stores, pending outbox changelogs, and sync metadata.
 */
export class Storage {
  readonly name: string;
  readonly clientId: string;
  private databasePromise: Promise<IDBDatabase> | null = null;
  private tables: Map<string, ITable> = new Map();
  private localChangeListeners: Set<() => void> = new Set();

  /**
   * Creates a new Storage instance.
   *
   * @param name - Name of the IndexedDB database.
   */
  constructor(name: string) {
    this.name = name;
    this.clientId = generateClientId();
  }

  /**
   * Registers a listener callback invoked whenever local mutations are committed.
   *
   * @param listener - Callback function.
   * @returns Unsubscribe function to remove the listener.
   */
  onLocalChange(listener: () => void): () => void {
    this.localChangeListeners.add(listener);
    return () => {
      this.localChangeListeners.delete(listener);
    };
  }

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
   *
   * @typeParam T - Data payload model type for records in this table.
   * @param name - The table name.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(name: string): Table<T> {
    let tbl = this.tables.get(name);
    if (!tbl) {
      tbl = new Table<T>(name, this);
      this.tables.set(name, tbl);
    }
    return tbl as Table<T>;
  }

  /**
   * Opens or returns the active IndexedDB connection, executing schema upgrades when needed.
   *
   * @returns A promise resolving to the open IDBDatabase instance.
   */
  async getDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = this.openDatabase();
    return this.databasePromise;
  }

  /**
   * Dynamically ensures that multiple application tables exist in IndexedDB.
   *
   * @param tableNames - Array of table names to ensure.
   */
  async ensureTables(tableNames: string[]): Promise<void> {
    const db = await this.getDatabase();
    const missing = tableNames.filter((s) => !db.objectStoreNames.contains(s));
    if (missing.length === 0) return;

    const nextVersion = db.version + 1;
    this.databasePromise = this.upgradeDatabase(db, nextVersion, missing);
    await this.databasePromise;
  }

  /**
   * Ensures a single application table exists in IndexedDB.
   *
   * @param tableName - Name of the table to ensure.
   */
  async ensureTable(tableName: string): Promise<void> {
    await this.ensureTables([tableName]);
  }

  /**
   * Retrieves a metadata value from the internal metadata store.
   *
   * @typeParam T - Expected value type.
   * @param key - The metadata key identifier.
   * @returns The stored metadata value, or `undefined` if not set.
   */
  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const store = tx.objectStore(META_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.value);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Sets a metadata value in the internal metadata store.
   *
   * @param key - The metadata key identifier.
   * @param value - The value to store.
   */
  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Deletes a metadata entry from the internal metadata store.
   *
   * @param key - The metadata key identifier.
   */
  async deleteMeta(key: string): Promise<void> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves a single stored record by table and identifier.
   *
   * @typeParam T - Expected payload type.
   * @param tableName - Table name.
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found.
   */
  async getRecord<T = unknown>(
    tableName: string,
    id: string,
  ): Promise<StoredRecord<T> | undefined> {
    await this.ensureTable(tableName);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves multiple stored records by their identifiers in a single readonly transaction.
   *
   * @typeParam T - Expected payload type.
   * @param tableName - Table name.
   * @param ids - Array of record identifiers.
   * @returns Map of found stored records keyed by id.
   */
  async getRecords<T = unknown>(
    tableName: string,
    ids: string[],
  ): Promise<Map<string, StoredRecord<T>>> {
    if (ids.length === 0) return new Map();
    await this.ensureTable(tableName);
    const db = await this.getDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
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
   * @param tableName - Table name.
   * @returns Array of stored records with metadata.
   */
  async getAllRecords<T = unknown>(
    tableName: string,
  ): Promise<StoredRecord<T>[]> {
    await this.ensureTable(tableName);
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
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
   * @param tableName - Target table name.
   * @param mutations - List of mutations to apply and queue into outbox.
   * @returns Array of newly stored records with updated metadata.
   */
  async applyLocalChanges<T = unknown>(
    tableName: string,
    mutations: LocalMutationItem<T>[],
  ): Promise<StoredRecord<T>[]> {
    if (mutations.length === 0) return [];
    await this.ensureTable(tableName);
    const db = await this.getDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction([tableName, OUTBOX_STORE], 'readwrite');
      const dataStore = tx.objectStore(tableName);
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

      tx.oncomplete = () => {
        this.notifyLocalChange();
        resolve(records);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves all currently queued outbox entries awaiting sync.
   *
   * @param limit - Optional maximum number of entries to retrieve.
   * @returns Array of pending outbox queue items.
   */
  async getPendingOutbox(limit?: number): Promise<OutboxEntry[]> {
    const db = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      const store = tx.objectStore(OUTBOX_STORE);
      const req = limit ? store.getAll(null, limit) : store.getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Clears acknowledged changes from the outbox by their local database IDs.
   *
   * @param localIds - Array of auto-incremented local outbox IDs to remove.
   */
  async removeOutboxEntries(localIds: number[]): Promise<void> {
    if (localIds.length === 0) return;
    const db = await this.getDatabase();
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
   * Applies an entire snapshot batch across tables atomically in a single transaction.
   *
   * @param snapshot - Array of record items to persist.
   * @param seq - Global sequence number corresponding to this snapshot.
   */
  async applySnapshotBatch(
    snapshot: Array<{
      table: string;
      id: string;
      data: unknown;
      timestamp: number;
      version: number;
      deleted?: boolean;
    }>,
    seq: number,
  ): Promise<void> {
    const tablesInSnapshot = Array.from(
      new Set(snapshot.map((item) => item.table)),
    ).filter(Boolean);
    await this.ensureTables(tablesInSnapshot);
    const db = await this.getDatabase();

    return new Promise((resolve, reject) => {
      const txStores = [...tablesInSnapshot, META_STORE];
      const tx = db.transaction(txStores, 'readwrite');

      const tableObjects = new Map<string, IDBObjectStore>();
      for (const t of tablesInSnapshot) {
        tableObjects.set(t, tx.objectStore(t));
      }

      for (const item of snapshot) {
        const objStore = tableObjects.get(item.table);
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
      metaStore.put({ key: 'lastSyncTimestamp', value: Date.now() });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Applies a batch of incoming remote delta mutations atomically across tables
   * in a single IndexedDB transaction without generating local outbox echo entries.
   *
   * @param changes - Array of change records received from the server.
   * @param seq - New sequence number to record upon transaction commit.
   */
  async applyRemoteChangesBatch(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    if (changes.length === 0) {
      await this.setMeta('lastSyncSeq', seq);
      return;
    }

    const tablesInChanges = Array.from(
      new Set(changes.map((c) => c.table)),
    ).filter(Boolean);
    await this.ensureTables(tablesInChanges);
    const db = await this.getDatabase();

    return new Promise((resolve, reject) => {
      const txStores = [...tablesInChanges, META_STORE];
      const tx = db.transaction(txStores, 'readwrite');

      const tableObjects = new Map<string, IDBObjectStore>();
      for (const t of tablesInChanges) {
        tableObjects.set(t, tx.objectStore(t));
      }

      for (const change of changes) {
        const objStore = tableObjects.get(change.table);
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
      metaStore.put({ key: 'lastSyncTimestamp', value: Date.now() });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clears only user table stores, leaving internal metadata and outbox intact if desired.
   *
   * @param clearOutbox - Whether to clear the pending outbox queue as well (defaults to `true`).
   */
  async clearTables(clearOutbox = true): Promise<void> {
    const db = await this.getDatabase();
    const storeNames = Array.from(db.objectStoreNames).filter((name) => {
      if (name === META_STORE) return false;
      if (name === OUTBOX_STORE && !clearOutbox) return false;
      return true;
    });
    if (storeNames.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');
      for (const name of storeNames) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Clears all local table stores, outbox changelog entries, and metadata.
   */
  async clearAllData(): Promise<void> {
    const db = await this.getDatabase();
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');
      for (const name of storeNames) {
        tx.objectStore(name).clear();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Closes the active IndexedDB connection.
   */
  async close(): Promise<void> {
    if (this.databasePromise) {
      const db = await this.databasePromise;
      db.close();
      this.databasePromise = null;
    }
  }

  // -- Private Helpers ------------------------------------------------------

  private notifyLocalChange(): void {
    for (const listener of this.localChangeListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[Storage] Local change listener error:', err);
      }
    }
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name);

      request.onupgradeneeded = () => {
        this.createInternalStores(request.result);
      };

      request.onsuccess = () => {
        const db = request.result;
        if (
          !db.objectStoreNames.contains(OUTBOX_STORE) ||
          !db.objectStoreNames.contains(META_STORE)
        ) {
          const nextVersion = db.version + 1;
          this.upgradeDatabase(db, nextVersion, []).then(resolve).catch(reject);
        } else {
          resolve(db);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  private async upgradeDatabase(
    currentDb: IDBDatabase,
    nextVersion: number,
    newTables: string[],
  ): Promise<IDBDatabase> {
    currentDb.close();
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, nextVersion);

      request.onupgradeneeded = () => {
        const db = request.result;
        this.createInternalStores(db);
        for (const tableName of newTables) {
          if (!db.objectStoreNames.contains(tableName)) {
            db.createObjectStore(tableName, { keyPath: 'id' });
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private createInternalStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
      db.createObjectStore(OUTBOX_STORE, {
        keyPath: 'localId',
        autoIncrement: true,
      });
    }
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE, { keyPath: 'key' });
    }
  }
}
