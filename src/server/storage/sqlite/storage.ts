import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
import { AppSqliteStorage } from './app.js';
import { UserSqliteStorage } from './user.js';

export interface SqliteUserData {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface AppDbHandle {
  db: DatabaseSync;
  stmtCheckTable: StatementSync;
  stmtInsertTable: StatementSync;
  stmtListTables: StatementSync;
  stmtDeleteTable: StatementSync;
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
  stmtCheckUser: StatementSync;
  stmtListUsers: StatementSync;
}

interface AuthDbHandle {
  db: DatabaseSync;
  stmtFindById: StatementSync;
  stmtFindByUsername: StatementSync;
  stmtInsertUser: StatementSync;
  stmtUpdatePassword: StatementSync;
  stmtDeleteUser: StatementSync;
  stmtListUsers: StatementSync;
}

export interface SqliteStorageOptions {
  baseDir?: string;
  inMemory?: boolean;
  limits?: ServerLimits;
  secret?: string;
}

/**
 * SQLite-backed implementation of `Storage`.
 */
export class SqliteStorage implements Storage {
  readonly baseDir: string;
  readonly inMemory: boolean;
  readonly limits: ServerLimits;
  readonly secret: string;
  private appDbs: Map<string, AppDbHandle> = new Map();
  private authHandle: AuthDbHandle | null = null;

  constructor(options: SqliteStorageOptions = {}) {
    this.inMemory = Boolean(
      options.inMemory ||
        options.baseDir === ':memory:' ||
        (!options.baseDir && options.inMemory),
    );
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.limits = options.limits ?? {};
    this.secret = options.secret ?? crypto.randomBytes(32).toString('hex');

    if (!this.inMemory) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch {
        // Ignore directory creation error
      }
    }
  }

  private getAuthDb(): AuthDbHandle {
    if (this.authHandle) return this.authHandle;

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };

    const dbPath = this.inMemory
      ? ':memory:'
      : path.join(this.baseDir, 'auth.sqlite');

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

    this.authHandle = {
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

    return this.authHandle;
  }

