import * as crypto from 'node:crypto';
import { shouldOverwrite } from '../../../shared/clock.js';
import {
  BackendType,
  type ChangeRecord,
  OperationType,
  type StoredRecord,
  type TableSettings,
} from '../../../shared/types.js';
import { hashPassword } from '../../crypto.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import {
  normalizeUsername,
  validatePassword,
  validateRecordId,
  validateTableName,
  validateUserId,
  validateUsername,
} from '../../validate.js';
import {
  applyChangeToRecord,
  assertCanMutate,
  BaseStorage,
  canRead,
  isPrivateTable,
  isSnapshotRequired,
  validateBatchChanges,
} from '../base/index.js';
import type { MaintenanceResult, StorageOptions } from '../storage.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import { TableMemoryStorage } from './table.js';
import { type MemoryUserData, UserMemoryStorage } from './user.js';

export interface StatePartition {
  currentSeq: number;
  minSeq: number;
  tables: Map<string, Map<string, StoredRecord>>;
  changelog: Array<ChangeRecord & { seq: number }>;
}

export interface MemoryStorageOptions extends StorageOptions {}

/**
 * In-memory implementation of `Storage`.
 */
export class MemoryStorage extends BaseStorage {
  readonly backend = BackendType.Memory;
  readonly secret: string;
  override readonly options: MemoryStorageOptions;
  private globalSeq = 0;
  private tables: Map<string, TableMemoryStorage> = new Map();
  private users: Map<string, MemoryUserData> = new Map();
  private usersByUsername: Map<string, string> = new Map();
  private userStates: Map<string, StatePartition> = new Map();
  private sharedState: StatePartition = {
    currentSeq: 0,
    minSeq: 0,
    tables: new Map(),
    changelog: [],
  };

  constructor(options: MemoryStorageOptions = {}) {
    super(options);
    this.options = options;
    this.secret = options.secret ?? crypto.randomBytes(32).toString('hex');
  }

