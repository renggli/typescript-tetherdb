import * as crypto from 'node:crypto';
import { hashPassword, verifySessionToken } from '../../crypto.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import {
  normalizeUsername,
  validateAppId,
  validatePassword,
  validateUserId,
  validateUsername,
} from '../../validate.js';
import type { AppStorage } from '../app.js';
import type {
  MaintenanceResult,
  Storage,
  StorageOptions,
  StorageStatus,
} from '../storage.js';
import type { UserStorage } from '../user.js';
import { AppMemoryStorage } from './app.js';
import { type MemoryUserData, UserMemoryStorage } from './user.js';

export interface UserState {
  currentSeq: number;
  minSeq: number;
  tables: Map<
    string,
    Map<string, import('../../../shared/types.js').StoredRecord>
  >;
  changelog: Array<
    import('../../../shared/types.js').ChangeRecord & { seq: number }
  >;
}

export interface MemoryStorageOptions extends StorageOptions {}

/**
 * In-memory implementation of `Storage`.
 */
export class MemoryStorage implements Storage {
  private apps: Map<string, AppMemoryStorage> = new Map();
  private userStates: Map<string, UserState> = new Map(); // key = `${appId}:${userId}`
  readonly rawUsers: Map<string, MemoryUserData> = new Map(); // key = userId
  private usersByUsername: Map<string, string> = new Map(); // username -> userId
  readonly secret: string;
  readonly options: MemoryStorageOptions;

  constructor(options: MemoryStorageOptions = {}) {
    this.options = options;
    this.secret = options.secret ?? crypto.randomBytes(32).toString('hex');
  }

  getUserState(userId: string, appId: string): UserState {
    const safeAppId = validateAppId(appId);
    const safeUserId = validateUserId(userId);
    const key = `${safeAppId}:${safeUserId}`;
    let state = this.userStates.get(key);
    if (!state) {
      state = {
        currentSeq: 0,
        minSeq: 0,
        tables: new Map(),
        changelog: [],
      };
      this.userStates.set(key, state);
    }
    return state;
  }

  deleteUserState(userId: string): boolean {
    const safeUserId = validateUserId(userId);
    let deleted = false;
    for (const key of Array.from(this.userStates.keys())) {
      if (key.endsWith(`:${safeUserId}`)) {
        this.userStates.delete(key);
        deleted = true;
      }
    }
    return deleted;
  }

  deleteAppUserStates(appId: string): void {
    const safeAppId = validateAppId(appId);
    for (const key of Array.from(this.userStates.keys())) {
      if (key.startsWith(`${safeAppId}:`)) {
        this.userStates.delete(key);
      }
    }
  }

  deleteTableInUserStates(appId: string, tableName: string): void {
    const safeAppId = validateAppId(appId);
    for (const [key, state] of this.userStates.entries()) {
      if (key.startsWith(`${safeAppId}:`)) {
        state.tables.delete(tableName);
      }
    }
  }

  async createApp(id: string): Promise<AppStorage> {
    const safeId = validateAppId(id);
    if (this.apps.has(safeId)) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Application already exists',
      );
    }
    const app = new AppMemoryStorage(safeId, this);
    this.apps.set(safeId, app);
    return app;
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    return this.apps.get(safeId);
  }

  async getApps(): Promise<AppStorage[]> {
    return Array.from(this.apps.values());
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

    this.rawUsers.set(userId, userData);
    this.usersByUsername.set(safeUsername, userId);
    return new UserMemoryStorage(userData, this);
  }

  async getUser(id: string): Promise<UserStorage | undefined> {
    const safeUserId = validateUserId(id);
    const data = this.rawUsers.get(safeUserId);
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
    const data = this.rawUsers.get(userId);
    if (data) {
      return new UserMemoryStorage(data, this);
    }
    return undefined;
  }

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const payload = verifySessionToken(token, this.secret);
    if (!payload) return undefined;
    return this.getUser(payload.userId);
  }

  async getUsers(): Promise<UserStorage[]> {
    return Array.from(this.rawUsers.values()).map(
      (data) => new UserMemoryStorage(data, this),
    );
  }

  deleteUser(id: string): boolean {
    const safeUserId = validateUserId(id);
    this.deleteUserState(safeUserId);
    const data = this.rawUsers.get(safeUserId);
    if (data) {
      this.usersByUsername.delete(data.username);
      this.rawUsers.delete(safeUserId);
      return true;
    }
    return false;
  }

  deleteApp(id: string): boolean {
    const safeId = validateAppId(id);
    this.deleteAppUserStates(safeId);
    return this.apps.delete(safeId);
  }

  async getStatus(appId?: string): Promise<StorageStatus> {
    const users = await this.getUsers();
    const allApps = await this.getApps();
    const targetApps = appId
      ? allApps.filter((a) => a.id === validateAppId(appId))
      : allApps;

    if (appId && targetApps.length === 0) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Application "${appId}" not found`,
      );
    }

    const appSummaries: Array<{ id: string; tables: string[] }> = [];
    for (const app of targetApps) {
      const tables = await app.getTables();
      appSummaries.push({
        id: app.id,
        tables: tables.map((t) => t.name),
      });
    }

    return {
      backend: 'memory',
      usersCount: users.length,
      appsCount: allApps.length,
      apps: appSummaries,
    };
  }

  async checkpoint(appId?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Checkpoint operation is not supported by memory storage${appId ? ` (app: ${appId})` : ''}`,
    );
  }

  async vacuum(appId?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Vacuum operation is not supported by memory storage${appId ? ` (app: ${appId})` : ''}`,
    );
  }

  async prune(appId?: string, keepCount?: number): Promise<MaintenanceResult> {
    const keep = keepCount ?? this.options.maxChangelogEntries ?? 1000;
    const allApps = await this.getApps();
    const targetApps = appId
      ? allApps.filter((a) => a.id === validateAppId(appId))
      : allApps;

    if (appId && targetApps.length === 0) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Application "${appId}" not found`,
      );
    }

    let totalPruned = 0;
    for (const app of targetApps) {
      for (const [key, state] of this.userStates.entries()) {
        if (key.startsWith(`${app.id}:`)) {
          if (state.changelog.length > keep) {
            const pruneCount = state.changelog.length - keep;
            state.changelog.splice(0, pruneCount);
            if (state.changelog.length > 0) {
              state.minSeq = state.changelog[0].seq;
            }
            totalPruned += pruneCount;
          }
        }
      }
    }

    return {
      action: 'prune',
      backend: 'memory',
      appId,
      affectedCount: totalPruned,
      message: `Prune completed successfully. Removed ${totalPruned} changelog record(s)`,
    };
  }

  async close(): Promise<void> {
    this.apps.clear();
    this.userStates.clear();
    this.rawUsers.clear();
    this.usersByUsername.clear();
  }
}
