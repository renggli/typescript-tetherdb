import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getOrCreateKeyfileSecret,
  hashPassword,
  verifySessionToken,
} from '../../crypto.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import { readServerLock } from '../../lock.js';
import {
  getUserBucket,
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
 * Validates that no external TetherDB server process is actively running on this data directory.
 *
 * @param baseDir - Storage base directory.
 * @throws TetherServerError if an active server lock is held by another process.
 */
export function assertNoActiveServerLock(baseDir: string): void {
  const lock = readServerLock(baseDir);
  if (lock && lock.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Cannot modify file storage directly while server is running (PID ${lock.pid})`,
    );
  }
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
    this.secret = options.secret ?? getOrCreateKeyfileSecret(this.baseDir);
  }

  private get usersFile(): string {
    return path.join(this.baseDir, 'users.json');
  }

  private get appsFile(): string {
    return path.join(this.baseDir, 'apps.json');
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

  async withUserLock<T>(
    userId: string,
    appId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(`${appId}:${userId}`, fn);
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
    await writeFileAtomic(
      this.usersFile,
      JSON.stringify(Array.from(users.values()), null, 2),
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
    await writeFileAtomic(
      this.appsFile,
      JSON.stringify(Array.from(apps.values()), null, 2),
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
    assertNoActiveServerLock(this.baseDir);
    return this.withLock('__users__', async () => {
      const users = await this.readUsersFile();
      const existing = users.get(id);
      if (!existing) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          'User not found',
        );
      }
      users.set(id, { ...existing, ...update });
      await this.writeUsersFile(users);
    });
  }

  async createApp(id: string): Promise<AppStorage> {
    assertNoActiveServerLock(this.baseDir);
    const safeId = validateAppId(id);
    return this.withLock('__apps__', async () => {
      const apps = await this.readAppsFile();
      if (apps.has(safeId)) {
        throw new TetherServerError(
          TetherServerErrorCode.AlreadyExists,
          'Application already exists',
        );
      }

      const appDir = path.join(this.baseDir, safeId);
      await fs.mkdir(appDir, { recursive: true });

      const now = Date.now();
      apps.set(safeId, { id: safeId, createdAt: now });
      await this.writeAppsFile(apps);

      const manifestFile = path.join(appDir, 'manifest.json');
      await writeFileAtomic(
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
      );

      return new AppFileStorage(safeId, this);
    });
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
    assertNoActiveServerLock(this.baseDir);
    const safeUsername = validateUsername(username);
    const validPassword = validatePassword(password);
    const passwordHash = await hashPassword(validPassword);

    return this.withLock('__users__', async () => {
      const users = await this.readUsersFile();

      for (const u of users.values()) {
        if (u.username.toLowerCase() === safeUsername.toLowerCase()) {
          throw new TetherServerError(
            TetherServerErrorCode.AlreadyExists,
            'Username is already registered',
          );
        }
      }

      const userId = crypto.randomUUID();
      const userData: FileUserData = {
        id: userId,
        username: safeUsername,
        passwordHash,
        createdAt: Date.now(),
      };

      users.set(userId, userData);
      await this.writeUsersFile(users);
      return new UserFileStorage(userData, this);
    });
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
    assertNoActiveServerLock(this.baseDir);
    const safeUserId = validateUserId(id);
    return this.withLock('__users__', async () => {
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
    });
  }

  async deleteApp(id: string): Promise<boolean> {
    assertNoActiveServerLock(this.baseDir);
    const safeId = validateAppId(id);
    return this.withLock('__apps__', async () => {
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
    });
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
      backend: 'file',
      baseDir: this.baseDir,
      usersCount: users.length,
      appsCount: allApps.length,
      apps: appSummaries,
    };
  }

  async checkpoint(appId?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Checkpoint operation is not supported by file storage${appId ? ` (app: ${appId})` : ''}`,
    );
  }

  async vacuum(appId?: string): Promise<MaintenanceResult> {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Vacuum operation is not supported by file storage${appId ? ` (app: ${appId})` : ''}`,
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

    const users = await this.getUsers();
    let totalPruned = 0;

    for (const app of targetApps) {
      for (const user of users) {
        await this.withUserLock(user.id, app.id, async () => {
          const userDir = path.join(
            this.baseDir,
            app.id,
            'users',
            getUserBucket(user.id),
            user.id,
          );
          const syncFile = path.join(userDir, 'sync.jsonl');
          const metaFile = path.join(userDir, 'meta.json');

          try {
            const content = await fs.readFile(syncFile, 'utf-8');
            const lines = content
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            if (lines.length > keep) {
              const pruneCount = lines.length - keep;
              const keptLines = lines.slice(pruneCount);
              const firstKept = JSON.parse(keptLines[0]) as { seq: number };
              await writeFileAtomic(syncFile, `${keptLines.join('\n')}\n`);
              try {
                const metaContent = await fs.readFile(metaFile, 'utf-8');
                const meta = JSON.parse(metaContent) as {
                  currentSeq: number;
                  minSeq: number;
                };
                meta.minSeq = firstKept.seq;
                await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
              } catch {
                // Ignore meta read failure
              }
              totalPruned += pruneCount;
            }
          } catch {
            // User sync file doesn't exist or is empty
          }
        });
      }
    }

    return {
      action: 'prune',
      backend: 'file',
      appId,
      affectedCount: totalPruned,
      message: `Prune completed successfully. Removed ${totalPruned} changelog record(s)`,
    };
  }

  async close(): Promise<void> {
    this.userLocks.clear();
  }
}

// -- Private Helpers --------------------------------------------------------

/**
 * Writes data atomically to a file using a unique temp file and atomic rename.
 *
 * @param filePath - The destination file path.
 * @param content - File content to write.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, filePath);
}
