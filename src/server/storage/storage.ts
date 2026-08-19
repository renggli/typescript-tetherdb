import type { AppStorage } from './app.js';
import type { UserStorage } from './user.js';

/**
 * Configuration options and resource limits for storage engines.
 */
export interface StorageOptions {
  /** Maximum number of active records allowed per table (default: 10,000). */
  maxRecordsPerTable?: number;
  /** Maximum allowed payload size in bytes for an individual record (default: 512 KB). */
  maxRecordSizeBytes?: number;
  /** Maximum allowed size in bytes for a single change batch payload (default: 5 MB). */
  maxBatchSizeBytes?: number;
  /** Maximum number of changelog entries retained per user before compaction (default: 1,000). */
  maxChangelogEntries?: number;
  /** Secret key used for signing session tokens. */
  secret?: string;
}

/**
 * Summary status information describing the storage engine and its contents.
 */
export interface StorageStatus {
  /** Storage persistence type ('sqlite', 'file', or 'memory'). */
  backend: string;
  /** Storage base directory if disk-backed. */
  baseDir?: string;
  /** Number of registered user accounts. */
  usersCount: number;
  /** Number of registered applications. */
  appsCount: number;
  /** Detailed statistics per application if queried or available. */
  apps?: Array<{
    id: string;
    tables: string[];
  }>;
}

/**
 * Result returned by a storage maintenance operation.
 */
export interface MaintenanceResult {
  /** Maintenance action performed ('checkpoint', 'vacuum', 'prune'). */
  action: 'checkpoint' | 'vacuum' | 'prune';
  /** Target backend name. */
  backend: string;
  /** Optional target application ID. */
  appId?: string;
  /** Number of entries or database files affected, if applicable. */
  affectedCount?: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Top-level storage coordinator managing application namespaces and user accounts.
 */
export interface Storage {
  /** Storage configuration options and resource limits. */
  readonly options?: StorageOptions;

  /**
   * Creates/registers a new application namespace.
   * Throws an error if an application with the specified ID already exists.
   *
   * @param id - Unique application identifier.
   * @returns Created AppStorage handle.
   * @throws Error if the application already exists.
   */
  createApp(id: string): Promise<AppStorage>;

  /**
   * Retrieves an application handle if it exists.
   *
   * @param id - Unique application identifier.
   * @returns AppStorage handle or `undefined` if not found.
   */
  getApp(id: string): Promise<AppStorage | undefined>;

  /**
   * Lists all registered application handles.
   *
   * @returns Array of AppStorage handles.
   */
  getApps(): Promise<AppStorage[]>;

  /**
   * Creates a new user account with credentials.
   * Throws an error if a user with the same username already exists.
   *
   * @param username - Username for the account.
   * @param password - Account password.
   * @returns Created UserStorage handle.
   * @throws Error if the username is already registered.
   */
  createUser(username: string, password: string): Promise<UserStorage>;

  /**
   * Retrieves a user handle by user account ID.
   *
   * @param id - Unique user identifier.
   * @returns UserStorage handle or `undefined` if not found.
   */
  getUser(id: string): Promise<UserStorage | undefined>;

  /**
   * Retrieves a user handle by username.
   *
   * @param username - User account username.
   * @returns UserStorage handle or `undefined` if not found.
   */
  getUserByUsername(username: string): Promise<UserStorage | undefined>;

  /**
   * Retrieves a user handle by validating a session token.
   *
   * @param token - Signed session token.
   * @returns UserStorage handle if token is valid and active, or `undefined`.
   */
  getUserByToken(token: string): Promise<UserStorage | undefined>;

  /**
   * Lists all user accounts.
   *
   * @returns Array of UserStorage handles.
   */
  getUsers(): Promise<UserStorage[]>;

  /**
   * Retrieves summary operational status of the storage backend.
   *
   * @param appId - Optional application identifier filter.
   * @returns StorageStatus object.
   */
  getStatus(appId?: string): Promise<StorageStatus>;

  /**
   * Performs a WAL checkpoint on SQLite databases to truncate WAL files.
   *
   * @param appId - Optional target application identifier.
   * @returns MaintenanceResult describing checkpoint outcome.
   * @throws TetherServerError if checkpoint is not supported by this backend.
   */
  checkpoint(appId?: string): Promise<MaintenanceResult>;

  /**
   * Performs database vacuuming to reclaim disk space and defragment storage.
   *
   * @param appId - Optional target application identifier.
   * @returns MaintenanceResult describing vacuum outcome.
   * @throws TetherServerError if vacuum is not supported by this backend.
   */
  vacuum(appId?: string): Promise<MaintenanceResult>;

  /**
   * Prunes changelog history entries older than the retention threshold.
   *
   * @param appId - Optional target application identifier.
   * @param keepCount - Optional maximum entries to retain per table/user (defaults to configured limit).
   * @returns MaintenanceResult describing prune outcome.
   */
  prune(appId?: string, keepCount?: number): Promise<MaintenanceResult>;

  /**
   * Optional cleanup callback invoked when shutting down the storage engine.
   */
  close?(): Promise<void>;
}
