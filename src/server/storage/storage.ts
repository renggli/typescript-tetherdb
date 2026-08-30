import * as crypto from 'node:crypto';
import {
  type ChangeRecord,
  OperationType,
  type TableSettings,
} from '../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import { filterAndSanitizeChanges } from '../security/filter.js';
import { UserResolver } from '../security/resolver.js';
import type {
  InternalChangeRecord,
  InternalStoredRecord,
} from '../security/types.js';
import { verifySessionToken } from '../shared/crypto.js';
import {
  calculateByteSize,
  validateRecordId,
  validateTableName,
  validateTimestamp,
} from '../shared/validate.js';
import type { ApplyChangesOptions, Table } from './table.js';
import type { User } from './user.js';

/**
 * Persistence storage engine type.
 */
export enum StorageType {
  Memory = 'memory',
  File = 'file',
  Sqlite = 'sqlite',
}

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
  type: StorageType;
  /** Storage base directory if disk-backed. */
  baseDir?: string;
  /** Number of registered user accounts. */
  usersCount: number;
  /** Number of registered tables. */
  tablesCount: number;
}

/**
 * Result returned by a storage maintenance operation.
 */
export interface MaintenanceResult {
  /** Maintenance action performed ('checkpoint', 'vacuum', 'prune'). */
  action: 'checkpoint' | 'vacuum' | 'prune';
  /** Target storage engine type. */
  type: StorageType;
  /** Number of entries or database files affected, if applicable. */
  affectedCount?: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Abstract storage coordinator managing tables, user accounts, and persistence drivers.
 */
export abstract class Storage {
  readonly options?: StorageOptions;

  /**
   * Initializes storage instance with optional configuration options.
   *
   * @param options - Storage configuration options and resource limits.
   */
  constructor(options?: StorageOptions) {
    this.options = options;
  }

  /** Storage persistence engine type. */
  abstract readonly type: StorageType;

  /** Storage base directory if disk-backed. */
  abstract readonly baseDir?: string;

  /** Secret key used for signing session tokens. */
  abstract readonly secret: string;

  // -- Table CRUD -----------------------------------------------------------

  /**
   * Creates/registers a new table.
   *
   * @param name - Name of the table.
   * @param settings - Optional table settings, limits, and access policies.
   * @returns Created Table handle.
   */
  abstract createTable(
    name: string,
    settings?: Partial<TableSettings>,
  ): Promise<Table>;

  /**
   * Retrieves a table handle if it exists.
   *
   * @param name - Name of the table.
   * @returns Table handle or `undefined`.
   */
  abstract getTable(name: string): Promise<Table | undefined>;

  /**
   * Optional driver hook to persist updated table settings.
   *
   * @param name - Target table name.
   * @param settings - Updated table settings.
   */
  updateTableSettings?(
    name: string,
    settings: TableSettings,
  ): Promise<void> | void;

  /**
   * Lists all registered table handles.
   *
   * @returns Array of Table handles.
   */
  abstract getTables(): Promise<Table[]>;

  /**
   * Deletes a registered table and its data.
   *
   * @param name - Name of the table.
   * @returns True if deleted successfully.
   */
  abstract deleteTable(name: string): boolean | Promise<boolean>;

  // -- User CRUD ------------------------------------------------------------

  /**
   * Creates a new user account with credentials.
   *
   * @param userName - Username for the account.
   * @param password - Account password.
   * @returns Created User handle.
   */
  abstract createUser(userName: string, password: string): Promise<User>;

  /**
   * Retrieves a user handle by user account ID.
   *
   * @param userId - Unique user identifier.
   * @returns User handle or `undefined` if not found.
   */
  abstract getUser(userId: string): Promise<User | undefined>;

  /**
   * Retrieves a user handle by username.
   *
   * @param userName - User account username.
   * @returns User handle or `undefined` if not found.
   */
  abstract getUserByUserName(userName: string): Promise<User | undefined>;

