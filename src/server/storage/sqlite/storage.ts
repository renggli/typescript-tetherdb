import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
import { AppSqliteStorage } from './app.js';
import { UserSqliteStorage } from './user.js';

export interface SqliteUserData {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface UsersDbHandle {
  db: DatabaseSync;
  stmtFindById: StatementSync;
  stmtFindByUsername: StatementSync;
  stmtInsertUser: StatementSync;
  stmtUpdatePassword: StatementSync;
  stmtDeleteUser: StatementSync;
  stmtListUsers: StatementSync;
}

export interface AppsDbHandle {
  db: DatabaseSync;
  stmtFindApp: StatementSync;
  stmtInsertApp: StatementSync;
  stmtListApps: StatementSync;
  stmtDeleteApp: StatementSync;
  stmtFindTable: StatementSync;
  stmtInsertTable: StatementSync;
  stmtListTables: StatementSync;
  stmtDeleteTable: StatementSync;
  stmtDeleteAppTables: StatementSync;
}

export interface UserAppDbHandle {
  db: DatabaseSync;
  stmtGetRecord: StatementSync;
  stmtGetRecordForUpdate: StatementSync;
  stmtGetSnapshot: StatementSync;
  stmtGetSnapshotByTable: StatementSync;
  stmtInsertRecord: StatementSync;
  stmtUpdateRecord: StatementSync;
  stmtGetMeta: StatementSync;
  stmtSetMeta: StatementSync;
  stmtInsertChangelog: StatementSync;
  stmtGetChangelogSince: StatementSync;
  stmtPruneChangelog: StatementSync;
  stmtCountTableRecords: StatementSync;
  stmtDeleteTableRecords: StatementSync;
  stmtDeleteTableChangelog: StatementSync;
}

export interface SqliteStorageOptions extends StorageOptions {
  baseDir?: string;
  inMemory?: boolean;
}

/**
 * SQLite-backed implementation of `Storage`.
 */
export class SqliteStorage implements Storage {
  readonly baseDir: string;
  readonly inMemory: boolean;
  readonly options: SqliteStorageOptions;
  readonly secret: string;
  private usersHandle: UsersDbHandle | null = null;
  private appsHandle: AppsDbHandle | null = null;
  private userAppDbs: Map<string, UserAppDbHandle> = new Map();

  constructor(options: SqliteStorageOptions = {}) {
    this.options = options;
    this.inMemory = Boolean(
      options.inMemory ||
        options.baseDir === ':memory:' ||
        (!options.baseDir && options.inMemory),
    );
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.secret = options.secret ?? crypto.randomBytes(32).toString('hex');

    if (!this.inMemory) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch {
        // Ignore directory creation error
      }
    }
  }

  getUsersDb(): UsersDbHandle {
    if (this.usersHandle) return this.usersHandle;

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };

    const dbPath = this.inMemory
      ? ':memory:'
      : path.join(this.baseDir, 'users.sqlite');

    const db = new DatabaseSync(dbPath);

    if (!this.inMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
    `);

    this.usersHandle = {
      db,
      stmtFindById: db.prepare(
        'SELECT id, username, password_hash, created_at FROM users WHERE id = ?',
      ),
      stmtFindByUsername: db.prepare(
        'SELECT id, username, password_hash, created_at FROM users WHERE username = ?',
      ),
      stmtInsertUser: db.prepare(
        'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
      ),
      stmtUpdatePassword: db.prepare(
        'UPDATE users SET password_hash = ? WHERE id = ?',
      ),
      stmtDeleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
      stmtListUsers: db.prepare(
        'SELECT id, username, password_hash, created_at FROM users ORDER BY created_at ASC',
      ),
    };

    return this.usersHandle;
  }

  getAppsDb(): AppsDbHandle {
    if (this.appsHandle) return this.appsHandle;

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };

    const dbPath = this.inMemory
      ? ':memory:'
      : path.join(this.baseDir, 'apps.sqlite');

    const db = new DatabaseSync(dbPath);

    if (!this.inMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tables (
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (app_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_tables_app ON tables (app_id);
    `);

