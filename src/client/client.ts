import { normalizeBasePath } from '../shared/path.js';
import {
  Auth,
  AuthStatus,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';

import { Database } from './database.js';
import { Sync, type SyncStatus, type WebSocketConstructor } from './sync.js';
import type { Table } from './table.js';

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
  /** Optional custom fetch implementation for authentication requests. */
  fetch?: typeof fetch;
  /** Custom WebSocket constructor for streaming requests. */
  WebSocketClass?: WebSocketConstructor;
  /** Initial reconnection backoff delay in milliseconds (defaults to 1000). */
  reconnectIntervalMs?: number;
  /** Maximum reconnection backoff delay in milliseconds (defaults to 30000). */
  maxReconnectIntervalMs?: number;
  /** Periodic keepalive ping interval in milliseconds (defaults to 30000). Set to 0 to disable. */
  pingIntervalMs?: number;
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables,
 * local-first storage, automatic auth lifecycle, and background synchronization.
 */
export class TetherClient {
  /** Internal IndexedDB database coordinator. */
  readonly database: Database;

  /** Internal authentication coordinator. */
  readonly auth: Auth;

  /** Real-time WebSocket synchronization coordinator. */
  readonly sync: Sync;

  /**
   * Initializes a new TetherClient instance and wires reactive auth & sync coordination.
   *
   * @param options - Configuration options for the local database and server connection.
   */
  constructor(options: TetherClientOptions) {
    if (!options.name) {
      throw new Error('Missing required name in TetherClient options.');
    }

    this.database = this.createDatabase(options);
    this.auth = this.createAuth(options, this.database);
    this.sync = this.createSync(options, this.database);

    this.database.setOnLocalChange(() => {
      this.sync.schedulePush();
    });

    // Coordinate auth and sync lifecycle reactively
    this.auth.onStatusChange((status) => {
      if (status === AuthStatus.SignedIn && this.auth.token) {
        this.sync.connect(this.auth.token);
      } else {
        this.sync.disconnect();
      }
    });
  }

  /**
   * Name of the local IndexedDB database.
   */
  get name(): string {
    return this.database.name;
  }

  /**
   * Application namespace identifier.
   */
  get appId(): string {
    return this.sync.appId;
  }

  /**
   * Unique client instance identifier.
   */
  get clientId(): string {
    return this.database.clientId;
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
    return this.database.table<T>(name);
  }

  /**
   * Clears all local application tables, outbox entries, and sync metadata.
   */
  async clear(): Promise<void> {
    await this.database.clearAllData();
  }

  /**
   * Closes active synchronization connections and closes the IndexedDB database handle.
   */
  async close(): Promise<void> {
    this.sync.destroy();
    await this.database.close();
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

  // -- Private Helpers ------------------------------------------------------

  private createDatabase(options: TetherClientOptions): Database {
    return new Database(options.name, {
      version: options.version,
    });
  }

  private createAuth(options: TetherClientOptions, database: Database): Auth {
    return new Auth({
      baseUrl: this.resolveBaseUrl(options),
      database,
      fetchFn: options.fetch,
    });
  }

  private createSync(options: TetherClientOptions, database: Database): Sync {
    return new Sync(database, {
      url: this.resolveWebSocketUrl(options),
      appId: options.appId ?? options.name,
      clientId: database.clientId,
      WebSocketClass: options.WebSocketClass,
      reconnectIntervalMs: options.reconnectIntervalMs,
      maxReconnectIntervalMs: options.maxReconnectIntervalMs,
      pingIntervalMs: options.pingIntervalMs,
    });
  }

  private resolveHostHeader(options: TetherClientOptions): {
    host?: string;
    isSecure: boolean;
  } {
    const isBrowser = typeof window !== 'undefined' && Boolean(window.location);
    const host =
      options.host ??
      (isBrowser ? window.location.hostname || undefined : undefined);
    const port =
      options.port ??
      (isBrowser && window.location.port
        ? Number.parseInt(window.location.port, 10)
        : undefined);
    const isSecure =
      options.isSecure ??
      (isBrowser ? window.location.protocol === 'https:' : false);

    if (!host) {
      return { host: undefined, isSecure };
    }

    const hostHeader =
      port !== undefined && !host.includes(':') ? `${host}:${port}` : host;
    return { host: hostHeader, isSecure };
  }

  private resolveBaseUrl(options: TetherClientOptions): string {
    const basePath = normalizeBasePath(options.basePath ?? '');
    const { host, isSecure } = this.resolveHostHeader(options);
    if (!host) return basePath;
    const proto = isSecure ? 'https' : 'http';
    return `${proto}://${host}${basePath}`;
  }

  private resolveWebSocketUrl(
    options: TetherClientOptions,
  ): string | undefined {
    const { host, isSecure } = this.resolveHostHeader(options);
    if (!host) return undefined;
    const basePath = normalizeBasePath(options.basePath ?? '');
    const webSocketPath = options.webSocketPath ?? `${basePath}/sync`;
    const proto = isSecure ? 'wss' : 'ws';
    return `${proto}://${host}${webSocketPath}`;
  }
}
