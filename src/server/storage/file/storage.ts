import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashPassword, verifySessionToken } from '../../crypto.js';
import {
  getUserBucket,
  normalizeUsername,
  validateAppId,
  validatePassword,
  validateUserId,
  validateUsername,
} from '../../validate.js';
import type { AppStorage } from '../app.js';
import type { Storage, StorageOptions } from '../storage.js';
import type { UserStorage } from '../user.js';
import { AppFileStorage } from './app.js';
import { UserFileStorage } from './user.js';

export interface FileUserData {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface FileAppData {
  id: string;
  createdAt: number;
}

export interface FileStorageOptions extends StorageOptions {
  baseDir?: string;
}

/**
 * Filesystem-backed implementation of `Storage`.
 */
export class FileStorage implements Storage {
  readonly baseDir: string;
  readonly options: FileStorageOptions;
  readonly secret: string;
  private userLocks: Map<string, Promise<unknown>> = new Map();

  constructor(options: FileStorageOptions = {}) {
    this.options = options;
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.secret = options.secret ?? crypto.randomBytes(32).toString('hex');
  }

  private get usersFile(): string {
    return path.join(this.baseDir, 'users.json');
  }

  private get appsFile(): string {
    return path.join(this.baseDir, 'apps.json');
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

  private async readAppsFile(): Promise<Map<string, FileAppData>> {
    try {
      const content = await fs.readFile(this.appsFile, 'utf-8');
      const list = JSON.parse(content) as FileAppData[];
      const map = new Map<string, FileAppData>();
      for (const a of list) {
        map.set(a.id, a);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async writeAppsFile(apps: Map<string, FileAppData>): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(
      this.appsFile,
      JSON.stringify(Array.from(apps.values()), null, 2),
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
    const apps = await this.readAppsFile();
    if (apps.has(safeId)) {
      throw new Error(`Application "${safeId}" already exists.`);
    }

    const appDir = path.join(this.baseDir, safeId);
    await fs.mkdir(appDir, { recursive: true });

    const now = Date.now();
    apps.set(safeId, { id: safeId, createdAt: now });
    await this.writeAppsFile(apps);

    const manifestFile = path.join(appDir, 'manifest.json');
    await fs.writeFile(
      manifestFile,
      JSON.stringify(
        {
          id: safeId,
          tables: [],
          createdAt: now,
          version: 1,
        },
        null,
        2,
      ),
      'utf-8',
    );

    return new AppFileStorage(safeId, this);
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    const apps = await this.readAppsFile();
    if (apps.has(safeId)) {
      return new AppFileStorage(safeId, this);
    }
    // Fallback: check if manifest.json exists on disk
    const manifestFile = path.join(this.baseDir, safeId, 'manifest.json');
    try {
      await fs.stat(manifestFile);
      apps.set(safeId, { id: safeId, createdAt: Date.now() });
      await this.writeAppsFile(apps);
      return new AppFileStorage(safeId, this);
    } catch {
      return undefined;
    }
  }

  async getApps(): Promise<AppStorage[]> {
    const apps = await this.readAppsFile();
    return Array.from(apps.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => new AppFileStorage(a.id, this));
  }

  async createUser(username: string, password: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const validPassword = validatePassword(password);
    const users = await this.readUsersFile();

    for (const u of users.values()) {
      if (u.username.toLowerCase() === safeUsername.toLowerCase()) {
        throw new Error(`Username "${safeUsername}" is already registered.`);
      }
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(validPassword);
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
    const safeUsername = normalizeUsername(username);
    if (!safeUsername) return undefined;
    const users = await this.readUsersFile();
    for (const u of users.values()) {
      if (u.username.toLowerCase() === safeUsername) {
        return new UserFileStorage(u, this);
      }
    }
    return undefined;
  }

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const payload = verifySessionToken(token, this.secret);
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
    const bucket = getUserBucket(safeUserId);
    for (const app of apps) {
      const userDir = path.join(
        this.baseDir,
        app.id,
        'users',
        bucket,
        safeUserId,
      );
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

  async deleteApp(id: string): Promise<boolean> {
    const safeId = validateAppId(id);
    const apps = await this.readAppsFile();
    let deleted = false;

    if (apps.has(safeId)) {
      apps.delete(safeId);
      await this.writeAppsFile(apps);
      deleted = true;
    }

    const appDir = path.join(this.baseDir, safeId);
    try {
      await fs.rm(appDir, { recursive: true, force: true });
      deleted = true;
    } catch {
      // Ignore
    }

    return deleted;
  }

  async close(): Promise<void> {
    this.userLocks.clear();
  }
}
