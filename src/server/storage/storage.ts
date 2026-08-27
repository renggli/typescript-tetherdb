import type { ChangeRecord, TableSettings } from '../../shared/types.js';
import type { TableStorage } from './table.js';
import type { UserStorage } from './user.js';

/**
 * Configuration options and resource limits for storage engines.
 */
export interface StorageOptions {
  /** Secret key used for signing session tokens. */
  secret?: string;
  /** Maximum number of active records allowed per table partition. */
  maxRecords?: number;
  /** Maximum allowed payload size in bytes for an individual record. */
  maxRecordSizeBytes?: number;
  /** Maximum allowed size in bytes for a single change batch payload. */
  maxBatchSizeBytes?: number;
  /** Maximum number of history entries retained per partition before compaction. */
  maxHistoryEntries?: number;
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
  /** Number of registered tables. */
  tablesCount: number;
  /** Detailed statistics per table if queried or available. */
  tables?: Array<{
    name: string;
    read: string;
    recordsCount: number;
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
  /** Optional target table name. */
  tableName?: string;
  /** Number of entries or database files affected, if applicable. */
  affectedCount?: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Top-level storage coordinator managing tables and user accounts.
 */
export interface Storage {
  /** Storage configuration options and resource limits. */
  readonly options?: StorageOptions;

  /**
   * Creates/registers a new table.
   * Throws an error if a table with the specified name already exists.
   *
   * @param name - Name of the table.
   * @param settings - Optional table settings, limits, and access policies.
   * @returns Created TableStorage handle.
   * @throws Error if the table already exists.
   */
  createTable(name: string, settings?: TableSettings): Promise<TableStorage>;

  /**
   * Retrieves a table handle if it exists.
   *
   * @param name - Name of the table.
   * @returns TableStorage handle or `undefined`.
   */
  getTable(name: string): Promise<TableStorage | undefined>;

  /**
   * Lists all registered table handles.
   *
   * @returns Array of TableStorage handles.
   */
  getTables(): Promise<TableStorage[]>;

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
   * Applies an array of mutation change operations across tables for a user or shared context.
   *
   * @param user - Target user handle (if authenticated).
   * @param changes - Array of change records.
   * @returns Applied changes and new sequence number.
   */
  applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Retrieves change operations since a given sequence number.
   *
   * @param user - Target user handle (if authenticated).
   * @param fromSeq - Starting sequence number (exclusive).
   * @param tableFilters - Optional array of table names to filter.
   * @returns Changes, current sequence, and snapshot requirement flag.
   */
  getChangesSince(
    user: UserStorage | undefined,
    fromSeq: number,
    tableFilters?: string[],
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  /**
   * Returns the current global sequence number for a user or shared database.
   *
   * @param user - Optional target user handle.
   * @returns Current integer sequence number.
   */
  getCurrentSeq(user?: UserStorage): Promise<number>;

  /**
   * Retrieves summary operational status of the storage backend.
   *
   * @returns StorageStatus object.
   */
  getStatus(): Promise<StorageStatus>;

  /**
   * Performs a WAL checkpoint on SQLite databases to truncate WAL files.
   *
   * @param tableName - Optional target table name.
   * @returns MaintenanceResult describing checkpoint outcome.
   * @throws TetherServerError if checkpoint is not supported by this backend.
   */
  checkpoint(tableName?: string): Promise<MaintenanceResult>;

  /**
   * Performs database vacuuming to reclaim disk space and defragment storage.
   *
   * @returns MaintenanceResult describing vacuum outcome.
   * @throws TetherServerError if vacuum is not supported by this backend.
   */
  vacuum(): Promise<MaintenanceResult>;

  /**
   * Prunes changelog history entries older than the retention threshold.
   *
   * @param keepCount - Optional maximum entries to retain per table/user (defaults to configured limit).
   * @param tableName - Optional target table name.
   * @returns MaintenanceResult describing prune outcome.
   */
  prune(keepCount?: number, tableName?: string): Promise<MaintenanceResult>;

  /**
   * Optional cleanup callback invoked when shutting down the storage engine.
   */
  close?(): Promise<void>;
}
