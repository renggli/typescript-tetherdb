import {
  Auth,
  AuthStatus,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';
import { type TetherClientError, TetherClientErrorCode } from './errors.js';
import { EventRegistry } from './shared/event.js';
import { TabChannel } from './shared/tab-channel.js';
import { TETHER_PREFIX } from './storage/utils.js';
import { Storage } from './storage.js';
import { Sync, type SyncStatus, type WebSocketConstructor } from './sync.js';
import type { Table } from './table.js';

/**
 * Options for configuring a TetherClient database instance.
 */
export interface TetherClientOptions {
  /** Optional array of table names to sync. If omitted, synchronizes all accessible tables. */
  tables?: string[];
  /** Websocket URL of the remote server. If omitted, defaults to `${window.location.origin}/tether`. */
  url?: string;
  /** Debounce delay in milliseconds before pushing queued local outbox changes (defaults to 10). */
  pushDebounceMs?: number;
  /** Initial reconnection backoff delay in milliseconds (defaults to 1000). */
  reconnectIntervalMs?: number;
  /** Maximum reconnection backoff delay in milliseconds (defaults to 30000). */
  maxReconnectIntervalMs?: number;
  /** Periodic keepalive ping interval in milliseconds (defaults to 30000). Set to 0 to disable. */
  pingIntervalMs?: number;
  /** Custom WebSocket constructor for non-browser or test environments. */
  webSocketClass?: WebSocketConstructor;
}

/**
 * Main client-side database entry point providing reactive IndexedDB tables,
 * local-first storage, automatic auth lifecycle, and background synchronization.
 *
 * **Multi-tab coordination**: when the same application is open across multiple
 * browser tabs, TetherClient coordinates via the Web Locks API and BroadcastChannel:
 * 1. Web Locks elect an active leader tab to synchronize uncontested with the server.
 * 2. BroadcastChannel synchronizes authentication state and data mutations in real-time.
 * 3. `localStorage` persists sessions so new tabs immediately start in the authenticated state.
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
  private readonly tabChannel: TabChannel;
  private leaderLockAbortController: AbortController | null = null;
  private isProcessingRemoteAuth = false;

  /**
   * Initializes a new TetherClient instance and wires reactive auth & sync coordination.
   *
   * @param name - Name of the local database.
   * @param options - Optional configuration options for remote sync and networking.
   */
  constructor(name: string, options: TetherClientOptions = {}) {
    this.storage = createStorage(name);
    this.sync = createSync(this.storage, options);
    this.auth = createAuth(this.storage, this.sync);
    this.tabChannel = new TabChannel(name);

    // Broadcast local writes to sibling tabs.
    this.storage.onLocalChangeBatch.register(({ tableName, mutations }) => {
      this.tabChannel.broadcast({
        type: 'change',
        table: tableName,
        events: mutations.map((m) => ({
          id: m.id,
          op: m.op,
          data: m.data,
          isRemote: true,
        })),
      });
    });

    // Handle cross-tab messages from sibling tabs.
    this.tabChannel.onMessage.register((msg) => {
      if (msg.type === 'change') {
        this.storage.table(msg.table).notifyRemoteChanges(msg.events);
      } else if (msg.type === 'auth') {
        this.isProcessingRemoteAuth = true;
        try {
          if (msg.status === 'signedIn') {
            this.storage.setCurrentUser(msg.userName);
            this.auth.applyRemoteAuth(
              AuthStatus.SignedIn,
              msg.userName,
              msg.token,
            );
            this.sync.connect(msg.token);
            this.sync.schedulePush(0);
          } else if (msg.status === 'signedOut') {
            this.storage.setCurrentUser(undefined);
            this.auth.applyRemoteAuth(AuthStatus.SignedOut);
            this.sync.connect(undefined);
          }
        } finally {
          this.isProcessingRemoteAuth = false;
        }
      }
    });

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
        this.sync.schedulePush(0);
        if (!this.isProcessingRemoteAuth && this.auth.userName) {
          this.tabChannel.broadcast({
            type: 'auth',
            status: 'signedIn',
            userName: this.auth.userName,
            token: this.auth.token,
          });
        }
      } else if (status === AuthStatus.SignedOut) {
        this.storage.setCurrentUser(undefined);
        this.sync.connect(undefined);
        if (!this.isProcessingRemoteAuth) {
          this.tabChannel.broadcast({
            type: 'auth',
            status: 'signedOut',
          });
        }
      }
    });

    // Handle session token refreshes.
    this.sync.onTokenRefresh.register((token) => {
      this.auth.handleTokenRefresh(token);
    });

    // Propagate status changes.
    this.sync.onStatusChange.register((status) => {
      this.onSyncStatusChange.publish(status);
    });

    // Propagate errors and handle authentication failures.
    this.sync.onError.register((err) => {
      if (err.code === TetherClientErrorCode.AuthenticationFailed) {
        this.auth.handleAuthError(err.message);
      }
      this.onError.publish(err);
    });
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Restores any active authenticated session and begins leader election.
   */
  async init(): Promise<void> {
    await this.auth.restoreSession();
    this.startLeaderElection();
  }

  /**
   * Disconnects active connections, cancels retry timers, and closes IndexedDB handles.
   */
  async close(): Promise<void> {
    this.leaderLockAbortController?.abort();
    this.leaderLockAbortController = null;
    this.tabChannel.destroy();
    this.sync.destroy();
    await this.storage.close();
  }

  // -- Database / Storage ------------------------------------------------------

  /**
   * Obtains a typed table reference for reading, mutating, and subscribing to records.
   * Tables are created dynamically on-demand if not already declared.
   *
   * @template T - Type of the stored object data.
   * @param name - Table name.
   * @returns Typed Table reference.
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

  // -- Authentication -------------------------------------------------------

  /**
   * Retrieves the current authentication status.
   */
  get authStatus(): AuthStatus {
    return this.auth.status;
  }

  /**
   * Retrieves the active authentication session token if signed in.
   */
  get token(): string | undefined {
    return this.auth.token;
  }

  /**
   * Retrieves the username of the currently signed-in user.
   */
  get userName(): string | undefined {
    return this.auth.userName;
  }

  /**
   * Registers a new account, applies data mode, and automatically connects sync.
   *
   * @param options - Account credentials and data reconciliation mode.
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

  /**
   * Initiates leader election using the Web Locks API scoped to `${TETHER_PREFIX}${name}`.
   * The tab that acquires the exclusive lock becomes the leader coordinator.
   */
  private startLeaderElection(): void {
    if (typeof navigator === 'undefined' || !navigator.locks) {
      return;
    }

    const lockName = `${TETHER_PREFIX}${this.storage.name}`;
    this.leaderLockAbortController = new AbortController();
    const { signal } = this.leaderLockAbortController;

    navigator.locks
      .request(lockName, { mode: 'exclusive', signal }, async () => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error('TetherDB leader lock error:', err);
        }
      });
  }
}

// -- Private Helpers ------------------------------------------------------

function createStorage(name: string): Storage {
  return new Storage(name);
}

function createAuth(storage: Storage, sync: Sync): Auth {
  return new Auth(storage, sync);
}

function createSync(storage: Storage, options: TetherClientOptions): Sync {
  return new Sync(storage, {
    url: options.url ?? inferUrl(),
    clientId: storage.clientId,
    tables: options.tables,
    webSocketClass: options.webSocketClass,
    pushDebounceMs: options.pushDebounceMs,
    reconnectIntervalMs: options.reconnectIntervalMs,
    maxReconnectIntervalMs: options.maxReconnectIntervalMs,
    pingIntervalMs: options.pingIntervalMs,
  });
}

function inferUrl(): string | undefined {
  const raw =
    typeof window !== 'undefined'
      ? (window.location?.origin ?? window.location?.href)
      : undefined;
  if (!raw || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/tether';
  return url.toString();
}
