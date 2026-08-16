import { EventRegistry } from '../shared/event.js';
import { normalizeBasePath } from '../shared/path.js';
import {
  Auth,
  AuthStatus,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';
import { Storage } from './storage.js';
import { Sync, type SyncStatus, type WebSocketConstructor } from './sync.js';
import type { Table } from './table.js';

export {
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
  /** Application namespace identifier (defaults to database name). */
  appId?: string;
  /** Remote server host or hostname (e.g. 'localhost' or 'api.example.com'). Defaults to current browser hostname. */
  host?: string;
  /** Remote server port number (e.g. 8080). Defaults to current browser port. */
  port?: number;
  /** Whether to use secure HTTPS and WSS protocols (defaults to `true` in secure browser contexts, `false` otherwise). */
  secure?: boolean;
  /** Base path for HTTP REST endpoints (defaults to ''). */
  basePath?: string;
  /** Path for WebSocket upgrade requests (defaults to `${basePath}/sync`). */
  webSocketPath?: string;
  /** Optional custom fetch implementation for authentication requests. */
  fetch?: typeof fetch;
  /** Custom WebSocket constructor for streaming requests. */
  webSocketClass?: WebSocketConstructor;
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
  /** Reactive event registry triggered whenever the authentication status changes. */
  readonly onAuthStatusChange = new EventRegistry<AuthStatus>();
  /** Reactive event registry triggered whenever the synchronization status changes. */
  readonly onSyncStatusChange = new EventRegistry<SyncStatus>();
  private readonly storage: Storage;
  private readonly auth: Auth;
  private readonly sync: Sync;

  /**
   * Initializes a new TetherClient instance and wires reactive auth & sync coordination.
   *
   * @param name - Name of the local IndexedDB database.
   * @param options - Configuration options for the server connection and sync behavior.
   */
  constructor(name: string, options: TetherClientOptions = {}) {
    this.storage = this.createStorage(name);
    this.auth = this.createAuth(options, this.storage);
    this.sync = this.createSync(name, options, this.storage);

    // Push local changes reactively.
    this.storage.onLocalChange.register(() => {
      this.sync.schedulePush();
    });

    // Coordinate auth and sync lifecycle reactively.
    this.auth.onStatusChange.register((status) => {
      this.onAuthStatusChange.publish(status);
      if (status === AuthStatus.SignedIn && this.auth.token) {
        this.sync.connect(this.auth.token);
      } else {
        this.sync.disconnect();
      }
    });

    this.sync.onStatusChange.register((status) => {
      this.onSyncStatusChange.publish(status);
    });
  }

  // -- Database / Storage ------------------------------------------------------

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
   *
   * @typeParam T - Data payload model type for records in this table.
   * @param name - The table name.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(name: string): Table<T> {
    return this.storage.table<T>(name);
  }

  /**
   * Clears all local application tables, outbox entries, and sync metadata.
   */
  async clear(): Promise<void> {
    await this.storage.clearAllData();
  }

  /**
   * Closes active synchronization connections and closes the IndexedDB database handle.
   */
  async close(): Promise<void> {
    this.sync.destroy();
    await this.storage.close();
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

  // -- Private Helpers ------------------------------------------------------

  private createStorage(name: string): Storage {
    return new Storage(name);
  }

  private createAuth(options: TetherClientOptions, storage: Storage): Auth {
    return new Auth({
      baseUrl: this.resolveBaseUrl(options),
      storage,
      fetchFn: options.fetch,
    });
  }

  private createSync(
    name: string,
    options: TetherClientOptions,
    storage: Storage,
  ): Sync {
    return new Sync(storage, {
      url: this.resolveWebSocketUrl(options),
      appId: options.appId ?? name,
      clientId: storage.clientId,
      webSocketClass: options.webSocketClass,
      reconnectIntervalMs: options.reconnectIntervalMs,
      maxReconnectIntervalMs: options.maxReconnectIntervalMs,
      pingIntervalMs: options.pingIntervalMs,
      onTokenRefresh: (token) => {
        this.auth.handleTokenRefresh(token);
      },
      onAuthError: (message) => {
        this.auth.handleAuthError(message);
      },
    });
  }

  private resolveHostHeader(options: TetherClientOptions): {
    host?: string;
    secure: boolean;
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
    const secure =
      options.secure ??
      (isBrowser ? window.location.protocol === 'https:' : false);

    if (!host) {
      return { host: undefined, secure };
    }

    const hostHeader =
      port !== undefined && !host.includes(':') ? `${host}:${port}` : host;
    return { host: hostHeader, secure };
  }

  private resolveBaseUrl(options: TetherClientOptions): string {
    const basePath = normalizeBasePath(options.basePath ?? '');
    const { host, secure } = this.resolveHostHeader(options);
    if (!host) return basePath;
    const proto = secure ? 'https' : 'http';
    return `${proto}://${host}${basePath}`;
  }

  private resolveWebSocketUrl(
    options: TetherClientOptions,
  ): string | undefined {
    const { host, secure } = this.resolveHostHeader(options);
    if (!host) return undefined;
    const basePath = normalizeBasePath(options.basePath ?? '');
    const webSocketPath = options.webSocketPath ?? `${basePath}/sync`;
    const proto = secure ? 'wss' : 'ws';
    return `${proto}://${host}${webSocketPath}`;
  }
}
