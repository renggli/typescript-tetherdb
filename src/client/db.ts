import { generateClientId } from '../shared/clock.js';
import { type AuthResult, BeamedAuthClient } from './auth-client.js';
import { IDBManager } from './idb.js';
import {
  BeamedSyncClient,
  type SyncOptions,
  SyncStatus,
  type WebSocketConstructor,
} from './sync.js';
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
 * Options for registering or logging into a remote server from BeamedClientDB.
 */
export interface AuthOptions {
  /** Base HTTP URL of the server (e.g. 'http://localhost:8080'). */
  serverUrl: string;
  /** Username for authentication. */
  username: string;
  /** Account password. */
  password: string;
  /** Optional custom WebSocket URL override. */
  wsUrl?: string;
  /** Custom WebSocket constructor for Node.js environments. */
  WebSocketClass?: WebSocketConstructor;
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables,
 * local-first storage, and dynamic background synchronization.
 */
export class BeamedClientDB {
  private idb: IDBManager;
  private tables: Map<string, ITable> = new Map();
  private clientId: string;
  private syncClient: BeamedSyncClient | null = null;
  private name: string;
  private syncStatusListeners: Set<(status: SyncStatus) => void> = new Set();
  private syncStatusUnsubscribe: (() => void) | null = null;

  /**
   * Initializes a new BeamedClientDB database instance.
   *
   * @param options - Configuration options for the local database and optional sync connection.
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
      this.enableSync(options.sync);
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
   * The real-time synchronization client instance, or `null` if sync is not enabled.
   */
  get sync(): BeamedSyncClient | null {
    return this.syncClient;
  }

  /**
   * Retrieves the current synchronization status (e.g. 'connected', 'connecting', 'disconnected').
   */
  get syncStatus(): SyncStatus {
    return this.syncClient?.getStatus() ?? SyncStatus.Disconnected;
  }

  /**
   * Subscribes to synchronization status changes across the database lifecycle.
   *
   * @param listener - Callback receiving the updated `SyncStatus`.
   * @returns An unsubscribe function.
   */
  onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.syncStatusListeners.add(listener);
    listener(this.syncStatus);
    return () => {
      this.syncStatusListeners.delete(listener);
    };
  }

  /**
   * Dynamically enables and connects synchronization for this database.
   * Seamlessly flushes any pending local mutations created offline.
   *
   * @param options - Configuration options for sync.
   */
  enableSync(options: SyncOptions): void {
    if (this.syncClient) {
      this.disableSync();
    }

    this.syncClient = new BeamedSyncClient(
      this.idb,
      (storeName) => this.table(storeName),
      () => this.clientId,
      options,
    );

    this.syncStatusUnsubscribe = this.syncClient.onStatusChange((status) => {
      for (const listener of this.syncStatusListeners) {
        try {
          listener(status);
        } catch (err) {
          console.error('[BeamedDB] Sync status listener error:', err);
        }
      }
    });
  }

  /**
   * Disables synchronization and disconnects the WebSocket while keeping local IndexedDB operational.
   */
  disableSync(): void {
    if (this.syncStatusUnsubscribe) {
      this.syncStatusUnsubscribe();
      this.syncStatusUnsubscribe = null;
    }
    if (this.syncClient) {
      this.syncClient.destroy();
      this.syncClient = null;
    }
    for (const listener of this.syncStatusListeners) {
      try {
        listener(SyncStatus.Disconnected);
      } catch (err) {
        console.error('[BeamedDB] Sync status listener error:', err);
      }
    }
  }

  /**
   * Registers a new account on the remote server and automatically enables real-time synchronization.
   *
   * @param options - Authentication credentials and server endpoint configuration.
   * @returns A promise resolving to the authentication result.
   */
  async register(options: AuthOptions): Promise<AuthResult> {
    const authClient = new BeamedAuthClient({ serverUrl: options.serverUrl });
    const result = await authClient.register({
      username: options.username,
      password: options.password,
    });

    const wsUrl = options.wsUrl ?? toWebSocketUrl(options.serverUrl, '/sync');
    this.enableSync({
      url: wsUrl,
      token: result.token,
      WebSocketClass: options.WebSocketClass,
    });

    return result;
  }

  /**
   * Logs into an existing account on the remote server and automatically enables real-time synchronization.
   * Local offline records will be merged with the cloud account.
   *
   * @param options - Authentication credentials and server endpoint configuration.
   * @returns A promise resolving to the authentication result.
   */
  async login(options: AuthOptions): Promise<AuthResult> {
    const authClient = new BeamedAuthClient({ serverUrl: options.serverUrl });
    const result = await authClient.login({
      username: options.username,
      password: options.password,
    });

    const wsUrl = options.wsUrl ?? toWebSocketUrl(options.serverUrl, '/sync');
    this.enableSync({
      url: wsUrl,
      token: result.token,
      WebSocketClass: options.WebSocketClass,
    });

    return result;
  }

  /**
   * Logs out by disconnecting synchronization.
   */
  logout(): void {
    this.disableSync();
  }

  /**
   * Clears all local application tables, outbox entries, and sync metadata.
   */
  async clear(): Promise<void> {
    await this.idb.clearAllData();
  }

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
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
    this.disableSync();
    this.syncStatusListeners.clear();
    await this.idb.close();
  }
}

/**
 * Converts an HTTP(S) URL to a WS(S) URL.
 */
function toWebSocketUrl(httpUrl: string, path = '/sync'): string {
  const url = new URL(httpUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}${path}`;
}