  getAppDb(appId: string): { handle: AppDbHandle; safeAppId: string } {
    const safeAppId = validateAppId(appId);
    let handle = this.appDbs.get(safeAppId);

    if (!handle) {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => DatabaseSync;
      };

      const dbPath = this.inMemory
        ? ':memory:'
        : path.join(this.baseDir, `${safeAppId}.sqlite`);

      const db = new DatabaseSync(dbPath);

      if (!this.inMemory) {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
      }
      db.exec('PRAGMA foreign_keys = ON;');

      db.exec(`
        CREATE TABLE IF NOT EXISTS tables (
          name TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS records (
          user_id TEXT NOT NULL,
          table_name TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT NOT NULL,
          deleted INTEGER NOT NULL,
          data TEXT,
          PRIMARY KEY (user_id, table_name, id)
        );

        CREATE INDEX IF NOT EXISTS idx_records_lookup
          ON records (user_id, table_name, deleted);

        CREATE TABLE IF NOT EXISTS changelog (
          user_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          table_name TEXT NOT NULL,
          id TEXT NOT NULL,
          op TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT NOT NULL,
          deleted INTEGER NOT NULL,
          data TEXT,
          PRIMARY KEY (user_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_changelog_sync
          ON changelog (user_id, seq);

        CREATE TABLE IF NOT EXISTS user_meta (
          user_id TEXT PRIMARY KEY,
          current_seq INTEGER NOT NULL,
          min_seq INTEGER NOT NULL
        );
      `);

      handle = {
        db,
        stmtCheckTable: db.prepare('SELECT 1 FROM tables WHERE name = ?'),
        stmtInsertTable: db.prepare(
          'INSERT OR IGNORE INTO tables (name, created_at) VALUES (?, ?)',
        ),
        stmtListTables: db.prepare('SELECT name FROM tables ORDER BY name ASC'),
        stmtDeleteTable: db.prepare('DELETE FROM tables WHERE name = ?'),
        stmtGetRecord: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND table_name = ? AND id = ? AND deleted = 0',
        ),
        stmtGetRecordForUpdate: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND table_name = ? AND id = ?',
        ),
        stmtGetSnapshot: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND deleted = 0',
        ),
        stmtGetSnapshotByTable: db.prepare(
          'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND table_name = ? AND deleted = 0',
        ),
        stmtInsertRecord: db.prepare(
          'INSERT INTO records (user_id, table_name, id, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        stmtUpdateRecord: db.prepare(
          'UPDATE records SET version = ?, timestamp = ?, client_id = ?, deleted = ?, data = ? WHERE user_id = ? AND table_name = ? AND id = ?',
        ),
        stmtGetMeta: db.prepare(
          'SELECT current_seq, min_seq FROM user_meta WHERE user_id = ?',
        ),
        stmtSetMeta: db.prepare(
          'INSERT OR REPLACE INTO user_meta (user_id, current_seq, min_seq) VALUES (?, ?, ?)',
        ),
        stmtInsertChangelog: db.prepare(
          'INSERT INTO changelog (user_id, seq, table_name, id, op, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        stmtGetChangelogSince: db.prepare(
          'SELECT seq, table_name, id, op, version, timestamp, client_id, deleted, data FROM changelog WHERE user_id = ? AND seq > ? ORDER BY seq ASC',
        ),
        stmtPruneChangelog: db.prepare(
          'DELETE FROM changelog WHERE user_id = ? AND seq < ?',
        ),
        stmtCountTableRecords: db.prepare(
          'SELECT COUNT(*) as count FROM records WHERE user_id = ? AND table_name = ? AND deleted = 0',
        ),
        stmtCheckUser: db.prepare(
          'SELECT 1 FROM records WHERE user_id = ? UNION SELECT 1 FROM user_meta WHERE user_id = ? LIMIT 1',
        ),
        stmtListUsers: db.prepare(
          'SELECT DISTINCT user_id FROM records UNION SELECT user_id FROM user_meta',
        ),
      };

      this.appDbs.set(safeAppId, handle);
    }

    return { handle, safeAppId };
  }

  findUserDataById(id: string): SqliteUserData | undefined {
    const auth = this.getAuthDb();
    const row = auth.stmtFindById.get(id) as
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
    const auth = this.getAuthDb();
    auth.stmtUpdatePassword.run(passwordHash, id);
  }

  async createApp(id: string): Promise<AppStorage> {
    const safeId = validateAppId(id);
    this.getAppDb(safeId);
    return new AppSqliteStorage(safeId, this);
  }

  async getApp(id: string): Promise<AppStorage | undefined> {
    const safeId = validateAppId(id);
    if (this.appDbs.has(safeId)) {
      return new AppSqliteStorage(safeId, this);
    }
    if (!this.inMemory) {
      const dbFile = path.join(this.baseDir, `${safeId}.sqlite`);
      if (fs.existsSync(dbFile)) {
        return new AppSqliteStorage(safeId, this);
      }
    }
    return undefined;
  }

  async getApps(): Promise<AppStorage[]> {
    const appSet = new Set<string>();
    for (const key of this.appDbs.keys()) {
      appSet.add(key);
    }

    if (!this.inMemory) {
      try {
        const files = fs.readdirSync(this.baseDir);
        for (const file of files) {
          if (
            file.endsWith('.sqlite') &&
            file !== 'auth.sqlite' &&
            !file.includes('-wal') &&
            !file.includes('-shm')
          ) {
            appSet.add(file.replace(/\.sqlite$/, ''));
          }
        }
      } catch {
        // Ignore read error
      }
    }

    return Array.from(appSet)
      .sort()
      .map((appId) => new AppSqliteStorage(appId, this));
  }

  async createUser(username: string, password?: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const auth = this.getAuthDb();

    const existing = auth.stmtFindByUsername.get(safeUsername);
    if (existing) {
      throw new Error(`Username "${safeUsername}" is already registered.`);
    }

    const userId = crypto.randomUUID();
    const passwordHash = password ? await hashPassword(password) : null;
    const createdAt = Date.now();

    auth.stmtInsertUser.run(userId, safeUsername, passwordHash, createdAt);
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
    const safeUsername = validateUsername(username);
    const auth = this.getAuthDb();
    const row = auth.stmtFindByUsername.get(safeUsername) as
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
    const auth = this.getAuthDb();
    const rows = auth.stmtListUsers.all() as Array<{
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

    for (const handle of this.appDbs.values()) {
      const res = handle.db
        .prepare('DELETE FROM records WHERE user_id = ?')
        .run(safeUserId) as { changes: number };
      handle.db
        .prepare('DELETE FROM changelog WHERE user_id = ?')
        .run(safeUserId);
      handle.db
        .prepare('DELETE FROM user_meta WHERE user_id = ?')
        .run(safeUserId);
      if (res.changes > 0) deleted = true;
    }

    const auth = this.getAuthDb();
    const res = auth.stmtDeleteUser.run(safeUserId) as { changes: number };
    if (res.changes > 0) deleted = true;

    return deleted;
  }

  deleteAppDb(id: string): boolean {
    const safeId = validateAppId(id);
    let deleted = false;

    const handle = this.appDbs.get(safeId);
    if (handle) {
      try {
        handle.db.close();
      } catch {
        // Ignore close error
      }
      this.appDbs.delete(safeId);
      deleted = true;
    }

    if (!this.inMemory) {
      const dbFile = path.join(this.baseDir, `${safeId}.sqlite`);
      const walFile = path.join(this.baseDir, `${safeId}.sqlite-wal`);
      const shmFile = path.join(this.baseDir, `${safeId}.sqlite-shm`);

      try {
        fs.unlinkSync(dbFile);
        deleted = true;
      } catch {
        // File may not exist
      }
      try {
        fs.unlinkSync(walFile);
      } catch {
        // WAL may not exist
      }
      try {
        fs.unlinkSync(shmFile);
      } catch {
        // SHM may not exist
      }
    }

    return deleted;
  }

  async close(): Promise<void> {
    if (this.authHandle) {
      try {
        this.authHandle.db.close();
      } catch {
        // Ignore
      }
      this.authHandle = null;
    }
    for (const handle of this.appDbs.values()) {
      try {
        handle.db.close();
      } catch {
        // Ignore close error
      }
    }
    this.appDbs.clear();
  }
}
