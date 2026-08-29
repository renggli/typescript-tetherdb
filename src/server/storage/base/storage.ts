import type { ChangeRecord, TableSettings } from '../../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import { verifySessionToken } from '../../shared/crypto.js';
import {
  calculateByteSize,
  validateRecordId,
  validateTableName,
  validateTimestamp,
} from '../../shared/validate.js';
import type {
  BackendType,
  MaintenanceResult,
  Storage,
  StorageOptions,
  StorageStatus,
} from '../storage.js';
import type { ApplyChangesOptions, TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';

/**
 * Common abstract base class for Storage implementations.
 */
export abstract class BaseStorage implements Storage {
  readonly options?: StorageOptions;

  constructor(options?: StorageOptions) {
    this.options = options;
  }

  /** Backend persistence type ('file', 'memory', 'sqlite'). */
  abstract readonly backend: BackendType;

  /** Secret key used for signing session tokens. */
  abstract readonly secret: string;

  /** Optional storage base directory if disk-backed. */
  protected getBaseDir(): string | undefined {
    return undefined;
  }

  abstract createTable(
    name: string,
    settings?: TableSettings,
  ): Promise<TableStorage>;
  abstract getTable(name: string): Promise<TableStorage | undefined>;
  abstract getTables(): Promise<TableStorage[]>;
  abstract deleteTable(name: string): boolean | Promise<boolean>;

  abstract createUser(userName: string, password: string): Promise<UserStorage>;
  abstract getUser(id: string): Promise<UserStorage | undefined>;
  abstract getUserByUserName(
    userName: string,
  ): Promise<UserStorage | undefined>;
  abstract getUsers(): Promise<UserStorage[]>;
  abstract deleteUser(id: string): boolean | Promise<boolean>;

  abstract applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
    options?: ApplyChangesOptions,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  abstract getChangesSince(
    user: UserStorage | undefined,
    fromSeq: number,
    tableFilters?: string[],
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  abstract getCurrentSeq(user?: UserStorage): Promise<number>;

  abstract checkpoint(tableName?: string): Promise<MaintenanceResult>;
  abstract vacuum(): Promise<MaintenanceResult>;
  abstract prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult>;

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const payload = verifySessionToken(token, this.secret);
    if (!payload) return undefined;
    return this.getUser(payload.userId);
  }

  async getStatus(): Promise<StorageStatus> {
    const users = await this.getUsers();
    const tables = await this.getTables();
    const tableSummaries = await buildTableSummaries(tables);

    const status: StorageStatus = {
      backend: this.backend,
      usersCount: users.length,
      tablesCount: tables.length,
      tables: tableSummaries,
    };
    const baseDir = this.getBaseDir();
    if (baseDir !== undefined) {
      status.baseDir = baseDir;
    }
    return status;
  }
}

/**
 * Builds array of table summaries including read permissions and record counts.
 */
export async function buildTableSummaries(
  tables: TableStorage[],
): Promise<Array<{ name: string; read: string; recordsCount: number }>> {
  const summaries: Array<{
    name: string;
    read: string;
    recordsCount: number;
  }> = [];
  for (const table of tables) {
    const records = await table.getAllRecords();
    summaries.push({
      name: table.name,
      read: table.settings.permissions?.read ?? 'owner',
      recordsCount: records.length,
    });
  }
  return summaries;
}

/**
 * Validates a batch of change records before applying them to storage.
 */
export async function validateBatchChanges(
  storage: Storage,
  changes: ChangeRecord[],
  defaultMaxRecordSize = 512 * 1024,
): Promise<void> {
  for (const change of changes) {
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
 */
export function isSnapshotRequired(
  fromSeq: number,
  minSeq: number,
  currentSeq: number,
): boolean {
  return (fromSeq < minSeq && minSeq > 0) || fromSeq > currentSeq;
}
