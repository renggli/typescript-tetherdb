import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
import { AppFileStorage } from './app.js';
import { UserFileStorage } from './user.js';

export interface FileUserData {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface FileStorageOptions {
  baseDir?: string;
  limits?: ServerLimits;
  secret?: string;
}

/**
 * Filesystem-backed implementation of `Storage`.
 */
export class FileStorage implements Storage {
  readonly baseDir: string;
  readonly limits: ServerLimits;
  private explicitSecret?: string;
  private userLocks: Map<string, Promise<unknown>> = new Map();

  constructor(options: FileStorageOptions = {}) {
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.limits = options.limits ?? {};
    this.explicitSecret = options.secret;
  }

  private get usersFile(): string {
    return path.join(this.baseDir, 'users.json');
  }

  private get secretFile(): string {
    return path.join(this.baseDir, 'secret.key');
  }

  async getSecret(): Promise<string> {
    if (this.explicitSecret) return this.explicitSecret;
    try {
      return await fs.readFile(this.secretFile, 'utf-8');
    } catch {
      await fs.mkdir(this.baseDir, { recursive: true });
      const secret = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(this.secretFile, secret, 'utf-8');
      return secret;
    }
  }

  async withUserLock<T>(
    userId: string,
    appId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${appId}:${userId}`;
    const prevLock = this.userLocks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.userLocks.set(
      key,
      prevLock.then(() => currentLock),
    );

    try {
      await prevLock;
      return await fn();
    } finally {
      releaseLock();
      if (this.userLocks.get(key) === currentLock) {
        this.userLocks.delete(key);
      }
    }
  }

  private async readUsersFile(): Promise<Map<string, FileUserData>> {
    try {
      const content = await fs.readFile(this.usersFile, 'utf-8');
      const list = JSON.parse(content) as FileUserData[];
      const map = new Map<string, FileUserData>();
      for (const u of list) {
        map.set(u.id, u);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async writeUsersFile(
    users: Map<string, FileUserData>,
  ): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(
      this.usersFile,
      JSON.stringify(Array.from(users.values()), null, 2),
      'utf-8',
    );
  }

  async findUserDataById(id: string): Promise<FileUserData | undefined> {
    const users = await this.readUsersFile();
    return users.get(id);
  }

  async updateUserData(
    id: string,
    update: Partial<FileUserData>,
  ): Promise<void> {
    const users = await this.readUsersFile();
    const existing = users.get(id);
    if (!existing) throw new Error(`User "${id}" not found.`);
    users.set(id, { ...existing, ...update });
    await this.writeUsersFile(users);
  }

  async createApp(id: string): Promise<AppStorage> {
    const safeId = validateAppId(id);
    const appDir = path.join(this.baseDir, safeId);
    await fs.mkdir(appDir, { recursive: true });

    const tablesFile = path.join(appDir, 'tables.json');
    try {
      await fs.access(tablesFile);
    } catch {
      await fs.writeFile(tablesFile, JSON.stringify([]), 'utf-8');
    }

    return new AppFileStorage(safeId, this);
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    const appDir = path.join(this.baseDir, safeId);
    try {
      const stat = await fs.stat(appDir);
      if (stat.isDirectory()) {
        return new AppFileStorage(safeId, this);
      }
    } catch {
      // Directory doesn't exist
    }
    return undefined;
  }

  async getApps(): Promise<AppStorage[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const apps: AppStorage[] = [];
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          entry.name !== 'auth' &&
          !entry.name.startsWith('.')
        ) {
          apps.push(new AppFileStorage(entry.name, this));
        }
      }
      return apps;
    } catch {
      return [];
    }
  }

  async createUser(username: string, password?: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const users = await this.readUsersFile();

    for (const u of users.values()) {
      if (u.username.toLowerCase() === safeUsername.toLowerCase()) {
        throw new Error(`Username "${safeUsername}" is already registered.`);
      }
    }

    const userId = crypto.randomUUID();
    const passwordHash = password ? await hashPassword(password) : null;
    const userData: FileUserData = {
      id: userId,
      username: safeUsername,
      passwordHash,
      createdAt: Date.now(),
    };

    users.set(userId, userData);
    await this.writeUsersFile(users);
    return new UserFileStorage(userData, this);
  }

  async getUser(id: string): Promise<UserStorage | undefined> {
    const safeUserId = validateUserId(id);
    const data = await this.findUserDataById(safeUserId);
    if (data) {
      return new UserFileStorage(data, this);
    }
    return undefined;
  }

  async getUserByUsername(username: string): Promise<UserStorage | undefined> {
    const safeUsername = validateUsername(username);
    const users = await this.readUsersFile();
    for (const u of users.values()) {
      if (u.username.toLowerCase() === safeUsername.toLowerCase()) {
        return new UserFileStorage(u, this);
      }
    }
    return undefined;
  }

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const secret = await this.getSecret();
    const payload = verifySessionToken(token, secret);
    if (!payload) return undefined;
    return this.getUser(payload.userId);
  }

  async getUsers(): Promise<UserStorage[]> {
    const users = await this.readUsersFile();
    return Array.from(users.values()).map(
      (data) => new UserFileStorage(data, this),
    );
  }

  async deleteUser(id: string): Promise<boolean> {
    const safeUserId = validateUserId(id);
    let deleted = false;

    const apps = await this.getApps();
    for (const app of apps) {
      const userDir = path.join(this.baseDir, app.id, safeUserId);
      try {
        await fs.rm(userDir, { recursive: true, force: true });
        deleted = true;
      } catch {
        // Ignore
      }
    }

    const users = await this.readUsersFile();
    if (users.has(safeUserId)) {
      users.delete(safeUserId);
      await this.writeUsersFile(users);
      deleted = true;
    }

    return deleted;
  }

  async close(): Promise<void> {
    this.userLocks.clear();
  }
}
