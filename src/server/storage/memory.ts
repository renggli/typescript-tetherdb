import * as crypto from 'node:crypto';
import { shouldOverwrite } from '../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type TableSettings,
} from '../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import { UserResolver } from '../security/resolver.js';
import type {
  InternalChangeRecord,
  InternalStoredRecord,
} from '../security/types.js';
import { hashPassword } from '../shared/crypto.js';
import {
  normalizeUserName,
  validatePassword,
  validateRecordId,
  validateTableName,
  validateUserId,
  validateUserName,
} from '../shared/validate.js';
import {
  type MaintenanceResult,
  Storage,
  type StorageOptions,
  StorageType,
  validateBatchChanges,
} from './storage.js';
import { type ApplyChangesOptions, Table } from './table.js';
import { User } from './user.js';

export interface StatePartition {
  currentSeq: number;
  minSeq: number;
  tables: Map<string, Map<string, InternalStoredRecord>>;
  changelog: InternalChangeRecord[];
}

export interface MemoryUserData {
  userId: string;
  userName: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface MemoryStorageOptions extends StorageOptions {}

/**
 * In-memory storage engine holding active partitions and changelog in volatile memory.
 */
export class MemoryStorage extends Storage {
  readonly type = StorageType.Memory;
  readonly baseDir = undefined;
  readonly secret: string;
  override readonly options: MemoryStorageOptions;
  private globalSeq = 0;
  private tables: Map<string, Table> = new Map();
  private users: Map<string, MemoryUserData> = new Map();
  private usersByUserName: Map<string, string> = new Map();
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
    settings: Partial<TableSettings> = {},
  ): Promise<Table> {
    const safeName = validateTableName(name);
    if (this.tables.has(safeName)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Table already exists',
      );
    }
    const table = new Table(safeName, this, settings);
    this.tables.set(safeName, table);
    return table;
  }

  async getTable(name: string): Promise<Table | undefined> {
    const safeName = validateTableName(name);
    return this.tables.get(safeName);
  }

  async getTables(): Promise<Table[]> {
    return Array.from(this.tables.values());
  }

  async deleteTable(name: string): Promise<boolean> {
    const safeName = validateTableName(name);
    const existed = this.tables.delete(safeName);
    this.sharedState.tables.delete(safeName);
    for (const state of this.userStates.values()) {
      state.tables.delete(safeName);
    }
    return existed;
  }

  async createUser(userName: string, password: string): Promise<User> {
    const safeUserName = validateUserName(userName);
    const validPassword = validatePassword(password);
    if (this.usersByUserName.has(safeUserName)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Username is already registered',
      );
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(validPassword);
    const userData: MemoryUserData = {
      userId,
      userName: safeUserName,
      passwordHash,
      createdAt: Date.now(),
    };

    this.users.set(userId, userData);
    this.usersByUserName.set(safeUserName, userId);
    return new User(userId, safeUserName, userData.createdAt, this);
  }

  async getUser(userId: string): Promise<User | undefined> {
    const safeUserId = validateUserId(userId);
    const data = this.users.get(safeUserId);
    if (data) {
      return new User(data.userId, data.userName, data.createdAt, this);
    }
    return undefined;
  }

  async getUserByUserName(userName: string): Promise<User | undefined> {
    const safeUserName = normalizeUserName(userName);
    if (!safeUserName) return undefined;
    const userId = this.usersByUserName.get(safeUserName);
    if (!userId) return undefined;
    const data = this.users.get(userId);
    if (data) {
      return new User(data.userId, data.userName, data.createdAt, this);
    }
    return undefined;
  }

  async getUsers(): Promise<User[]> {
    return Array.from(this.users.values()).map(
      (data) => new User(data.userId, data.userName, data.createdAt, this),
    );
  }

  async deleteUser(userId: string): Promise<boolean> {
    const safeUserId = validateUserId(userId);
    const data = this.users.get(safeUserId);
    if (!data) return false;
    this.users.delete(safeUserId);
    this.usersByUserName.delete(data.userName);
    this.userStates.delete(safeUserId);
    return true;
  }

  async renameUser(userId: string, newUserName: string): Promise<User> {
    const safeUserId = validateUserId(userId);
    const safeNewName = validateUserName(newUserName);
    const data = this.users.get(safeUserId);
    if (!data) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `User "${safeUserId}" not found`,
      );
    }
    if (
      this.usersByUserName.has(safeNewName) &&
      data.userName !== safeNewName
    ) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Username is already registered',
      );
    }
    this.usersByUserName.delete(data.userName);
    data.userName = safeNewName;
    this.usersByUserName.set(safeNewName, safeUserId);
    return new User(data.userId, data.userName, data.createdAt, this);
  }

  async getUserPasswordHash(
    userId: string,
  ): Promise<string | null | undefined> {
    const safeUserId = validateUserId(userId);
    return this.users.get(safeUserId)?.passwordHash;
  }

  async setUserPasswordHash(userId: string, hash: string): Promise<void> {
    const safeUserId = validateUserId(userId);
    const data = this.users.get(safeUserId);
    if (!data) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'User not found',
      );
    }
    data.passwordHash = hash;
  }

  async getRawRecord(
    tableName: string,
    partition: string,
    id: string,
  ): Promise<InternalStoredRecord | undefined> {
    const state =
      partition === '__shared__'
        ? this.sharedState
        : this.userStates.get(partition);
    const map = state?.tables.get(tableName);
    return map?.get(id);
  }

  async getRawRecords(
    tableName: string,
    partition: string,
  ): Promise<InternalStoredRecord[]> {
    const state =
      partition === '__shared__'
        ? this.sharedState
        : this.userStates.get(partition);
    const map = state?.tables.get(tableName);
    return map ? Array.from(map.values()) : [];
  }

  async getRawChangesSince(
    fromSeq: number,
    user?: User,
  ): Promise<{
    rawChanges: InternalChangeRecord[];
    currentSeq: number;
    minSeq: number;
  }> {
    const currentSeq = this.globalSeq;
    const userState = user ? this.getUserState(user.userId) : null;
    const userMinSeq = userState?.minSeq ?? 0;
    const sharedMinSeq = this.sharedState.minSeq;
    const minSeq = Math.max(userMinSeq, sharedMinSeq);

    const rawChanges: InternalChangeRecord[] = [];
    if (userState) {
      rawChanges.push(...userState.changelog.filter((c) => c.seq > fromSeq));
    }
    rawChanges.push(
      ...this.sharedState.changelog.filter((c) => c.seq > fromSeq),
    );

    rawChanges.sort((a, b) => a.seq - b.seq);
    return { rawChanges, currentSeq, minSeq };
  }

  async applyChanges(
    user: User | undefined,
    changes: ChangeRecord[],
    options?: ApplyChangesOptions,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    if (changes.length === 0) {
      return { applied: [], newSeq: this.globalSeq };
    }

    const defaultMaxRecords = this.options.maxRecords ?? 10000;
    const defaultMaxRecordSize = this.options.maxRecordSizeBytes ?? 1024 * 1024;
    const defaultMaxHistory = this.options.maxHistoryEntries ?? 1000;

    // Phase 1: Validate payload
    await validateBatchChanges(this, changes, defaultMaxRecordSize);

    // Phase 2: Stage mutations
    const stagedUserTables = new Map<
      string,
      Map<string, InternalStoredRecord>
    >();
    const stagedSharedTables = new Map<
      string,
      Map<string, InternalStoredRecord>
    >();
    const stagedApplied: InternalChangeRecord[] = [];

    const userState = user ? this.getUserState(user.userId) : null;

    for (const change of changes) {
      const tableName = validateTableName(change.table);
      const recordId = validateRecordId(change.id);
      const table = this.tables.get(tableName);
      if (!table) continue;

      const maxRecords = table.settings.maxRecords ?? defaultMaxRecords;
      let targetMap: Map<string, InternalStoredRecord>;

      if (table.isPrivate) {
        if (!userState && !options?.skipPermissionCheck) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            `Authentication required for private table "${tableName}"`,
          );
        }
        let stagedMap = stagedUserTables.get(tableName);
        if (!stagedMap) {
          const existingMap = userState
            ? userState.tables.get(tableName)
            : undefined;
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
      if (!options?.skipPermissionCheck) {
        if (change.op === OperationType.Delete) {
          if (!table.canDelete(user, existing)) {
            throw new TetherServerError(
              TetherServerErrorCode.Forbidden,
              `User does not have delete access to record "${change.id}" in table "${tableName}"`,
            );
          }
        } else if (!existing || existing.deleted) {
          if (!table.canCreate(user)) {
            throw new TetherServerError(
              TetherServerErrorCode.Forbidden,
              `User does not have create access to table "${tableName}"`,
            );
          }
        } else if (!table.canUpdate(user, existing)) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            `User does not have update access to record "${change.id}" in table "${tableName}"`,
          );
        }
      }

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
        const isDeleted = change.op === OperationType.Delete;
        const nextVersion = (existing?.version ?? 0) + 1;
        const userId =
          change.op === OperationType.Delete
            ? existing?.userId
            : existing && !existing.deleted
              ? existing.userId
              : user?.userId;

        const updatedRecord: InternalStoredRecord = {
          id: change.id,
          version: nextVersion,
          timestamp: change.timestamp,
          clientId: change.clientId,
          deleted: isDeleted,
          data: isDeleted ? null : (change.data ?? null),
          userId,
        };

        const appliedChange: InternalChangeRecord = {
          seq: assignedSeq,
          table: change.table,
          id: change.id,
          op: change.op,
          version: nextVersion,
          timestamp: change.timestamp,
          clientId: change.clientId,
          data: isDeleted ? undefined : change.data,
          userId,
        };

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
      if (table.isPrivate && userState) {
        userState.changelog.push(applied);
      } else {
        this.sharedState.changelog.push(applied);
      }
    }

    // Phase 4: Compaction
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

    const resolver = new UserResolver(this);
    const publicApplied: ChangeRecord[] = [];
    for (const applied of stagedApplied) {
      const userName = await resolver.resolveUserName(applied.userId, user);
      publicApplied.push({
        table: applied.table,
        id: applied.id,
        op: applied.op,
        data: applied.data,
        version: applied.version,
        seq: applied.seq,
        timestamp: applied.timestamp,
        clientId: applied.clientId,
        userName,
      });
    }

    return { applied: publicApplied, newSeq: this.globalSeq };
  }

  async getCurrentSeq(_user?: User): Promise<number> {
    return this.globalSeq;
  }

  async checkpoint(): Promise<MaintenanceResult> {
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

  async prune(keepCount?: number): Promise<MaintenanceResult> {
    const limit = keepCount ?? this.options.maxHistoryEntries ?? 1000;
    let pruned = 0;

    const pruneLog = (state: StatePartition) => {
      if (state.changelog.length > limit) {
        pruned += state.changelog.length - limit;
        state.changelog = state.changelog.slice(-limit);
        if (state.changelog.length > 0) {
          state.minSeq = state.changelog[0].seq;
        }
      }
    };

    pruneLog(this.sharedState);
    for (const state of this.userStates.values()) {
      pruneLog(state);
    }

    return {
      action: 'prune',
      type: this.type,
      affectedCount: pruned,
      message: `Pruned ${pruned} changelog entries in memory`,
    };
  }

  async close(): Promise<void> {
    this.tables.clear();
    this.users.clear();
    this.usersByUserName.clear();
    this.userStates.clear();
    this.sharedState = {
      currentSeq: 0,
      minSeq: 0,
      tables: new Map(),
      changelog: [],
    };
    this.globalSeq = 0;
  }

  // -- Private Helpers --------------------------------------------------------

  private getUserState(userId: string): StatePartition {
    let state = this.userStates.get(userId);
    if (!state) {
      state = {
        currentSeq: 0,
        minSeq: 0,
        tables: new Map(),
        changelog: [],
      };
      this.userStates.set(userId, state);
    }
    return state;
  }
}
