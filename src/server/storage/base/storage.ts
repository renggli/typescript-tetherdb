import type {
  BackendType,
  ChangeRecord,
  TableSettings,
} from '../../../shared/types.js';
import { verifySessionToken } from '../../crypto.js';
import type {
  MaintenanceResult,
  Storage,
  StorageOptions,
  StorageStatus,
} from '../storage.js';
import type { TableStorage } from '../table.js';
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

  abstract createUser(username: string, password: string): Promise<UserStorage>;
  abstract getUser(id: string): Promise<UserStorage | undefined>;
  abstract getUserByUsername(
    username: string,
  ): Promise<UserStorage | undefined>;
  abstract getUsers(): Promise<UserStorage[]>;

  abstract applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
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
