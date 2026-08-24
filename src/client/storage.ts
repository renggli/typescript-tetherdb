import { shouldOverwrite } from '../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type SnapshotRecord,
  type StoredRecord,
} from '../shared/types.js';
import type { Index, IndexQueryOptions } from './indexed-table.js';
import { EventRegistry } from './shared/event.js';
import { randomUUID } from './shared/id.js';
import { Table } from './table.js';

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
  private tableIndexes: Map<string, Index[]> = new Map();

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
   * @param indexes - Optional array of Index definitions to register on this table.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(name: string, indexes?: Index[]): Table<T> {
    if (indexes !== undefined) {
      this.tableIndexes.set(name, indexes);
    }
    let table = this.tables.get(name);
    if (!table) {
      table = new Table(
        name,
        this,
        this.tableIndexes.get(name) ?? [],
      ) as Table<unknown>;
      this.tables.set(name, table);
    } else if (indexes !== undefined) {
      table.setIndexDefinitions(indexes);
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
   * Dynamically ensures that multiple application tables and their indexes exist in IndexedDB.
   *
   * @param tableNames - Array of table names to ensure.
   */
  async ensureTables(tableNames: string[]): Promise<void> {
    this.schemaMutex = this.schemaMutex.then(async () => {
      const database = await this.getDatabase();
      let needsUpgrade = false;

      for (const name of tableNames) {
        if (!database.objectStoreNames.contains(name)) {
          needsUpgrade = true;
          break;
        }
      }

      if (!needsUpgrade) {
        const checkTables = Array.from(
          new Set([...tableNames, ...this.tableIndexes.keys()]),
        ).filter((name) => database.objectStoreNames.contains(name));

        if (checkTables.length > 0) {
          const tx = database.transaction(checkTables, 'readonly');
          for (const name of checkTables) {
            const desired = this.tableIndexes.get(name) ?? [];
            const store = tx.objectStore(name);
            if (storeNeedsIndexMigration(store, desired)) {
              needsUpgrade = true;
              break;
            }
          }
        }
      }

      if (!needsUpgrade) return;

      const nextVersion = database.version + 1;
      this.databasePromise = this.upgradeDatabase(
        database,
        nextVersion,
        tableNames,
      ).catch((err) => {
        this.databasePromise = null;
        throw err;
      });
      await this.databasePromise;
    });
    return this.schemaMutex;
  }

  /**
   * Ensures a single application table and its indexes exist in IndexedDB.
   *
   * @param tableName - Name of the table to ensure.
   * @param indexes - Optional array of Index definitions.
   */
  async ensureTable(tableName: string, indexes?: Index[]): Promise<void> {
    if (indexes !== undefined) {
      this.tableIndexes.set(tableName, indexes);
      const table = this.tables.get(tableName);
      if (table) {
        table.setIndexDefinitions(indexes);
      }
    }
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
   * Retrieves a single stored record from a specified table index.
   *
   * @typeParam T - Expected payload type.
   * @param tableName - Table name.
   * @param indexName - Index name.
   * @param query - The key value or `IDBKeyRange` to search for.
   * @returns Stored record or `undefined` if not found.
   */
  async getFromIndex<T = unknown>(
    tableName: string,
    indexName: string,
    query: IDBValidKey | IDBKeyRange,
  ): Promise<StoredRecord<T> | undefined> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const index = store.index(indexName);
      return promisifyRequest<StoredRecord<T> | undefined>(index.get(query));
    });
  }

  /**
   * Retrieves all stored records matching a query from a specified table index.
   *
   * @typeParam T - Expected payload type.
   * @param tableName - Table name.
   * @param indexName - Index name.
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param options - Optional pagination and cursor direction options.
   * @returns Array of matching stored records with metadata.
   */
  async getAllFromIndex<T = unknown>(
    tableName: string,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<StoredRecord<T>[]> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const index = store.index(indexName);

      const limit = options?.limit;
      const offset = options?.offset ?? 0;
      const direction = options?.direction;

      if (!direction && !offset && limit === undefined) {
        const req = query !== undefined ? index.getAll(query) : index.getAll();
        const records = await promisifyRequest<StoredRecord<T>[]>(req);
        return records ?? [];
      }

      if (!direction && !offset && limit !== undefined) {
        const req =
          query !== undefined
            ? index.getAll(query, limit)
            : index.getAll(null, limit);
        const records = await promisifyRequest<StoredRecord<T>[]>(req);
        return records ?? [];
      }

      return new Promise<StoredRecord<T>[]>((resolve, reject) => {
        const results: StoredRecord<T>[] = [];
        let advanced = false;
        const req = direction
          ? index.openCursor(query, direction)
          : index.openCursor(query);

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          if (offset > 0 && !advanced) {
            advanced = true;
            cursor.advance(offset);
            return;
          }
          results.push(cursor.value as StoredRecord<T>);
          if (limit !== undefined && results.length >= limit) {
            resolve(results);
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Counts the number of records matching the specified key or key range on an index.
   *
   * @param tableName - Table name.
   * @param indexName - Index name.
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @returns A promise resolving to the matching count.
   */
  async countFromIndex(
    tableName: string,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
  ): Promise<number> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const index = store.index(indexName);
      const req = query !== undefined ? index.count(query) : index.count();
      return promisifyRequest<number>(req);
    });
  }

  /**
   * Retrieves index keys matching a query from a specified table index.
   *
   * @param tableName - Table name.
   * @param indexName - Index name.
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param options - Optional pagination and cursor direction options.
   * @returns Array of index keys.
   */
  async getKeysFromIndex(
    tableName: string,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<IDBValidKey[]> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const index = store.index(indexName);

      const limit = options?.limit;
      const offset = options?.offset ?? 0;
      const direction = options?.direction;

      return new Promise<IDBValidKey[]>((resolve, reject) => {
        const results: IDBValidKey[] = [];
        let advanced = false;
        const req = direction
          ? index.openKeyCursor(query, direction)
          : index.openKeyCursor(query);

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          if (offset > 0 && !advanced) {
            advanced = true;
            cursor.advance(offset);
            return;
          }
          results.push(cursor.key);
          if (limit !== undefined && results.length >= limit) {
            resolve(results);
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * Retrieves primary record identifiers (IDs) matching a query from a specified table index.
   *
   * @param tableName - Table name.
   * @param indexName - Index name.
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param options - Optional pagination and cursor direction options.
   * @returns Array of primary record IDs.
   */
  async getPrimaryKeysFromIndex(
    tableName: string,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<string[]> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      const store = tx.objectStore(tableName);
      const index = store.index(indexName);

      const limit = options?.limit;
      const offset = options?.offset ?? 0;
      const direction = options?.direction;

      if (!direction && !offset && limit === undefined) {
        const req =
          query !== undefined ? index.getAllKeys(query) : index.getAllKeys();
        const keys = await promisifyRequest<IDBValidKey[]>(req);
        return (keys as string[]) ?? [];
      }

      if (!direction && !offset && limit !== undefined) {
        const req =
          query !== undefined
            ? index.getAllKeys(query, limit)
            : index.getAllKeys(null, limit);
        const keys = await promisifyRequest<IDBValidKey[]>(req);
        return (keys as string[]) ?? [];
      }

      return new Promise<string[]>((resolve, reject) => {
        const results: string[] = [];
        let advanced = false;
        const req = direction
          ? index.openKeyCursor(query, direction)
          : index.openKeyCursor(query);

        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(results);
            return;
          }
          if (offset > 0 && !advanced) {
            advanced = true;
            cursor.advance(offset);
            return;
          }
          results.push(String(cursor.primaryKey));
          if (limit !== undefined && results.length >= limit) {
            resolve(results);
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
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
        const tx = request.transaction;
        this.createInternalStores(database);

        for (const tableName of newTables) {
          if (!database.objectStoreNames.contains(tableName)) {
            database.createObjectStore(tableName, { keyPath: 'id' });
          }
        }

        for (const [tableName, desiredIndexes] of this.tableIndexes) {
          if (!database.objectStoreNames.contains(tableName)) {
            database.createObjectStore(tableName, { keyPath: 'id' });
          }
          if (!tx) continue;
          const store = tx.objectStore(tableName);
          const desiredMap = new Map(
            desiredIndexes.map((idx) => [idx.name, idx]),
          );

          for (let i = store.indexNames.length - 1; i >= 0; i--) {
            const indexName = store.indexNames[i];
            const desired = desiredMap.get(indexName);
            if (!desired) {
              store.deleteIndex(indexName);
            } else {
              const existing = store.index(indexName);
              if (
                !isKeyPathEqual(
                  existing.keyPath,
                  normalizeKeyPath(desired.keyPath),
                ) ||
                existing.unique !== desired.unique ||
                existing.multiEntry !== desired.multiEntry
              ) {
                store.deleteIndex(indexName);
              }
            }
          }

          for (const desired of desiredIndexes) {
            if (!store.indexNames.contains(desired.name)) {
              store.createIndex(
                desired.name,
                normalizeKeyPath(desired.keyPath),
                {
                  unique: desired.unique,
                  multiEntry: desired.multiEntry,
                },
              );
            }
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

// -- Private Helpers --------------------------------------------------------

const OUTBOX_STORE = '__tether_outbox';
const META_STORE = '__tether_meta';

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

function storeNeedsIndexMigration(
  store: IDBObjectStore,
  desiredIndexes: Index[],
): boolean {
  const desiredMap = new Map(desiredIndexes.map((idx) => [idx.name, idx]));

  for (let i = 0; i < store.indexNames.length; i++) {
    const name = store.indexNames[i];
    const desired = desiredMap.get(name);
    if (!desired) {
      return true;
    }
    const existing = store.index(name);
    if (
      !isKeyPathEqual(existing.keyPath, normalizeKeyPath(desired.keyPath)) ||
      existing.unique !== desired.unique ||
      existing.multiEntry !== desired.multiEntry
    ) {
      return true;
    }
  }

  for (const desired of desiredIndexes) {
    if (!store.indexNames.contains(desired.name)) {
      return true;
    }
  }
  return false;
}

function isKeyPathEqual(a: string | string[], b: string | string[]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((val, idx) => val === b[idx]);
  }
  return a === b;
}

function normalizeKeyPath(path: string | string[]): string | string[] {
  if (Array.isArray(path)) {
    return path.map(normalizeSingleKeyPath);
  }
  return normalizeSingleKeyPath(path);
}

function normalizeSingleKeyPath(path: string): string {
  if (
    path === 'id' ||
    path === 'timestamp' ||
    path === 'version' ||
    path === 'clientId' ||
    path === 'deleted' ||
    path.startsWith('data.')
  ) {
    return path;
  }
  return `data.${path}`;
}
