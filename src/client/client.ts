import { generateClientId } from '../shared/clock.js';
import { normalizeBasePath } from '../shared/path.js';
import {
  Auth,
  AuthStatus,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';

import { Database } from './database.js';
import {
  Sync,
  type SyncOptions,
  type SyncStatus,
  type WebSocketConstructor,
} from './sync.js';
import { type ITable, Table } from './table.js';

export {
  Auth,
  AuthStatus,
  DataMode,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';

/**
 * Options for configuring a TetherClient database instance.
 */
export interface TetherClientOptions {
  /** Name of the local IndexedDB database. */
  name: string;
  /** Application namespace identifier (defaults to `name`). */
  appId?: string;
  /** Schema version number (defaults to 1). */
  version?: number;
  /** Remote server host or hostname (e.g. 'localhost' or 'api.example.com'). Defaults to current browser hostname. */
  host?: string;
  /** Remote server port number (e.g. 8080). Defaults to current browser port. */
  port?: number;
  /** Whether to use secure HTTPS and WSS protocols (defaults to `true` in secure browser contexts, `false` otherwise). */
  isSecure?: boolean;
  /** Base path for HTTP REST endpoints (defaults to ''). */
  basePath?: string;
  /** Path for WebSocket upgrade requests (defaults to `${basePath}/sync`). */
  webSocketPath?: string;
  /** Custom WebSocket constructor for Node.js environments. */
  WebSocketClass?: WebSocketConstructor;
  /** Optional custom fetch implementation for authentication requests. */
  fetch?: typeof fetch;
  /** Optional real-time WebSocket sync configuration. */
  sync?: Partial<SyncOptions> & { token: string };
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables,
 * local-first storage, automatic auth lifecycle, and background synchronization.
 */
export class TetherClient {
  readonly name: string;
  readonly appId: string;
  readonly clientId: string;
  readonly host?: string;
  readonly port?: number;
  readonly isSecure: boolean;
  readonly basePath: string;
  readonly webSocketPath: string;
  readonly WebSocketClass?: WebSocketConstructor;
  readonly idb: Database;

  /** Internal authentication coordinator. */
  readonly auth: Auth;

  /** Readonly real-time WebSocket synchronization coordinator. */
  readonly sync: Sync;

  private tables: Map<string, ITable> = new Map();

  /**
   * Initializes a new TetherClient instance and wires reactive auth & sync coordination.
   *
   * @param options - Configuration options for the local database and server connection.
   */
  constructor(options: TetherClientOptions) {
    if (!options.name) {
      throw new Error('Missing required name in TetherClient options.');
    }
    const isBrowser = typeof window !== 'undefined' && Boolean(window.location);

    this.name = options.name;
    this.appId = options.appId ?? options.name;
    this.clientId = generateClientId();
    this.isSecure =
      options.isSecure ??
      (isBrowser ? window.location.protocol === 'https:' : false);
    this.host =
      options.host ??
      (isBrowser ? window.location.hostname || undefined : undefined);
    this.port =
      options.port ??
      (isBrowser && window.location.port
        ? Number.parseInt(window.location.port, 10)
        : undefined);
    this.basePath = normalizeBasePath(options.basePath ?? '');
    this.webSocketPath = options.webSocketPath ?? `${this.basePath}/sync`;
    this.WebSocketClass = options.WebSocketClass;

    this.idb = new Database(this.name, [], options.version ?? 1);

    this.auth = new Auth({
      baseUrl: this.httpOrigin
        ? `${this.httpOrigin}${this.basePath}`
        : this.basePath,
      db: this.idb,
      fetchFn: options.fetch,
    });

    this.sync = new Sync(this.idb, (tableName) => this.table(tableName), {
      url: this.webSocketUrl,
      appId: this.appId,
      clientId: this.clientId,
      WebSocketClass: this.WebSocketClass,
    });

    // Coordinate auth and sync lifecycle reactively
    this.auth.onStatusChange((status) => {
      if (status === AuthStatus.SignedIn && this.auth.token) {
        this.sync.connect(this.auth.token, this.webSocketUrl);
      } else {
        this.sync.disconnect();
      }
    });

    if (options.sync) {
      this.auth.setExplicitToken(options.sync.token);
      this.sync.connect(
        options.sync.token,
        options.sync.url ?? this.webSocketUrl,
      );
    }
  }

  /**
   * The resolved HTTP origin for remote server requests, or `undefined` if no host is known.
   */
  get httpOrigin(): string | undefined {
    if (!this.host) return undefined;
    const hostHeader =
      this.port !== undefined && !this.host.includes(':')
        ? `${this.host}:${this.port}`
        : this.host;
    const proto = this.isSecure ? 'https' : 'http';
    return `${proto}://${hostHeader}`;
  }

  /**
   * The resolved WebSocket URL for real-time synchronization, or `undefined` if no host is known.
   */
  get webSocketUrl(): string | undefined {
    if (!this.host) return undefined;
    const hostHeader =
      this.port !== undefined && !this.host.includes(':')
        ? `${this.host}:${this.port}`
        : this.host;
    const proto = this.isSecure ? 'wss' : 'ws';
    return `${proto}://${hostHeader}${this.webSocketPath}`;
  }

  // -- Database ------------------------------------------------------

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
      tbl = new Table<T>(name, this.idb, this.clientId, () => {
        this.sync.schedulePush();
      });
      this.tables.set(name, tbl);
    }
    return tbl as Table<T>;
  }

  /**
   * Clears all local application tables, outbox entries, and sync metadata.
   */
  async clear(): Promise<void> {
    await this.idb.clearAllData();
  }

  /**
   * Closes active synchronization connections and closes the IndexedDB database handle.
   */
  async close(): Promise<void> {
    this.sync.destroy();
    await this.idb.close();
  }

  // -- Authentication ------------------------------------------------------

  /**
   * Current authentication lifecycle status.
   */
  get authStatus(): AuthStatus {
    return this.auth.status;
  }

  /**
   * The authenticated user's username, or `undefined` if signed out.
   */
  get username(): string | undefined {
    return this.auth.username;
  }

  /**
   * Subscribes to authentication status changes.
   *
   * @param listener - Callback receiving the updated `AuthStatus`.
   * @returns An unsubscribe function.
   */
  onAuthStatusChange(listener: (status: AuthStatus) => void): () => void {
    return this.auth.onStatusChange(listener);
  }

  /**
   * Registers a new user account, applies local data mode, and connects synchronization.
   *
   * @param options - Registration credentials and data reconciliation settings.
   * @returns `true` if registration succeeded; `false` otherwise.
   */
  async register(options: RegisterOptions): Promise<boolean> {
    return this.auth.register(options);
  }

  /**
   * Logs into an account (or reconnects using remembered credentials), applies data mode, and connects synchronization.
   *
   * @param options - Optional login credentials and data reconciliation mode.
   * @returns `true` if authentication succeeded; `false` otherwise.
   */
  async login(options: LoginOptions = {}): Promise<boolean> {
    return this.auth.login(options);
  }

  /**
   * Logs out of the current session, disconnects sync, and optionally clears local tables.
   *
   * @param options - Options controlling whether local data should be wiped.
   * @returns `true` on successful logout.
   */
  async logout(options: LogoutOptions = {}): Promise<boolean> {
    return this.auth.logout(options);
  }

  // -- Synchronization ------------------------------------------------------

  /**
   * Retrieves the current synchronization status (e.g. Connected, Connecting, Disconnected, Error).
   */
  get syncStatus(): SyncStatus {
    return this.sync.status;
  }

  /**
   * Subscribes to synchronization status changes across the database lifecycle.
   *
   * @param listener - Callback receiving the updated `SyncStatus`.
   * @returns An unsubscribe function.
   */
  onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
    return this.sync.onStatusChange(listener);
  }

  /**
   * Dynamically enables and connects synchronization for this database.
   *
   * @param options - Configuration options for sync.
   */
  enableSync(options: Partial<SyncOptions> & { token: string }): void {
    this.auth.setExplicitToken(options.token);
    this.sync.connect(options.token, options.url ?? this.webSocketUrl);
  }

  /**
   * Disables synchronization and disconnects the WebSocket while keeping local IndexedDB operational.
   */
  disableSync(): void {
    this.sync.disconnect();
  }
}
