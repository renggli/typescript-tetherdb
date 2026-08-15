import { generateClientId } from '../shared/clock.js';
import { IDBManager } from './idb.js';
import { BeamedSyncClient, type SyncOptions } from './sync.js';
import { type ITable, Table } from './table.js';

/**
 * Options for configuring a BeamedClientDB instance.
 */
export interface BeamedClientOptions {
  /** Name of the local IndexedDB database. */
  name: string;
  /** Schema version number (defaults to 1). */
  version?: number;
  /** Pre-declared array of table/store names to create upon database opening. */
  stores?: string[];
  /** Optional real-time WebSocket sync configuration. */
  sync?: SyncOptions;
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables
 * and transparent background synchronization.
 */
export class BeamedClientDB {
  private idb: IDBManager;
  private tables: Map<string, ITable> = new Map();
  private clientId: string;
  private syncClient: BeamedSyncClient | null = null;
  private name: string;

  /**
   * Initializes a new BeamedClientDB database instance.
   *
   * @param options - Configuration options for the local database and sync connection.
   */
  constructor(options: BeamedClientOptions) {
    this.name = options.name;
    this.clientId = generateClientId();
    this.idb = new IDBManager(
      options.name,
      options.stores,
      options.version ?? 1,
    );

    if (options.sync) {
      this.syncClient = new BeamedSyncClient(
        this.idb,
        (storeName) => this.table(storeName),
        () => this.clientId,
        options.sync,
      );
    }
  }

  /**
   * The name of the underlying IndexedDB database.
   */
  get dbName(): string {
    return this.name;
  }

  /**
   * The internal IndexedDB transaction coordinator.
   */
  get idbManager(): IDBManager {
    return this.idb;
  }

  /**
   * The unique client instance identifier used for conflict resolution tie-breaking.
   */
  get clientIdentifier(): string {
    return this.clientId;
  }

  /**
   * The real-time synchronization client instance, or `null` if sync options were not provided.
   */
  get sync(): BeamedSyncClient | null {
    return this.syncClient;
  }

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   *
   * @typeParam T - Data payload model type for records in this table.
   * @param name - The table/store name.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(name: string): Table<T> {
    let tbl = this.tables.get(name);
    if (!tbl) {
      tbl = new Table<T>(
        name,
        this.idb,
        () => this.clientId,
        () => {
          this.syncClient?.schedulePush();
        },
      );
      this.tables.set(name, tbl);
    }
    return tbl as Table<T>;
  }

  /**
   * Closes the active synchronization connection and closes the IndexedDB database handle.
   */
  async close(): Promise<void> {
    this.syncClient?.destroy();
    await this.idb.close();
  }
}
