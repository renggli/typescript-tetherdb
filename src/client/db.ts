import { generateClientId } from '../shared/clock.js';
import { type AuthResult, TetherAuthClient } from './auth-client.js';
import { IDBManager } from './idb.js';
import {
  type SyncOptions,
  SyncStatus,
  TetherSyncClient,
  type WebSocketConstructor,
} from './sync.js';
import { type ITable, Table } from './table.js';

/**
 * Options for configuring a TetherDB database instance.
 */
export interface TetherClientOptions {
  /** Name of the local IndexedDB database. */
  name: string;
  /** Optional application namespace identifier (defaults to 'default'). */
  appId?: string;
  /** Schema version number (defaults to 1). */
  version?: number;
  /** Pre-declared array of table/store names to create upon database opening. */
  stores?: string[];
  /** Optional real-time WebSocket sync configuration. */
  sync?: SyncOptions;
}

/** Alias for TetherClientOptions. */
export type TetherDBOptions = TetherClientOptions;

/**
 * Options for registering or logging into a remote server from TetherDB.
 */
export interface AuthOptions {
  /** Base HTTP URL of the server (e.g. 'http://localhost:8080'). */
  serverUrl: string;
  /** Username for authentication. */
  username: string;
  /** Account password. */
  password: string;
  /** Optional application namespace identifier (defaults to 'default' or database appId). */
  appId?: string;
  /** Optional custom WebSocket URL override. */
  wsUrl?: string;
  /** Custom WebSocket constructor for Node.js environments. */
  WebSocketClass?: WebSocketConstructor;
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables,
 * local-first storage, and dynamic background synchronization.
 */
export class TetherDB {
  private idb: IDBManager;
  private tables: Map<string, ITable> = new Map();
  private clientId: string;
  private syncClient: TetherSyncClient | null = null;
  private name: string;
  private appId?: string;
  private syncStatusListeners: Set<(status: SyncStatus) => void> = new Set();
  private syncStatusUnsubscribe: (() => void) | null = null;

  /**
   * Initializes a new TetherDB database instance.
   *
   * @param options - Configuration options for the local database and optional sync connection.
   */
  constructor(options: TetherClientOptions) {
    this.name = options.name;
    this.appId = options.appId;
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
   * The application namespace identifier, if specified.
   */
  get applicationIdentifier(): string | undefined {
    return this.appId;
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
  get sync(): TetherSyncClient | null {
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

    const syncOptions: SyncOptions = {
      appId: this.appId,
      ...options,
    };

    this.syncClient = new TetherSyncClient(
      this.idb,
      (storeName) => this.table(storeName),
      () => this.clientId,
      syncOptions,
    );

    this.syncStatusUnsubscribe = this.syncClient.onStatusChange((status) => {
      for (const listener of this.syncStatusListeners) {
        try {
          listener(status);
        } catch (err) {
          console.error('[TetherDB] Sync status listener error:', err);
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
        console.error('[TetherDB] Sync status listener error:', err);
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
    const authClient = new TetherAuthClient({ serverUrl: options.serverUrl });
    const result = await authClient.register({
      username: options.username,
      password: options.password,
    });

    const wsUrl = options.wsUrl ?? toWebSocketUrl(options.serverUrl, '/sync');
    this.enableSync({
      url: wsUrl,
      token: result.token,
      appId: options.appId ?? this.appId,
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
    const authClient = new TetherAuthClient({ serverUrl: options.serverUrl });
    const result = await authClient.login({
      username: options.username,
      password: options.password,
    });

    const wsUrl = options.wsUrl ?? toWebSocketUrl(options.serverUrl, '/sync');
    this.enableSync({
      url: wsUrl,
      token: result.token,
      appId: options.appId ?? this.appId,
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

/** Alias for TetherDB. */
export const TetherClientDB = TetherDB;

/**
 * Converts an HTTP(S) URL to a WS(S) URL.
 */
function toWebSocketUrl(httpUrl: string, path = '/sync'): string {
  const url = new URL(httpUrl);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}${path}`;
}
