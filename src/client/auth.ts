import { TetherClientError, TetherClientErrorCode } from './errors.js';
import { EventRegistry } from './shared/event.js';
import type { Storage } from './storage/storage.js';
import { TETHER_PREFIX } from './storage/utils.js';
import type { Sync } from './sync/sync.js';

/**
 * Data reconciliation and persistence strategy for auth and session operations.
 */
export enum DataMode {
  /** Overwrite local data with remote server snapshot. */
  Remote,
  /** Preserve local data and upload/reconcile with remote. */
  Local,
  /** Merge local and remote changes using Last-Write-Wins. */
  Merge,
  /** Wipe local data tables and reset sync sequence. */
  Clear,
}

/**
 * Authentication lifecycle states of the client.
 */
export enum AuthStatus {
  /** No active session. */
  SignedOut,
  /** Authenticating or restoring remembered session. */
  SigningIn,
  /** Authenticated and ready for synchronized operations. */
  SignedIn,
  /** Authentication failed (e.g. invalid credentials or expired session). */
  Error,
}

/**
 * Options for registering a new user account.
 */
export interface RegisterOptions {
  /** Unique username. */
  userName: string;
  /** Account password (required). */
  password: string;
  /** Persist session in IndexedDB and localStorage for automatic login across sessions (default: false). */
  remember?: boolean;
  /** Local data handling mode (defaults to DataMode.Local when signed out, or DataMode.Clear when already signed in). */
  dataMode?: DataMode;
}

/**
 * Options for logging into an existing user account.
 */
export interface LoginOptions {
  /** Unique username (optional if already remembered). */
  userName?: string;
  /** Account password (optional if already remembered). */
  password?: string;
  /** Persist session for automatic login across sessions (default: false). */
  remember?: boolean;
  /** Data reconciliation mode (default: DataMode.Remote). */
  dataMode?: DataMode;
}

/**
 * Options for logging out of the current user session.
 */
export interface LogoutOptions {
  /** Data preservation mode (default: DataMode.Clear to wipe local data). */
  dataMode?: DataMode;
}

/**
 * Result returned upon successful user registration or login.
 */
export interface AuthResult {
  /** User's unique username. */
  userName: string;
  /** Signed session authentication token for sync and API calls. */
  token: string;
}

/**
 * Internal persisted session representation in IndexedDB metadata and localStorage.
 */
export interface StoredAuthSession {
  userName: string;
  token: string;
}

/**
 * Authentication coordinator managing user sessions, network requests,
 * metadata persistence, and reconciliation state transitions.
 */
export class Auth {
  /** Reactive event registry triggered whenever the authentication status changes. */
  readonly onStatusChange = new EventRegistry<AuthStatus>();

  private readonly storage: Storage;
  private readonly sync: Sync;
  private currentAuthStatus: AuthStatus = AuthStatus.SignedOut;
  private currentUserName?: string;
  private currentToken?: string;
  private autoRestorePromise: Promise<void>;

  /**
   * Creates a new Auth coordinator instance.
   *
   * @param storage - Local storage coordinator.
   * @param sync - Real-time sync and network coordinator.
   */
  constructor(storage: Storage, sync: Sync) {
    this.storage = storage;
    this.sync = sync;

    const localSession = getLocalStorageSession(this.storage.name);
    if (localSession?.token && localSession.userName) {
      this.currentUserName = localSession.userName;
      this.currentToken = localSession.token;
      this.currentAuthStatus = AuthStatus.SignedIn;
    }

    this.autoRestorePromise = this.restoreSession();
  }

  /**
   * Current authentication lifecycle status.
   */
  get status(): AuthStatus {
    return this.currentAuthStatus;
  }

  /**
   * The authenticated user's name, or `undefined` if signed out.
   */
  get userName(): string | undefined {
    return this.currentUserName;
  }

  /**
   * The active authentication session token, or `undefined` if signed out.
   */
  get token(): string | undefined {
    return this.currentToken;
  }

  /**
   * Restores any remembered session from localStorage or IndexedDB metadata on startup.
   */
  async restoreSession(): Promise<void> {
    try {
      if (this.currentAuthStatus === AuthStatus.SignedIn) {
        return;
      }

      const localSession = getLocalStorageSession(this.storage.name);
      if (localSession?.token && localSession.userName) {
        this.currentUserName = localSession.userName;
        this.currentToken = localSession.token;
        this.setStatus(AuthStatus.SignedIn);
        return;
      }

      const session = await this.storage.getMeta<StoredAuthSession>('auth');
      if (session?.token && session.userName) {
        this.currentUserName = session.userName;
        this.currentToken = session.token;
        this.setStatus(AuthStatus.SignedIn);
      }
    } catch {
      // Ignored during initial background boot
    }
  }

  /**
   * Applies an authentication transition triggered remotely from a sibling tab.
   * Updates in-memory state without initiating new network requests.
   *
   * @param status - The target AuthStatus.
   * @param userName - Authenticated username (when status is SignedIn).
   * @param token - Session token (when status is SignedIn).
   */
  applyRemoteAuth(status: AuthStatus, userName?: string, token?: string): void {
    if (status === AuthStatus.SignedIn && token && userName) {
      this.currentUserName = userName;
      this.currentToken = token;
      this.setStatus(AuthStatus.SignedIn);
    } else if (status === AuthStatus.SignedOut) {
      this.currentUserName = undefined;
      this.currentToken = undefined;
      this.setStatus(AuthStatus.SignedOut);
    }
  }