  /**
   * Retrieves a user handle by validating a session token.
   *
   * @param token - Signed session token.
   * @returns User handle if token is valid and active, or `undefined`.
   */
  async getUserByToken(token: string): Promise<User | undefined> {
    const payload = verifySessionToken(token, this.secret);
    if (!payload) return undefined;
    const user = await this.getUser(payload.userId);
    if (!user) return undefined;
    if (payload.pwd !== undefined) {
      const passwordHash = await this.getUserPasswordHash(user.userId);
      const expectedPwd = passwordHash
        ? crypto
            .createHash('sha256')
            .update(passwordHash)
            .digest('hex')
            .slice(0, 16)
        : '';
      if (payload.pwd !== expectedPwd) return undefined;
    }
    return user;
  }

  /**
   * Lists all user accounts.
   *
   * @returns Array of User handles.
   */
  abstract getUsers(): Promise<User[]>;

  /**
   * Deletes a user account and associated partitions.
   *
   * @param userId - Unique user identifier.
   * @returns True if deleted successfully.
   */
  abstract deleteUser(userId: string): boolean | Promise<boolean>;

  /**
   * Renames a user account without changing their ID or any associated data.
   *
   * @param userId - Unique user identifier.
   * @param newUserName - New username to assign.
   * @returns Updated User handle.
   */
  abstract renameUser(userId: string, newUserName: string): Promise<User>;

  // -- Password & Authentication --------------------------------------------

  /**
   * Retrieves password hash for a user.
   *
   * @param userId - Unique user identifier.
   * @returns Password hash or `null`/`undefined`.
   */
  abstract getUserPasswordHash(
    userId: string,
  ): Promise<string | null | undefined>;

  /**
   * Updates password hash for a user.
   *
   * @param userId - Unique user identifier.
   * @param hash - New password hash.
   */
  abstract setUserPasswordHash(userId: string, hash: string): Promise<void>;

  // -- Sync, Mutations & Changelog ------------------------------------------

