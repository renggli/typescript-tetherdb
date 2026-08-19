import { shouldOverwrite } from '../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type SnapshotRecord,
  type StoredRecord,
} from '../shared/types.js';
import { EventRegistry } from './shared/event.js';
import { randomUUID } from './shared/id.js';
import { Table } from './table.js';

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
  /** Name of the local IndexedDB database. */
  readonly name: string;
  /** Unique client instance identifier used for monotonic logical clock tie-breaking. */
  readonly clientId: string;
  /** Reactive event registry triggered when mutations are committed to the local database. */
  readonly onLocalChange = new EventRegistry<void>();
  private databasePromise: Promise<IDBDatabase> | null = null;
  private schemaMutex: Promise<void> = Promise.resolve();
  private tables: Map<string, Table<unknown>> = new Map();

  /**
   * Creates a new Storage instance.
   *
   * @param name - Name of the IndexedDB database.
   */
  constructor(name: string) {
    this.name = name;
    this.clientId = randomUUID();
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
    let table = this.tables.get(name);
    if (!table) {
      table = new Table(name, this) as Table<unknown>;
      this.tables.set(name, table);
    }
    return table as unknown as Table<T>;
  }

  /**
   * Opens or returns the active IndexedDB connection, executing schema upgrades when needed.
   *
   * @returns A promise resolving to the open IDBDatabase instance.
   */
  async getDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = this.openDatabase().catch((err) => {
      this.databasePromise = null;
      throw err;
    });
    return this.databasePromise;
  }

  /**
   * Dynamically ensures that multiple application tables exist in IndexedDB.
   *
   * @param tableNames - Array of table names to ensure.
   */
  async ensureTables(tableNames: string[]): Promise<void> {
    this.schemaMutex = this.schemaMutex.then(async () => {
      const database = await this.getDatabase();
      const missing = tableNames.filter(
        (s) => !database.objectStoreNames.contains(s),
      );
      if (missing.length === 0) return;
      const nextVersion = database.version + 1;
      this.databasePromise = this.upgradeDatabase(
        database,
        nextVersion,
        missing,
      ).catch((err) => {
        this.databasePromise = null;
        throw err;
      });
      await this.databasePromise;
    });
    return this.schemaMutex;
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
    return this.withDatabase(async (database) => {
      const entry = await promisifyRequest<
        { key: string; value: T } | undefined
      >(
        database
          .transaction(META_STORE, 'readonly')
          .objectStore(META_STORE)
          .get(key),
      );
      return entry?.value;
    });
  }

  /**
   * Sets a metadata value in the internal metadata store.
   *
   * @param key - The metadata key identifier.
   * @param value - The value to store.
   */
  async setMeta(key: string, value: unknown): Promise<void> {
    return this.withDatabase(async (database) => {
      await promisifyRequest(
        database
          .transaction(META_STORE, 'readwrite')
          .objectStore(META_STORE)
          .put({ key, value }),
      );
    });
  }

  /**
   * Deletes a metadata entry from the internal metadata store.
   *
   * @param key - The metadata key identifier.
   */
  async deleteMeta(key: string): Promise<void> {
    return this.withDatabase(async (database) => {
      await promisifyRequest(
        database
          .transaction(META_STORE, 'readwrite')
          .objectStore(META_STORE)
          .delete(key),
      );
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
    return this.withDatabase(async (database) => {
      return promisifyRequest<StoredRecord<T> | undefined>(
        database
          .transaction(tableName, 'readonly')
          .objectStore(tableName)
          .get(id),
      );
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
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const results = new Map<string, StoredRecord<T>>();
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) {
            results.set(id, request.result);
          }
        };
      }
      await promisifyTransaction(tx);
      return results;
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
    return this.withDatabase(async (database) => {
      const records = await promisifyRequest<StoredRecord<T>[]>(
        database
          .transaction(tableName, 'readonly')
          .objectStore(tableName)
          .getAll(),
      );
      return records ?? [];
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
    return this.withDatabase(async (database) => {
      const tx = database.transaction([tableName, OUTBOX_STORE], 'readwrite');
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
          clientId: item.change.clientId,
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
      await promisifyTransaction(tx);
      this.onLocalChange.publish();
      return records;
    });
  }

  /**
   * Retrieves all currently queued outbox entries awaiting sync.
   *
   * @param limit - Optional maximum number of entries to retrieve.
   * @returns Array of pending outbox queue items.
   */
  async getPendingOutbox(limit?: number): Promise<OutboxEntry[]> {
    return this.withDatabase(async (database) => {
      const store = database
        .transaction(OUTBOX_STORE, 'readonly')
        .objectStore(OUTBOX_STORE);
      const req = limit ? store.getAll(null, limit) : store.getAll();
      const results = await promisifyRequest<OutboxEntry[]>(req);
      return results ?? [];
    });
  }

  /**
   * Clears acknowledged changes from the outbox by their local database IDs.
   *
   * @param localIds - Array of auto-incremented local outbox IDs to remove.
   */
  async removeOutboxEntries(localIds: number[]): Promise<void> {
    if (localIds.length === 0) return;
    return this.withDatabase(async (database) => {
      const tx = database.transaction(OUTBOX_STORE, 'readwrite');
      const store = tx.objectStore(OUTBOX_STORE);
      for (const id of localIds) {
        store.delete(id);
      }
      await promisifyTransaction(tx);
    });
  }

  /**
   * Applies an entire snapshot batch across tables atomically in a single transaction.
   *
   * @param snapshot - Array of record items to persist.
   * @param seq - Global sequence number corresponding to this snapshot.
   */
  async applySnapshotBatch(
    snapshot: SnapshotRecord[],
    seq: number,
  ): Promise<void> {
    await this.applyBatchRecords(snapshot, seq);
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

    const records: SnapshotRecord[] = changes.map((change) => ({
      table: change.table,
      id: change.id,
      data: change.data,
      timestamp: change.timestamp,
      version: change.version ?? 1,
      deleted: change.op === OperationType.Delete,
      clientId: change.clientId,
    }));

    await this.applyBatchRecords(records, seq);
  }

  /**
   * Clears only user table stores, leaving internal metadata and outbox intact if desired.
   *
   * @param clearOutbox - Whether to clear the pending outbox queue as well (defaults to `true`).
   */
  async clearTables(clearOutbox = true): Promise<void> {
    return this.withDatabase(async (db) => {
      const storeNames = Array.from(db.objectStoreNames).filter((name) => {
        if (name === META_STORE) return false;
        if (name === OUTBOX_STORE && !clearOutbox) return false;
        return true;
      });
      await this.clearStores(db, storeNames);
    });
  }

  /**
   * Clears all local table stores, outbox changelog entries, and metadata.
   */
  async clearAllData(): Promise<void> {
    return this.withDatabase(async (db) => {
      await this.clearStores(db, Array.from(db.objectStoreNames));
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

  private async withDatabase<R>(
    fn: (db: IDBDatabase) => Promise<R>,
  ): Promise<R> {
    return this.schemaMutex.then(async () => {
      const db = await this.getDatabase();
      return fn(db);
    });
  }

  private async applyBatchRecords(
    records: SnapshotRecord[],
    seq: number,
  ): Promise<void> {
    if (records.length === 0) {
      await this.setMeta('lastSyncSeq', seq);
      return;
    }

    const tableNames = Array.from(
      new Set(records.map((item) => item.table)),
    ).filter(Boolean);
    await this.ensureTables(tableNames);

    await this.withDatabase(async (database) => {
      const tx = database.transaction([...tableNames, META_STORE], 'readwrite');
      const tableStores = new Map<string, IDBObjectStore>();
      for (const name of tableNames) {
        tableStores.set(name, tx.objectStore(name));
      }
      for (const item of records) {
        const store = tableStores.get(item.table);
        if (!store) continue;

        const getReq = store.get(item.id);
        getReq.onsuccess = () => {
          const existing = getReq.result as StoredRecord | undefined;
          if (!existing || shouldOverwrite(item, existing)) {
            if (item.deleted) {
              store.delete(item.id);
            } else {
              const record: StoredRecord = {
                id: item.id,
                data: item.data,
                timestamp: item.timestamp,
                version: item.version ?? 1,
                clientId: item.clientId,
              };
              store.put(record);
            }
          }
        };
      }
      const metaStore = tx.objectStore(META_STORE);
      metaStore.put({ key: 'lastSyncSeq', value: seq });
      metaStore.put({ key: 'lastSyncTimestamp', value: Date.now() });
      await promisifyTransaction(tx);
    });
  }

  private async clearStores(
    database: IDBDatabase,
    storeNames: string[],
  ): Promise<void> {
    if (storeNames.length === 0) return;
    const tx = database.transaction(storeNames, 'readwrite');
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }
    await promisifyTransaction(tx);
  }

  private async openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name);
      request.onupgradeneeded = () => {
        this.createInternalStores(request.result);
      };
      request.onsuccess = () => {
        const database = request.result;
        if (
          !database.objectStoreNames.contains(OUTBOX_STORE) ||
          !database.objectStoreNames.contains(META_STORE)
        ) {
          const nextVersion = database.version + 1;
          this.databasePromise = this.upgradeDatabase(
            database,
            nextVersion,
            [],
          );
          this.databasePromise.then(resolve).catch(reject);
        } else {
          resolve(database);
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
        const database = request.result;
        this.createInternalStores(database);
        for (const tableName of newTables) {
          if (!database.objectStoreNames.contains(tableName)) {
            database.createObjectStore(tableName, { keyPath: 'id' });
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

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
