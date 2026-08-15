import * as crypto from 'node:crypto';
import {
  validateAppId,
  validateUserId,
  validateUsername,
} from '../../../shared/sanitize.js';
import type { ServerLimits } from '../../../shared/types.js';
import { hashPassword, verifySessionToken } from '../../crypto.js';
import type { AppStorage } from '../app.js';
import type { Storage } from '../storage.js';
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

export interface MemoryStorageOptions {
  limits?: ServerLimits;
  secret?: string;
}

/**
 * In-memory implementation of `Storage`.
 */
export class MemoryStorage implements Storage {
  private apps: Map<string, AppMemoryStorage> = new Map();
  private userStates: Map<string, UserState> = new Map(); // key = `${appId}:${userId}`
  readonly rawUsers: Map<string, MemoryUserData> = new Map(); // key = userId
  private usersByUsername: Map<string, string> = new Map(); // username -> userId
  readonly secret: string;
  readonly limits: ServerLimits;

  constructor(options: MemoryStorageOptions = {}) {
    this.limits = options.limits ?? {};
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
    let app = this.apps.get(safeId);
    if (!app) {
      app = new AppMemoryStorage(safeId, this);
      this.apps.set(safeId, app);
    }
    return app;
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    return this.apps.get(safeId);
  }

  async getApps(): Promise<AppStorage[]> {
    return Array.from(this.apps.values());
  }

  async createUser(username: string, password?: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    if (this.usersByUsername.has(safeUsername)) {
      throw new Error(`Username "${safeUsername}" is already registered.`);
    }

    const userId = crypto.randomUUID();
    const passwordHash = password ? await hashPassword(password) : null;
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
    const safeUsername = validateUsername(username);
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

  async close(): Promise<void> {
    this.apps.clear();
    this.userStates.clear();
    this.rawUsers.clear();
    this.usersByUsername.clear();
  }
}