  async createTable(
    name: string,
    settings: TableSettings = {},
  ): Promise<TableStorage> {
    const safeName = validateTableName(name);
    if (this.tables.has(safeName)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Table already exists',
      );
    }
    const table = new TableMemoryStorage(safeName, this, settings);
    this.tables.set(safeName, table);
    return table;
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    return this.tables.get(safeName);
  }

  async getTables(): Promise<TableStorage[]> {
    return Array.from(this.tables.values());
  }

  async createUser(username: string, password: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const validPassword = validatePassword(password);
    if (this.usersByUsername.has(safeUsername)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Username is already registered',
      );
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(validPassword);
    const userData: MemoryUserData = {
      id: userId,
      username: safeUsername,
      passwordHash,
      createdAt: Date.now(),
    };

    this.users.set(userId, userData);
    this.usersByUsername.set(safeUsername, userId);
    return new UserMemoryStorage(userData, this);
  }

  async getUser(id: string): Promise<UserStorage | undefined> {
    const safeUserId = validateUserId(id);
    const data = this.users.get(safeUserId);
    if (data) {
      return new UserMemoryStorage(data, this);
    }
    return undefined;
  }

  async getUserByUsername(username: string): Promise<UserStorage | undefined> {
    const safeUsername = normalizeUsername(username);
    if (!safeUsername) return undefined;
    const userId = this.usersByUsername.get(safeUsername);
    if (!userId) return undefined;
    const data = this.users.get(userId);
    if (data) {
      return new UserMemoryStorage(data, this);
    }
    return undefined;
  }

  async getUsers(): Promise<UserStorage[]> {
    return Array.from(this.users.values()).map(
      (data) => new UserMemoryStorage(data, this),
    );
  }

  async applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const defaultMaxRecords = this.options.maxRecords ?? 10_000;
    const defaultMaxRecordSize = this.options.maxRecordSizeBytes ?? 512 * 1024;
    const defaultMaxHistory = this.options.maxHistoryEntries ?? 1000;

    // Phase 1: Pre-validate all changes in the batch
    await validateBatchChanges(this, changes, defaultMaxRecordSize);

    // Phase 2: Stage mutations
    const stagedUserTables = new Map<string, Map<string, StoredRecord>>();
    const stagedSharedTables = new Map<string, Map<string, StoredRecord>>();
    const stagedApplied: (ChangeRecord & { seq: number })[] = [];

    const userState = user ? this.getUserState(user.id) : null;

    for (const change of changes) {
      const tableName = validateTableName(change.table);
      const recordId = validateRecordId(change.id);
      const table = this.tables.get(tableName);
      if (!table) continue;
      const isPrivate = isPrivateTable(table);

      const maxRecords = table.settings.maxRecords ?? defaultMaxRecords;
      let targetMap: Map<string, StoredRecord>;

      if (isPrivate) {
        if (!userState) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            `Authentication required for private table "${tableName}"`,
          );
        }
        let stagedMap = stagedUserTables.get(tableName);
        if (!stagedMap) {
          const existingMap = userState.tables.get(tableName);
          stagedMap = new Map(existingMap);
          stagedUserTables.set(tableName, stagedMap);
        }
        targetMap = stagedMap;
      } else {
        let stagedMap = stagedSharedTables.get(tableName);
        if (!stagedMap) {
          const existingMap = this.sharedState.tables.get(tableName);
          stagedMap = new Map(existingMap);
          stagedSharedTables.set(tableName, stagedMap);
        }
        targetMap = stagedMap;
      }

      const existing = targetMap.get(recordId);
      assertCanMutate(table, user, change, existing);

      if (
        change.op === OperationType.Put &&
        (!existing || existing.deleted) &&
        targetMap.size >= maxRecords
      ) {
        throw new TetherServerError(
          TetherServerErrorCode.LimitExceeded,
          `Table record limit reached (${maxRecords} records)`,
        );
      }

      const shouldApply = !existing || shouldOverwrite(change, existing);

      if (shouldApply) {
        this.globalSeq++;
        const assignedSeq = this.globalSeq;

        const { updatedRecord, appliedChange } = applyChangeToRecord(
          change,
          existing,
          assignedSeq,
          user,
        );

        targetMap.set(recordId, updatedRecord);
        stagedApplied.push(appliedChange);
      }
    }

    // Phase 3: Commit staged modifications
    if (userState) {
      for (const [tableName, stagedMap] of stagedUserTables.entries()) {
        userState.tables.set(tableName, stagedMap);
      }
      userState.currentSeq = this.globalSeq;
      if (userState.minSeq === 0 && this.globalSeq > 0) userState.minSeq = 1;
    }

    for (const [tableName, stagedMap] of stagedSharedTables.entries()) {
      this.sharedState.tables.set(tableName, stagedMap);
    }
    this.sharedState.currentSeq = this.globalSeq;
    if (this.sharedState.minSeq === 0 && this.globalSeq > 0) {
      this.sharedState.minSeq = 1;
    }

    for (const applied of stagedApplied) {
      const table = this.tables.get(applied.table);
      if (!table) continue;
      const isPrivate = isPrivateTable(table);
      if (isPrivate && userState) {
        userState.changelog.push(applied);
      } else {
        this.sharedState.changelog.push(applied);
      }
    }

    // Phase 4: Automatic compaction with hysteresis buffer (+50)
    if (userState && userState.changelog.length > defaultMaxHistory + 50) {
      const pruneCount = userState.changelog.length - defaultMaxHistory;
      userState.changelog.splice(0, pruneCount);
      if (userState.changelog.length > 0) {
        userState.minSeq = userState.changelog[0].seq;
      }
    }
    if (this.sharedState.changelog.length > defaultMaxHistory + 50) {
      const pruneCount = this.sharedState.changelog.length - defaultMaxHistory;
      this.sharedState.changelog.splice(0, pruneCount);
      if (this.sharedState.changelog.length > 0) {
        this.sharedState.minSeq = this.sharedState.changelog[0].seq;
      }
    }

    return { applied: stagedApplied, newSeq: this.globalSeq };
  }

  async getChangesSince(
    user: UserStorage | undefined,
    fromSeq: number,
    tableFilters?: string[],
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const currentSeq = this.globalSeq;
    const userState = user ? this.getUserState(user.id) : null;
    const userMinSeq = userState?.minSeq ?? 0;
    const sharedMinSeq = this.sharedState.minSeq;

    const minSeq = Math.max(userMinSeq, sharedMinSeq);
    if (isSnapshotRequired(fromSeq, minSeq, currentSeq)) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const allChanges: (ChangeRecord & { seq: number })[] = [];
    if (userState) {
      allChanges.push(...userState.changelog.filter((c) => c.seq > fromSeq));
    }
    allChanges.push(
      ...this.sharedState.changelog.filter((c) => c.seq > fromSeq),
    );

    allChanges.sort((a, b) => a.seq - b.seq);

    const filtered = allChanges.filter((c) => {
      const table = this.tables.get(c.table);
      if (!table || !canRead(table, user)) return false;
      if (tableFilters && !tableFilters.includes(c.table)) return false;
      return true;
    });

    return { changes: filtered, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(_user?: UserStorage): Promise<number> {
    return this.globalSeq;
  }

  async checkpoint(_tableName?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      'Checkpoint operation is not supported by memory storage',
    );
  }

  async vacuum(): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      'Vacuum operation is not supported by memory storage',
    );
  }

  async prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult> {
    const keep = keepCount ?? this.options.maxHistoryEntries ?? 1000;
    let totalPruned = 0;

    for (const state of this.userStates.values()) {
      if (state.changelog.length > keep) {
        const pruneCount = state.changelog.length - keep;
        state.changelog.splice(0, pruneCount);
        if (state.changelog.length > 0) {
          state.minSeq = state.changelog[0].seq;
        }
        totalPruned += pruneCount;
      }
    }
    if (this.sharedState.changelog.length > keep) {
      const pruneCount = this.sharedState.changelog.length - keep;
      this.sharedState.changelog.splice(0, pruneCount);
      if (this.sharedState.changelog.length > 0) {
        this.sharedState.minSeq = this.sharedState.changelog[0].seq;
      }
      totalPruned += pruneCount;
    }

    return {
      action: 'prune',
      backend: BackendType.Memory,
      tableName,
      affectedCount: totalPruned,
      message: `Prune completed successfully. Removed ${totalPruned} changelog record(s)`,
    };
  }

  async close(): Promise<void> {
    this.tables.clear();
    this.userStates.clear();
    this.sharedState.tables.clear();
    this.sharedState.changelog.length = 0;
    this.users.clear();
    this.usersByUsername.clear();
  }

  getUserState(userId: string): StatePartition {
    const safeUserId = validateUserId(userId);
    let state = this.userStates.get(safeUserId);
    if (!state) {
      state = {
        currentSeq: 0,
        minSeq: 0,
        tables: new Map(),
        changelog: [],
      };
      this.userStates.set(safeUserId, state);
    }
    return state;
  }

  getTableRecordsMap(
    tableName: string,
    userId?: string,
  ): Map<string, StoredRecord> | undefined {
    const table = this.tables.get(tableName);
    if (!table) return undefined;
    const isPrivate = isPrivateTable(table);

    if (isPrivate) {
      if (!userId) return undefined;
      const userState = this.getUserState(userId);
      return userState.tables.get(tableName);
    }
    return this.sharedState.tables.get(tableName);
  }

  getUserData(userId: string): MemoryUserData | undefined {
    return this.users.get(userId);
  }

  deleteTable(name: string): boolean {
    const safeName = validateTableName(name);
    const deleted = this.tables.delete(safeName);
    for (const state of this.userStates.values()) {
      state.tables.delete(safeName);
    }
    this.sharedState.tables.delete(safeName);
    return deleted;
  }

  deleteUser(id: string): boolean {
    const safeUserId = validateUserId(id);
    this.userStates.delete(safeUserId);
    const data = this.users.get(safeUserId);
    if (data) {
      this.usersByUsername.delete(data.username);
      this.users.delete(safeUserId);
      return true;
    }
    return false;
  }
}
