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
   * Optional cleanup callback invoked when shutting down the storage engine.
   */
  close?(): Promise<void>;
}
