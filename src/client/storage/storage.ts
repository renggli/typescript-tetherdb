import { shouldOverwrite } from '../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type SnapshotRecord,
  type StoredRecord,
} from '../../shared/types.js';
import type { Index, IndexQueryOptions } from '../indexed.js';
import { EventRegistry } from '../shared/event.js';
import { randomUUID } from '../shared/id.js';
import { Table } from '../table.js';
import { openIndexedDatabase, upgradeIndexedDatabase } from './database.js';
import {
  collectFromCursor,
  META_STORE,
  OUTBOX_STORE,
  promisifyRequest,
  promisifyTransaction,
  storeNeedsIndexMigration,
} from './utils.js';

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

  private activeUserName?: string;
  private databasePromise: Promise<IDBDatabase> | null = null;
  private schemaMutex: Promise<void> = Promise.resolve();
  private registeredTables: Map<string, Table<unknown>> = new Map();
  private registeredIndexes: Map<string, Index[]> = new Map();

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
   * Current active authenticated user name.
   */
  get currentUserName(): string | undefined {
    return this.activeUserName;
  }

  /**
   * Updates the current active authenticated user credentials for metadata attribution.
   *
   * @param userName - Current authenticated username or `undefined` if signed out.
   */
  setCurrentUser(userName?: string): void {
    this.activeUserName = userName;
  }

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
   *
   * @typeParam T - Data payload model type for records in this table.
   * @param tableName - The table name.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(tableName: string): Table<T> {
    let table = this.registeredTables.get(tableName);
    if (!table) {
      table = new Table(tableName, this) as Table<unknown>;
      this.registeredTables.set(tableName, table);
    }
    return table as unknown as Table<T>;
  }

  /**
   * Returns registered index definitions for the given table.
   *
   * @param tableName - Table name.
   */
  tableIndexes(tableName: string): ReadonlyArray<Index> {
    return this.registeredIndexes.get(tableName) ?? [];
  }

  /**
   * Returns a specific registered index definition by name.
   *
   * @param tableName - Table name.
   * @param indexName - Index name.
   */
  tableIndex(tableName: string, indexName: string): Index | undefined {
    return this.registeredIndexes
      .get(tableName)
      ?.find((i) => i.name === indexName);
  }

  /**
   * Registers an index definition on a table.
   *
   * @param tableName - Table name.
   * @param index - Index definition.
   */
  registerIndex(tableName: string, index: Index): void {
    const list = this.registeredIndexes.get(tableName) ?? [];
    const indexIdx = list.findIndex((i) => i.name === index.name);
    if (indexIdx >= 0) {
      const updated = [...list];
      updated[indexIdx] = index;
      this.registeredIndexes.set(tableName, updated);
    } else {
      this.registeredIndexes.set(tableName, [...list, index]);
    }
  }

  /**
   * Opens or returns the active IndexedDB connection, executing schema upgrades when needed.
   *
   * @returns A promise resolving to the open IDBDatabase instance.
   */
  async getDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = openIndexedDatabase(this.name).catch((err) => {
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
          new Set([...tableNames, ...this.registeredIndexes.keys()]),
        ).filter((name) => database.objectStoreNames.contains(name));

        if (checkTables.length > 0) {
          const tx = database.transaction(checkTables, 'readonly');
          for (const name of checkTables) {
            const desired = this.registeredIndexes.get(name) ?? [];
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
      this.databasePromise = upgradeIndexedDatabase(
        this.name,
        database,
        nextVersion,
        tableNames,
        this.registeredIndexes,
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
      this.registeredIndexes.set(tableName, indexes);
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
          userName: item.change.userName ?? this.activeUserName,
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
    return this.withIndex(tableName, indexName, (index) =>
      promisifyRequest<StoredRecord<T> | undefined>(index.get(query)),
    );
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
    return this.withIndex(tableName, indexName, async (index) => {
      if (!options?.direction && !options?.offset) {
        const req =
          query !== undefined
            ? index.getAll(query, options?.limit)
            : index.getAll(null, options?.limit);
        const records = await promisifyRequest<StoredRecord<T>[]>(req);
        return records ?? [];
      }
      return collectFromCursor(
        index.openCursor(query, options.direction),
        (c) => c.value as StoredRecord<T>,
        options,
      );
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
    return this.withIndex(tableName, indexName, (index) =>
      promisifyRequest<number>(
        query !== undefined ? index.count(query) : index.count(),
      ),
    );
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
    return this.withIndex(tableName, indexName, (index) =>
      collectFromCursor(
        index.openKeyCursor(query, options?.direction),
        (c) => c.key,
        options,
      ),
    );
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
    return this.withIndex(tableName, indexName, async (index) => {
      if (!options?.direction && !options?.offset) {
        const req =
          query !== undefined
            ? index.getAllKeys(query, options?.limit)
            : index.getAllKeys(null, options?.limit);
        const keys = await promisifyRequest<IDBValidKey[]>(req);
        return (keys as string[]) ?? [];
      }
      return collectFromCursor(
        index.openKeyCursor(query, options.direction),
        (c) => String(c.primaryKey),
        options,
      );
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
      userName: change.userName,
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

  private async withIndex<R>(
    tableName: string,
    indexName: string,
    fn: (index: IDBIndex) => Promise<R>,
  ): Promise<R> {
    await this.ensureTable(tableName);
    return this.withDatabase(async (database) => {
      const tx = database.transaction(tableName, 'readonly');
      return fn(tx.objectStore(tableName).index(indexName));
    });
  }

  private async applyBatchRecords(
    records: SnapshotRecord[],
    seq?: number,
  ): Promise<void> {
    if (records.length === 0) {
      if (seq !== undefined) {
        await this.setMeta('lastSyncSeq', seq);
        await this.setMeta('lastSyncTimestamp', Date.now());
      }
      return;
    }

    const tables = Array.from(new Set(records.map((r) => r.table)));
    for (const table of tables) {
      await this.ensureTable(table);
    }

    return this.withDatabase(async (db) => {
      const txRead = db.transaction(tables, 'readonly');
      const existingMap = new Map<string, StoredRecord>();

      for (const item of records) {
        const key = `${item.table}:${item.id}`;
        const store = txRead.objectStore(item.table);
        const req = store.get(item.id);
        const existing = (await promisifyRequest(req)) as
          | StoredRecord
          | undefined;
        if (existing) {
          existingMap.set(key, existing);
        }
      }
      await promisifyTransaction(txRead);

      const txWrite = db.transaction([...tables, META_STORE], 'readwrite');
      for (const item of records) {
        const key = `${item.table}:${item.id}`;
        const existing = existingMap.get(key);
        const store = txWrite.objectStore(item.table);

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
              userName: item.userName,
            };
            store.put(record);
          }
        }
      }
      const metaStore = txWrite.objectStore(META_STORE);
      metaStore.put({ key: 'lastSyncSeq', value: seq });
      metaStore.put({ key: 'lastSyncTimestamp', value: Date.now() });
      await promisifyTransaction(txWrite);
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
}