    this.appsHandle = {
      db,
      stmtFindApp: db.prepare('SELECT id, created_at FROM apps WHERE id = ?'),
      stmtInsertApp: db.prepare(
        'INSERT INTO apps (id, created_at) VALUES (?, ?)',
      ),
      stmtListApps: db.prepare('SELECT id FROM apps ORDER BY id ASC'),
      stmtDeleteApp: db.prepare('DELETE FROM apps WHERE id = ?'),
      stmtFindTable: db.prepare(
        'SELECT name, created_at FROM tables WHERE app_id = ? AND name = ?',
      ),
      stmtInsertTable: db.prepare(
        'INSERT INTO tables (app_id, name, created_at) VALUES (?, ?, ?)',
      ),
      stmtListTables: db.prepare(
        'SELECT name FROM tables WHERE app_id = ? ORDER BY name ASC',
      ),
      stmtDeleteTable: db.prepare(
        'DELETE FROM tables WHERE app_id = ? AND name = ?',
      ),
      stmtDeleteAppTables: db.prepare('DELETE FROM tables WHERE app_id = ?'),
    };

    return this.appsHandle;
  }

  getUserAppDb(appId: string, userId: string): UserAppDbHandle {
    const safeAppId = validateAppId(appId);
    const safeUserId = validateUserId(userId);
    const cacheKey = `${safeAppId}:${safeUserId}`;

    let handle = this.userAppDbs.get(cacheKey);
    if (!handle) {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => DatabaseSync;
      };

      let dbPath: string;
      if (this.inMemory) {
        dbPath = ':memory:';
      } else {
        const bucket = getUserBucket(safeUserId);
        const userDir = path.join(this.baseDir, safeAppId, bucket);
        try {
          fs.mkdirSync(userDir, { recursive: true });
        } catch {
          // Ignore
        }
        dbPath = path.join(userDir, `${safeUserId}.sqlite`);
      }

      const db = new DatabaseSync(dbPath);

      if (!this.inMemory) {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          table_name TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT NOT NULL,
          deleted INTEGER NOT NULL,
          data TEXT,
          PRIMARY KEY (table_name, id)
        );

        CREATE INDEX IF NOT EXISTS idx_records_lookup
          ON records (table_name, deleted);

        CREATE TABLE IF NOT EXISTS changelog (
          seq INTEGER PRIMARY KEY,
          table_name TEXT NOT NULL,
          id TEXT NOT NULL,
          op TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT NOT NULL,
          deleted INTEGER NOT NULL,
          data TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_changelog_sync
          ON changelog (seq);

        CREATE TABLE IF NOT EXISTS user_meta (
          current_seq INTEGER NOT NULL,
          min_seq INTEGER NOT NULL
        );
      `);

      handle = {
        db,
        stmtGetRecord: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE table_name = ? AND id = ? AND deleted = 0',
        ),
        stmtGetRecordForUpdate: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE table_name = ? AND id = ?',
        ),
        stmtGetSnapshot: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE deleted = 0',
        ),
        stmtGetSnapshotByTable: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE table_name = ? AND deleted = 0',
        ),
        stmtInsertRecord: db.prepare(
          'INSERT INTO records (table_name, id, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ),
        stmtUpdateRecord: db.prepare(
          'UPDATE records SET version = ?, timestamp = ?, client_id = ?, deleted = ?, data = ? WHERE table_name = ? AND id = ?',
        ),
        stmtGetMeta: db.prepare(
          'SELECT current_seq, min_seq FROM user_meta LIMIT 1',
        ),
        stmtSetMeta: db.prepare(
          'INSERT OR REPLACE INTO user_meta (rowid, current_seq, min_seq) VALUES (1, ?, ?)',
        ),
        stmtInsertChangelog: db.prepare(
          'INSERT INTO changelog (seq, table_name, id, op, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        stmtGetChangelogSince: db.prepare(
          'SELECT seq, table_name, id, op, version, timestamp, client_id, deleted, data FROM changelog WHERE seq > ? ORDER BY seq ASC',
        ),
        stmtPruneChangelog: db.prepare('DELETE FROM changelog WHERE seq < ?'),
        stmtCountTableRecords: db.prepare(
          'SELECT COUNT(*) as count FROM records WHERE table_name = ? AND deleted = 0',
        ),
        stmtDeleteTableRecords: db.prepare(
          'DELETE FROM records WHERE table_name = ?',
        ),
        stmtDeleteTableChangelog: db.prepare(
          'DELETE FROM changelog WHERE table_name = ?',
        ),
      };

      this.userAppDbs.set(cacheKey, handle);
    }

    return handle;
  }

  findUserDataById(id: string): SqliteUserData | undefined {
    const usersDb = this.getUsersDb();
    const row = usersDb.stmtFindById.get(id) as
      | {
          id: string;
          username: string;
          password_hash: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  updateUserData(id: string, passwordHash: string): void {
    const usersDb = this.getUsersDb();
    usersDb.stmtUpdatePassword.run(passwordHash, id);
  }

  async createApp(id: string): Promise<AppStorage> {
    const safeId = validateAppId(id);
    const appsDb = this.getAppsDb();
    const existing = appsDb.stmtFindApp.get(safeId);
    if (existing) {
      throw new Error(`Application "${safeId}" already exists.`);
    }

    appsDb.stmtInsertApp.run(safeId, Date.now());

    if (!this.inMemory) {
      const appDir = path.join(this.baseDir, safeId);
      try {
        fs.mkdirSync(appDir, { recursive: true });
      } catch {
        // Ignore
      }
    }

    return new AppSqliteStorage(safeId, this);
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    const appsDb = this.getAppsDb();
    const existing = appsDb.stmtFindApp.get(safeId);
    if (existing) {
      return new AppSqliteStorage(safeId, this);
    }
    return undefined;
  }

  async getApps(): Promise<AppStorage[]> {
    const appsDb = this.getAppsDb();
    const rows = appsDb.stmtListApps.all() as Array<{ id: string }>;
    return rows.map((r) => new AppSqliteStorage(r.id, this));
  }

  async createUser(username: string, password: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const validPassword = validatePassword(password);
    const usersDb = this.getUsersDb();

    const existing = usersDb.stmtFindByUsername.get(safeUsername);
    if (existing) {
      throw new Error(`Username "${safeUsername}" is already registered.`);
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(validPassword);
    const createdAt = Date.now();

    usersDb.stmtInsertUser.run(userId, safeUsername, passwordHash, createdAt);
    const userData: SqliteUserData = {
      id: userId,
      username: safeUsername,
      passwordHash,
      createdAt,
    };

    return new UserSqliteStorage(userData, this);
  }

  async getUser(id: string): Promise<UserStorage | undefined> {
    const safeUserId = validateUserId(id);
    const data = this.findUserDataById(safeUserId);
    if (data) {
      return new UserSqliteStorage(data, this);
    }
    return undefined;
  }

  async getUserByUsername(username: string): Promise<UserStorage | undefined> {
    const safeUsername = normalizeUsername(username);
    if (!safeUsername) return undefined;
    const usersDb = this.getUsersDb();
    const row = usersDb.stmtFindByUsername.get(safeUsername) as
      | {
          id: string;
          username: string;
          password_hash: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    const data: SqliteUserData = {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
    return new UserSqliteStorage(data, this);
  }

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const payload = verifySessionToken(token, this.secret);
    if (!payload) return undefined;
    return this.getUser(payload.userId);
  }

  async getUsers(): Promise<UserStorage[]> {
    const usersDb = this.getUsersDb();
    const rows = usersDb.stmtListUsers.all() as Array<{
      id: string;
      username: string;
      password_hash: string | null;
      created_at: number;
    }>;

    return rows.map(
      (r) =>
        new UserSqliteStorage(
          {
            id: r.id,
            username: r.username,
            passwordHash: r.password_hash,
            createdAt: r.created_at,
          },
          this,
        ),
    );
  }

  deleteUser(id: string): boolean {
    const safeUserId = validateUserId(id);
    let deleted = false;

    // Close and remove in-memory handles for this user
    for (const [key, handle] of Array.from(this.userAppDbs.entries())) {
      if (key.endsWith(`:${safeUserId}`)) {
        try {
          handle.db.close();
        } catch {
          // Ignore
        }
        this.userAppDbs.delete(key);
      }
    }

    // Delete user database files across all app directories
    if (!this.inMemory) {
      const bucket = getUserBucket(safeUserId);
      const apps = this.getAppsDb().stmtListApps.all() as Array<{ id: string }>;
      for (const app of apps) {
        const userDbFile = path.join(
          this.baseDir,
          app.id,
          bucket,
          `${safeUserId}.sqlite`,
        );
        const walFile = `${userDbFile}-wal`;
        const shmFile = `${userDbFile}-shm`;
        try {
          fs.unlinkSync(userDbFile);
          deleted = true;
        } catch {
          // Ignore
        }
        try {
          fs.unlinkSync(walFile);
        } catch {
          // Ignore
        }
        try {
          fs.unlinkSync(shmFile);
        } catch {
          // Ignore
        }
      }
    }

    const usersDb = this.getUsersDb();
    const res = usersDb.stmtDeleteUser.run(safeUserId) as { changes: number };
    if (res.changes > 0) deleted = true;

    return deleted;
  }

  deleteApp(id: string): boolean {
    const safeId = validateAppId(id);
    let deleted = false;

    // Close and remove in-memory user-app handles
    for (const [key, handle] of Array.from(this.userAppDbs.entries())) {
      if (key.startsWith(`${safeId}:`)) {
        try {
          handle.db.close();
        } catch {
          // Ignore
        }
        this.userAppDbs.delete(key);
      }
    }

    const appsDb = this.getAppsDb();
    appsDb.stmtDeleteAppTables.run(safeId);
    const res = appsDb.stmtDeleteApp.run(safeId) as { changes: number };
    if (res.changes > 0) deleted = true;

    if (!this.inMemory) {
      const appDir = path.join(this.baseDir, safeId);
      try {
        fs.rmSync(appDir, { recursive: true, force: true });
        deleted = true;
      } catch {
        // Ignore
      }
    }

    return deleted;
  }

  deleteTable(appId: string, tableName: string): boolean {
    const safeAppId = validateAppId(appId);
    const appsDb = this.getAppsDb();
    const res = appsDb.stmtDeleteTable.run(safeAppId, tableName) as {
      changes: number;
    };
    if (res.changes === 0) return false;

    // Clean up table data in any cached active handles for this app
    for (const [key, handle] of this.userAppDbs.entries()) {
      if (key.startsWith(`${safeAppId}:`)) {
        try {
          handle.stmtDeleteTableRecords.run(tableName);
          handle.stmtDeleteTableChangelog.run(tableName);
        } catch {
          // Ignore
        }
      }
    }

    return true;
  }

  async close(): Promise<void> {
    if (this.usersHandle) {
      try {
        this.usersHandle.db.close();
      } catch {
        // Ignore
      }
      this.usersHandle = null;
    }
    if (this.appsHandle) {
      try {
        this.appsHandle.db.close();
      } catch {
        // Ignore
      }
      this.appsHandle = null;
    }
    for (const handle of this.userAppDbs.values()) {
      try {
        handle.db.close();
      } catch {
        // Ignore
      }
    }
    this.userAppDbs.clear();
  }
}