  /**
   * Applies an array of mutation change operations across tables for a user or shared context.
   *
   * @param user - Target user handle (if authenticated).
   * @param changes - Array of change records.
   * @param options - Optional application options.
   * @returns Applied changes and new sequence number.
   */
  abstract applyChanges(
    user: User | undefined,
    changes: ChangeRecord[],
    options?: ApplyChangesOptions,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Retrieves change operations since a given sequence number.
   *
   * @param user - Target user handle (if authenticated).
   * @param fromSeq - Starting sequence number (exclusive).
   * @param tableFilters - Optional array of table names to filter.
   * @returns Changes, current sequence, and snapshot requirement flag.
   */
  async getChangesSince(
    user: User | undefined,
    fromSeq: number,
    tableFilters?: string[],
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const { rawChanges, currentSeq, minSeq } = await this.getRawChangesSince(
      fromSeq,
      user,
    );

    if (isSnapshotRequired(fromSeq, minSeq, currentSeq)) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const resolver = new UserResolver(this);
    const changes = await filterAndSanitizeChanges(
      rawChanges,
      user,
      (name) => this.getTable(name),
      resolver,
      tableFilters,
    );

    return { changes, currentSeq, requiresSnapshot: false };
  }

  /**
   * Returns the current global sequence number for a user or shared database.
   *
   * @param user - Optional target user handle.
   * @returns Current integer sequence number.
   */
  abstract getCurrentSeq(user?: User): Promise<number>;

  // -- Raw Persistence Driver Hooks -----------------------------------------

  /**
   * Raw driver hook: retrieves an internal stored record by partition and ID.
   *
   * @param tableName - Target table name.
   * @param partition - Partition identifier ('__shared__' or userId).
   * @param id - Record identifier.
   */
  abstract getRawRecord(
    tableName: string,
    partition: string,
    id: string,
  ): Promise<InternalStoredRecord | undefined>;

  /**
   * Raw driver hook: retrieves all internal stored records for a table partition.
   *
   * @param tableName - Target table name.
   * @param partition - Partition identifier ('__shared__' or userId).
   */
  abstract getRawRecords(
    tableName: string,
    partition: string,
  ): Promise<InternalStoredRecord[]>;

  /**
   * Raw driver hook: retrieves raw changelog mutations since a given sequence number.
   *
   * @param fromSeq - Starting sequence number.
   * @param user - Target user context.
   */
  abstract getRawChangesSince(
    fromSeq: number,
    user?: User,
  ): Promise<{
    rawChanges: InternalChangeRecord[];
    currentSeq: number;
    minSeq: number;
  }>;

  // -- Maintenance & Operations ---------------------------------------------

  /**
   * Retrieves summary operational status of the storage backend.
   *
   * @returns StorageStatus object.
   */
  async getStatus(): Promise<StorageStatus> {
    const users = await this.getUsers();
    const tables = await this.getTables();

    const status: StorageStatus = {
      type: this.type,
      usersCount: users.length,
      tablesCount: tables.length,
    };
    if (this.baseDir !== undefined) {
      status.baseDir = this.baseDir;
    }
    return status;
  }

  /**
   * Performs a WAL checkpoint on SQLite databases to truncate WAL files.
   *
   * @returns MaintenanceResult describing checkpoint outcome.
   */
  abstract checkpoint(): Promise<MaintenanceResult>;

  /**
   * Performs database vacuuming to reclaim disk space and defragment storage.
   *
   * @returns MaintenanceResult describing vacuum outcome.
   */
  abstract vacuum(): Promise<MaintenanceResult>;

  /**
   * Prunes changelog history entries older than the retention threshold.
   *
   * @param keepCount - Optional maximum entries to retain.
   * @returns MaintenanceResult describing prune outcome.
   */
  abstract prune(keepCount?: number): Promise<MaintenanceResult>;

  /**
   * Optional cleanup callback invoked when shutting down the storage engine.
   */
  close?(): Promise<void>;
}

// -- Utility Functions ------------------------------------------------------

/**
 * Validates a batch of change records before applying them to storage.
 *
 * @param storage - Target storage engine.
 * @param changes - Array of change records to validate.
 * @param defaultMaxRecordSize - Fallback max record size in bytes.
 */
export async function validateBatchChanges(
  storage: Storage,
  changes: ChangeRecord[],
  defaultMaxRecordSize = 512 * 1024,
): Promise<void> {
  for (const change of changes) {
    if (
      !change ||
      typeof change !== 'object' ||
      (change.op !== OperationType.Put && change.op !== OperationType.Delete)
    ) {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        `Invalid change operation "${change?.op}"`,
      );
    }

    const tableName = validateTableName(change.table);
    validateRecordId(change.id);
    validateTimestamp(change.timestamp);

    const table = await storage.getTable(tableName);
    if (!table) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Table "${tableName}" not found`,
      );
    }

    const maxRecordSize =
      table.settings.maxRecordSizeBytes ?? defaultMaxRecordSize;
    const payloadBytes = calculateByteSize(change.data);
    if (payloadBytes > maxRecordSize) {
      throw new TetherServerError(
        TetherServerErrorCode.LimitExceeded,
        'Record payload exceeds maximum allowed size',
      );
    }
  }
}

/**
 * Determines whether a requested sequence number requires a full snapshot sync.
 *
 * @param fromSeq - Requested client sequence number.
 * @param minSeq - Minimum available sequence number in changelog.
 * @param currentSeq - Current server sequence number.
 * @returns True if full snapshot sync is required.
 */
export function isSnapshotRequired(
  fromSeq: number,
  minSeq: number,
  currentSeq: number,
): boolean {
  return (fromSeq < minSeq && minSeq > 0) || fromSeq > currentSeq;
}
