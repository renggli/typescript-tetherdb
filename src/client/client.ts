import { normalizeBasePath } from '../shared/path.js';
import {
  Auth,
  AuthStatus,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';
import type { TetherClientError } from './errors.js';
import { EventRegistry } from './shared/event.js';
import { Storage } from './storage.js';
import { Sync, type SyncStatus, type WebSocketConstructor } from './sync.js';
import type { Table } from './table.js';

/**
 * Options for configuring a TetherClient database instance.
 */
export interface TetherClientOptions {
  /** Optional array of table names to sync. If omitted, synchronizes all accessible tables. */
  tables?: string[];
  /**
   * Unified connection URL for the remote server (e.g. `'http://localhost:8080'`, `'https://api.example.com/db'`,
   * `'ws://localhost:8080/sync'`, or `'wss://api.example.com/db/sync'`). When provided, host, port, secure protocol,
   * and base path are extracted automatically and can be overridden by explicit options below.
   */
  url?: string;
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
  /** Debounce delay in milliseconds before pushing queued local outbox changes (defaults to 10). */
  pushDebounceMs?: number;
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
  /** Reactive event registry triggered whenever background sync or network errors occur. */
  readonly onError = new EventRegistry<TetherClientError>();
  private readonly storage: Storage;
  private readonly auth: Auth;
  private readonly sync: Sync;

  /**
   * Initializes a new TetherClient instance and wires reactive auth & sync coordination.
   *
   * @param name - Name of the local database.
   * @param options - Optional configuration options for remote sync, endpoints, and networking.
   */
  constructor(name: string, options: TetherClientOptions = {}) {
    this.storage = this.createStorage(name);
    this.auth = this.createAuth(this.storage, options);
    this.sync = this.createSync(this.storage, options);

    // Push local changes reactively.
    this.storage.onLocalChange.register(() => {
      this.sync.schedulePush();
    });

    // Coordinate auth and sync lifecycle reactively.
    this.auth.onStatusChange.register((status) => {
      this.onAuthStatusChange.publish(status);
      if (status === AuthStatus.SignedIn && this.auth.token) {
        this.storage.setCurrentUser(this.auth.userName);
        this.sync.connect(this.auth.token);
      } else if (status === AuthStatus.SignedOut) {
        this.storage.setCurrentUser(undefined);
        this.sync.connect(undefined);
      }
    });
    this.sync.onStatusChange.register((status) => {
      this.onSyncStatusChange.publish(status);
    });
    this.sync.onError.register((err) => {
      this.onError.publish(err);
    });
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Restores any active authenticated session and initiates sync connection.
   */
  async init(): Promise<void> {
    await this.auth.restoreSession();
  }

  /**
   * Disconnects active WebSocket connections, cancels retry timers, and closes IndexedDB handles.
   */
  async close(): Promise<void> {
    this.sync.destroy();
    await this.storage.close();
  }

  // -- Database / Storage ------------------------------------------------------

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
   *
   * @typeParam T - Data payload model type for records in this table.
   * @param tableName - The table name.
   * @returns A typed `Table<T>` instance.
   */
  table<T = unknown>(tableName: string): Table<T> {
    return this.storage.table<T>(tableName);
  }

  /**
   * Clears all local application tables, outbox entries, and sync metadata.
   */
  async clear(): Promise<void> {
    await this.storage.clearAllData();
  }

  // -- Authentication ------------------------------------------------------

  /**
   * Current authentication lifecycle status.
   */
  get authStatus(): AuthStatus {
    return this.auth.status;
  }

  /**
   * The authenticated user's name, or `undefined` if signed out.
   */
  get userName(): string | undefined {
    return this.auth.userName;
  }

  /**
   * Registers a new user account, applies local data mode, and connects synchronization.
   *
   * @param options - Registration credentials and data reconciliation settings.
   * @returns `true` if registration succeeded; `false` otherwise.
   */
  async register(options: RegisterOptions): Promise<boolean> {
    this.sync.disconnect();
    return this.auth.register(options);
  }

  /**
   * Logs into an account (or reconnects using remembered credentials), applies data mode, and connects synchronization.
   *
   * @param options - Optional login credentials and data reconciliation mode.
   * @returns `true` if authentication succeeded; `false` otherwise.
   */
  async login(options: LoginOptions = {}): Promise<boolean> {
    this.sync.disconnect();
    return this.auth.login(options);
  }

  /**
   * Logs out of the current session, disconnects sync, and optionally clears local tables.
   *
   * @param options - Options controlling whether local data should be wiped.
   * @returns `true` on successful logout.
   */
  async logout(options: LogoutOptions = {}): Promise<boolean> {
    this.sync.disconnect();
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

  private createAuth(storage: Storage, options: TetherClientOptions): Auth {
    return new Auth(storage, {
      baseUrl: this.resolveBaseUrl(options),
      fetch: options.fetch,
    });
  }

  private createSync(storage: Storage, options: TetherClientOptions): Sync {
    return new Sync(storage, {
      url: this.resolveWebSocketUrl(options),
      clientId: storage.clientId,
      tables: options.tables,
      webSocketClass: options.webSocketClass,
      pushDebounceMs: options.pushDebounceMs,
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

  private parseUrl(urlStr?: string): {
    host?: string;
    port?: number;
    secure?: boolean;
    basePath?: string;
    webSocketPath?: string;
  } {
    if (!urlStr) return {};
    try {
      const isWs = /^wss?:/i.test(urlStr);
      const isSecure = /^https:|^wss:/i.test(urlStr);
      const httpNormalized = urlStr.replace(/^ws(s)?:/i, 'http$1:');
      const parsed = new URL(httpNormalized);

      const host = parsed.hostname || undefined;
      const port = parsed.port ? Number.parseInt(parsed.port, 10) : undefined;
      const pathname = parsed.pathname;

      let basePath: string | undefined;
      let webSocketPath: string | undefined;

      if (isWs) {
        if (pathname === '/sync' || pathname === '/sync/') {
          basePath = '';
          webSocketPath = '/sync';
        } else if (pathname.endsWith('/sync') || pathname.endsWith('/sync/')) {
          basePath = pathname.replace(/\/sync\/?$/, '');
          webSocketPath = pathname.replace(/\/$/, '');
        } else if (pathname && pathname !== '/') {
          basePath = pathname.replace(/\/$/, '');
          webSocketPath = `${basePath}/sync`;
        }
      } else {
        if (pathname && pathname !== '/') {
          basePath = pathname.replace(/\/$/, '');
        } else {
          basePath = '';
        }
      }

      return {
        host,
        port,
        secure: isSecure,
        basePath,
        webSocketPath,
      };
    } catch {
      return {};
    }
  }

  private resolveHostHeader(options: TetherClientOptions): {
    host?: string;
    secure: boolean;
  } {
    const urlConfig = this.parseUrl(options.url);
    const isBrowser = typeof window !== 'undefined' && Boolean(window.location);
    const host =
      options.host ??
      urlConfig.host ??
      (isBrowser && window.location.hostname !== ''
        ? window.location.hostname
        : undefined);
    const port =
      options.port ??
      urlConfig.port ??
      (isBrowser && window.location.port
        ? Number.parseInt(window.location.port, 10)
        : undefined);
    const secure =
      options.secure ??
      urlConfig.secure ??
      (isBrowser ? window.location.protocol === 'https:' : false);

    if (!host) {
      return { host: undefined, secure };
    }

    const hostHeader =
      port !== undefined && !host.includes(':') ? `${host}:${port}` : host;
    return { host: hostHeader, secure };
  }

  private resolveBaseUrl(options: TetherClientOptions): string {
    const urlConfig = this.parseUrl(options.url);
    const basePath = normalizeBasePath(
      options.basePath ?? urlConfig.basePath ?? '',
    );
    const { host, secure } = this.resolveHostHeader(options);
    if (!host) return basePath;
    const proto = secure ? 'https' : 'http';
    return `${proto}://${host}${basePath}`;
  }

  private resolveWebSocketUrl(
    options: TetherClientOptions,
  ): string | undefined {
    const urlConfig = this.parseUrl(options.url);
    const { host, secure } = this.resolveHostHeader(options);
    if (!host) return undefined;
    const basePath = normalizeBasePath(
      options.basePath ?? urlConfig.basePath ?? '',
    );
    const webSocketPath =
      options.webSocketPath ?? urlConfig.webSocketPath ?? `${basePath}/sync`;
    const proto = secure ? 'wss' : 'ws';
    return `${proto}://${host}${webSocketPath}`;
  }
}
