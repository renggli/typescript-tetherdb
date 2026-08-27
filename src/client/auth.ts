import { TetherClientError, TetherClientErrorCode } from './errors.js';
import { EventRegistry } from './shared/event.js';
import type { Storage } from './storage.js';

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
  /** Unique username (required). */
  username: string;
  /** Account password (required). */
  password: string;
  /** Persist session in IndexedDB for automatic login across sessions (default: false). */
  remember?: boolean;
  /** Local data handling mode (defaults to DataMode.Local when signed out, or DataMode.Clear when already signed in). */
  dataMode?: DataMode;
}

/**
 * Options for logging into an existing user account.
 */
export interface LoginOptions {
  /** Unique username (optional if already remembered). */
  username?: string;
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
  /** Unique user identifier (UUID). */
  userId: string;
  /** User's unique username. */
  username: string;
  /** Signed session authentication token for sync and API calls. */
  token: string;
}

/**
 * Internal persisted session representation in IndexedDB metadata.
 */
export interface StoredAuthSession {
  userId: string;
  username: string;
  token: string;
}

/**
 * Internal dependencies provided to Auth by TetherClient.
 */
export interface AuthDependencies {
  baseUrl: string;
  storage: Storage;
  fetchFn?: typeof fetch;
}

/**
 * Authentication coordinator managing user sessions, HTTP requests,
 * metadata persistence, and reconciliation state transitions.
 */
export class Auth {
  /** Base URL for remote authentication REST API endpoints. */
  readonly baseUrl: string;
  /** Reactive event registry triggered whenever the authentication status changes. */
  readonly onStatusChange = new EventRegistry<AuthStatus>();

  private storage: Storage;
  private fetchFn: typeof fetch;
  private currentAuthStatus: AuthStatus = AuthStatus.SignedOut;
  private currentUsername?: string;
  private currentUserId?: string;
  private currentToken?: string;
  private autoRestorePromise: Promise<void>;

  constructor(dependencies: AuthDependencies) {
    this.baseUrl = dependencies.baseUrl;
    this.storage = dependencies.storage;

    const rawFetch =
      dependencies.fetchFn ??
      (typeof globalThis !== 'undefined' && globalThis.fetch
        ? globalThis.fetch
        : typeof fetch !== 'undefined'
          ? fetch
          : undefined);

    if (!rawFetch) {
      throw new TetherClientError(
        TetherClientErrorCode.FetchUnavailable,
        'No fetch implementation available',
      );
    }
    this.fetchFn = rawFetch.bind(globalThis);
    this.autoRestorePromise = this.restoreSession();
  }

  /**
   * Current authentication lifecycle status.
   */
  get status(): AuthStatus {
    return this.currentAuthStatus;
  }

  /**
   * The authenticated user's username, or `undefined` if signed out.
   */
  get username(): string | undefined {
    return this.currentUsername;
  }

  /**
   * The authenticated user's ID, or `undefined` if signed out.
   */
  get userId(): string | undefined {
    return this.currentUserId;
  }

  /**
   * The active authentication session token, or `undefined` if signed out.
   */
  get token(): string | undefined {
    return this.currentToken;
  }

  /**
   * Restores any remembered session from IndexedDB metadata on startup.
   */
  async restoreSession(): Promise<void> {
    try {
      const session = await this.storage.getMeta<StoredAuthSession>('auth');
      if (session?.token && session.username) {
        this.currentUserId = session.userId;
        this.currentUsername = session.username;
        this.currentToken = session.token;
        this.setStatus(AuthStatus.SignedIn);
      }
    } catch {
      // Ignored during initial background boot
    }
  }

  /**
   * Registers a new user account, applies local data mode, and notifies listeners.
   */
  async register(options: RegisterOptions): Promise<boolean> {
    if (!options?.username || !options?.password) {
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

      const data = await this.sendAuthRequest(
        '/auth/register',
        { username: options.username, password: options.password },
        TetherClientErrorCode.RegistrationFailed,
        'Registration failed',
      );

      this.currentUserId = data.userId;
      this.currentUsername = data.username;
      this.currentToken = data.token;

      await this.applyDataMode(dataMode);
      await this.updateStoredAuth(options.remember ?? false, data);

      this.setStatus(AuthStatus.SignedIn);
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
      let username = this.currentUsername;
      let userId = this.currentUserId;

      if (options.username && options.password) {
        const data = await this.sendAuthRequest(
          '/auth/login',
          { username: options.username, password: options.password },
          TetherClientErrorCode.AuthenticationFailed,
          'Authentication failed',
        );

        token = data.token;
        username = data.username;
        userId = data.userId;

        await this.updateStoredAuth(options.remember ?? false, data);
      } else if (!token) {
        const stored = await this.storage.getMeta<StoredAuthSession>('auth');
        if (stored?.token) {
          token = stored.token;
          username = stored.username;
          userId = stored.userId;
        }
      }

      if (!token) {
        throw new TetherClientError(
          TetherClientErrorCode.MissingCredentials,
          'No login credentials or saved session available',
        );
      }

      this.currentToken = token;
      this.currentUsername = username;
      this.currentUserId = userId;

      await this.applyDataMode(options.dataMode ?? DataMode.Remote);

      this.setStatus(AuthStatus.SignedIn);
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
    this.currentUserId = undefined;
    this.currentUsername = undefined;
    this.currentToken = undefined;

    await this.storage.deleteMeta('auth');
    await this.applyDataMode(options.dataMode ?? DataMode.Clear);

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
    }
  }

  /**
   * Cleans up local session and transitions to SignedOut when authentication fails or expires.
   *
   * @param _message - Optional error message from the server.
   */
  async handleAuthError(_message?: string): Promise<void> {
    this.currentUserId = undefined;
    this.currentUsername = undefined;
    this.currentToken = undefined;
    await this.storage.deleteMeta('auth');
    this.setStatus(AuthStatus.SignedOut);
  }

  // -- Private Helpers ------------------------------------------------------

  private async sendAuthRequest(
    path: string,
    credentials: { username?: string; password?: string },
    errorCode: TetherClientErrorCode,
    defaultErrorMessage: string,
  ): Promise<AuthResult> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    const data = (await res.json()) as AuthResult & { error?: string };
    if (!res.ok) {
      throw new TetherClientError(errorCode, data.error ?? defaultErrorMessage);
    }
    return data;
  }

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
        userId: auth.userId,
        username: auth.username,
      });
    } else {
      await this.storage.deleteMeta('auth');
    }
  }

  private setStatus(status: AuthStatus): void {
    if (this.currentAuthStatus === status) return;
    this.currentAuthStatus = status;
    this.onStatusChange.publish(status);
  }
}