  /**
   * Registers a new user account, applies local data mode, and notifies listeners.
   */
  async register(options: RegisterOptions): Promise<boolean> {
    if (!options?.userName || !options?.password) {
      throw new TetherClientError(
        TetherClientErrorCode.MissingCredentials,
        'Registration requires username and password',
      );
    }

    const previousStatus = this.currentAuthStatus;
    this.setStatus(AuthStatus.SigningIn);

    try {
      const defaultDataMode =
        previousStatus === AuthStatus.SignedIn
          ? DataMode.Clear
          : DataMode.Local;
      const dataMode = options.dataMode ?? defaultDataMode;

      const data = await this.sync.register(options.userName, options.password);

      this.currentUserName = data.userName;
      this.currentToken = data.token;

      if (dataMode === DataMode.Clear || dataMode === DataMode.Remote) {
        await this.applyDataMode(dataMode);
      }
      await this.updateStoredAuth(options.remember ?? false, data);

      this.setStatus(AuthStatus.SignedIn);
      this.sync.schedulePush(0);
      return true;
    } catch {
      this.setStatus(AuthStatus.Error);
      return false;
    }
  }

  /**
   * Logs into an account (or reconnects with remembered credentials), applies data mode, and notifies listeners.
   */
  async login(options: LoginOptions = {}): Promise<boolean> {
    await this.autoRestorePromise;

    this.setStatus(AuthStatus.SigningIn);

    try {
      let token = this.currentToken;
      let userName = this.currentUserName;

      await this.applyDataMode(options.dataMode ?? DataMode.Remote);

      if (options.userName && options.password) {
        const data = await this.sync.login({
          userName: options.userName,
          password: options.password,
        });

        token = data.token;
        userName = data.userName;

        if (token && userName) {
          await this.updateStoredAuth(options.remember ?? false, {
            token,
            userName,
          });
        }
      } else if (!token) {
        const localSession = getLocalStorageSession(this.storage.name);
        if (localSession?.token) {
          token = localSession.token;
          userName = localSession.userName;
        } else {
          const stored = await this.storage.getMeta<StoredAuthSession>('auth');
          if (stored?.token) {
            token = stored.token;
            userName = stored.userName;
          }
        }
      }

      if (!token) {
        throw new TetherClientError(
          TetherClientErrorCode.MissingCredentials,
          'No login credentials or saved session available',
        );
      }

      if (!options.userName) {
        await this.sync.login({ token });
      }

      this.currentToken = token;
      this.currentUserName = userName;

      this.setStatus(AuthStatus.SignedIn);
      this.sync.schedulePush(0);
      return true;
    } catch {
      this.setStatus(AuthStatus.Error);
      return false;
    }
  }

  /**
   * Logs out of the current session, removes stored credentials, and applies data mode.
   */
  async logout(options: LogoutOptions = {}): Promise<boolean> {
    try {
      await this.sync.logout();
    } catch {
      // Ignored if offline
    }
    this.currentUserName = undefined;
    this.currentToken = undefined;

    await this.applyDataMode(options.dataMode ?? DataMode.Clear);
    await this.storage.deleteMeta('auth');
    removeLocalStorageSession(this.storage.name);

    this.setStatus(AuthStatus.SignedOut);
    return true;
  }

  /**
   * Updates the in-memory and persisted session token when refreshed by the server.
   *
   * @param token - The new refreshed session token.
   */
  async handleTokenRefresh(token: string): Promise<void> {
    this.currentToken = token;
    const session = await this.storage.getMeta<StoredAuthSession>('auth');
    if (session) {
      await this.storage.setMeta('auth', {
        ...session,
        token,
      });
      if (getLocalStorageSession(this.storage.name)) {
        setLocalStorageSession(this.storage.name, {
          ...session,
          token,
        });
      }
    }
  }

  /**
   * Cleans up local session and transitions to SignedOut when authentication fails or expires.
   *
   * @param _message - Optional error message from the server.
   */
  async handleAuthError(_message?: string): Promise<void> {
    this.currentUserName = undefined;
    this.currentToken = undefined;
    await this.storage.deleteMeta('auth');
    removeLocalStorageSession(this.storage.name);
    this.setStatus(AuthStatus.SignedOut);
  }

  // -- Private Helpers ------------------------------------------------------

  private async applyDataMode(dataMode: DataMode): Promise<void> {
    if (dataMode === DataMode.Clear || dataMode === DataMode.Remote) {
      await this.storage.clearTables(true);
    }
    await this.storage.setMeta('lastSyncSeq', 0);
  }

  private async updateStoredAuth(
    remember: boolean,
    auth: AuthResult,
  ): Promise<void> {
    if (remember) {
      await this.storage.setMeta('auth', {
        token: auth.token,
        userName: auth.userName,
      });
      setLocalStorageSession(this.storage.name, {
        token: auth.token,
        userName: auth.userName,
      });
    } else {
      await this.storage.deleteMeta('auth');
      removeLocalStorageSession(this.storage.name);
    }
  }

  private setStatus(status: AuthStatus): void {
    if (this.currentAuthStatus === status) return;
    this.currentAuthStatus = status;
    this.onStatusChange.publish(status);
  }
}

// -- Storage Helpers -------------------------------------------------------

function authStorageKey(databaseName: string): string {
  return `${TETHER_PREFIX}${databaseName}:auth`;
}

function getStorage(): StorageArea | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    return null;
  } catch {
    return null;
  }
}

interface StorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getLocalStorageSession(
  databaseName: string,
): StoredAuthSession | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem(authStorageKey(databaseName));
    if (!raw) return null;
    return JSON.parse(raw) as StoredAuthSession;
  } catch {
    return null;
  }
}

function setLocalStorageSession(
  databaseName: string,
  session: StoredAuthSession,
): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(authStorageKey(databaseName), JSON.stringify(session));
  } catch {
    // Ignored in restricted environments
  }
}

function removeLocalStorageSession(databaseName: string): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.removeItem(authStorageKey(databaseName));
  } catch {
    // Ignored in restricted environments
  }
}
