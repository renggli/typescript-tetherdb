import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { shouldOverwrite } from '../../../shared/clock.js';
import {
  BackendType,
  type ChangeRecord,
  OperationType,
  type StoredRecord,
  type TableSettings,
} from '../../../shared/types.js';
import { getOrCreateKeyfileSecret, hashPassword } from '../../crypto.js';
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
  assertCanMutate,
  BaseStorage,
  canRead,
  isPrivateTable,
  validateBatchChanges,
} from '../base/index.js';
import type { MaintenanceResult, StorageOptions } from '../storage.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import { TableSqliteStorage } from './table.js';
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

export interface TablesDbHandle {
  db: DatabaseSync;
  stmtFindTable: StatementSync;
  stmtInsertTable: StatementSync;
  stmtUpdateTableSettings: StatementSync;
  stmtListTables: StatementSync;
  stmtDeleteTable: StatementSync;
  stmtGetRecord: StatementSync;
  stmtGetRecordForUpdate: StatementSync;
  stmtGetSnapshotByTable: StatementSync;
  stmtInsertRecord: StatementSync;
  stmtUpdateRecord: StatementSync;
  stmtCountTableRecords: StatementSync;
  stmtDeleteTableRecords: StatementSync;
  stmtInsertChangelog: StatementSync;
  stmtGetChangelogSince: StatementSync;
  stmtPruneChangelog: StatementSync;
  stmtDeleteTableChangelog: StatementSync;
  stmtGetMeta: StatementSync;
  stmtSetMeta: StatementSync;
}

export interface SqliteStorageOptions extends StorageOptions {
  baseDir?: string;
  inMemory?: boolean;
}

/**
 * SQLite-backed implementation of `Storage`.
 */
export class SqliteStorage extends BaseStorage {
  readonly backend = BackendType.Sqlite;
  readonly baseDir: string;
  readonly inMemory: boolean;
  readonly secret: string;
  override readonly options: SqliteStorageOptions;
  private usersHandle: UsersDbHandle | null = null;
  private tablesHandle: TablesDbHandle | null = null;
  private tableInstances: Map<string, TableSqliteStorage> = new Map();

  constructor(options: SqliteStorageOptions = {}) {
    super(options);
    this.options = options;
    this.inMemory = Boolean(
      options.inMemory ||
        options.baseDir === ':memory:' ||
        (!options.baseDir && options.inMemory),
    );
    this.baseDir = path.resolve(options.baseDir ?? '.data');
    this.secret =
      options.secret ??
      (this.inMemory
        ? crypto.randomBytes(32).toString('hex')
        : getOrCreateKeyfileSecret(this.baseDir));

    if (!this.inMemory) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch {
        // Ignore directory creation error
      }
    }
  }

  async createTable(
    name: string,
    settings: TableSettings = {},
  ): Promise<TableStorage> {
    const safeName = validateTableName(name);
    const dbHandle = this.getTablesDb();
    const existing = dbHandle.stmtFindTable.get(safeName);
    if (existing) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Table already exists',
      );
    }

    dbHandle.stmtInsertTable.run(
      safeName,
      JSON.stringify(settings),
      Date.now(),
    );
    const table = new TableSqliteStorage(safeName, this, settings);
    this.tableInstances.set(safeName, table);
    return table;
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    const existingInstance = this.tableInstances.get(safeName);
    if (existingInstance) return existingInstance;

    const dbHandle = this.getTablesDb();
    const row = dbHandle.stmtFindTable.get(safeName) as
      | { name: string; settings: string | null; created_at: number }
      | undefined;
    if (!row) return undefined;

    let parsedSettings: TableSettings = {};
    if (row.settings) {
      try {
        parsedSettings = JSON.parse(row.settings);
      } catch {
        // Ignore JSON parse error
      }
    }

    const table = new TableSqliteStorage(safeName, this, parsedSettings);
    this.tableInstances.set(safeName, table);
    return table;
  }

  async getTables(): Promise<TableStorage[]> {
    const dbHandle = this.getTablesDb();
    const rows = dbHandle.stmtListTables.all() as Array<{
      name: string;
      settings: string | null;
    }>;

    const tables: TableStorage[] = [];
    for (const r of rows) {
      let parsedSettings: TableSettings = {};
      if (r.settings) {
        try {
          parsedSettings = JSON.parse(r.settings);
        } catch {
          // Ignore
        }
      }
      let instance = this.tableInstances.get(r.name);
      if (!instance) {
        instance = new TableSqliteStorage(r.name, this, parsedSettings);
        this.tableInstances.set(r.name, instance);
      }
      tables.push(instance);
    }
    return tables;
  }

  async createUser(username: string, password: string): Promise<UserStorage> {
    const safeUsername = validateUsername(username);
    const validPassword = validatePassword(password);
    const usersDb = this.getUsersDb();

    const existing = usersDb.stmtFindByUsername.get(safeUsername);
    if (existing) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Username is already registered',
      );
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

  async applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const dbHandle = this.getTablesDb();
    const defaultMaxRecords = this.options.maxRecords ?? 10_000;
    const defaultMaxRecordSize = this.options.maxRecordSizeBytes ?? 512 * 1024;
    const defaultMaxHistory = this.options.maxHistoryEntries ?? 1000;

    // Phase 1: Pre-validate
    await validateBatchChanges(this, changes, defaultMaxRecordSize);

    // Phase 2: Execute transaction
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        dbHandle.db.exec('BEGIN IMMEDIATE;');
        break;
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if ((msg.includes('locked') || msg.includes('busy')) && attempt < 29) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        throw err;
      }
    }
    const appliedList: (ChangeRecord & { seq: number })[] = [];
    let newSeq = 0;

    try {
      for (const change of changes) {
        const tableName = validateTableName(change.table);
        const recordId = validateRecordId(change.id);
        const table = await this.getTable(tableName);
        if (!table) continue;
        const isPrivate = isPrivateTable(table);

        if (isPrivate && !user) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            `Authentication required for private table "${tableName}"`,
          );
        }

        const effectiveUserId: string =
          isPrivate && user ? user.id : '__shared__';

        const maxRecords = table.settings.maxRecords ?? defaultMaxRecords;

        const existingRow = dbHandle.stmtGetRecordForUpdate.get(
          tableName,
          effectiveUserId,
          recordId,
        ) as
          | {
              id: string;
              version: number;
              timestamp: number;
              client_id: string;
              deleted: number;
              data: string | null;
            }
          | undefined;

        const existing: StoredRecord | undefined = existingRow
          ? {
              id: existingRow.id,
              version: existingRow.version,
              timestamp: existingRow.timestamp,
              clientId: existingRow.client_id,
              deleted: Boolean(existingRow.deleted),
              data: existingRow.data ? JSON.parse(existingRow.data) : null,
            }
          : undefined;

        assertCanMutate(table, user, change, existing);

        if (
          change.op === OperationType.Put &&
          (!existing || existing.deleted)
        ) {
          const countRow = dbHandle.stmtCountTableRecords.get(
            tableName,
            effectiveUserId,
          ) as { count: number };
          if (countRow.count >= maxRecords) {
            throw new TetherServerError(
              TetherServerErrorCode.LimitExceeded,
              `Table record limit reached (${maxRecords} records)`,
            );
          }
        }

        const shouldApply = !existing || shouldOverwrite(change, existing);

        if (shouldApply) {
          const nextVersion = (existing?.version ?? 0) + 1;
          const isDeleted = change.op === OperationType.Delete ? 1 : 0;
          const dataStr =
            change.op === OperationType.Delete
              ? null
              : JSON.stringify(change.data ?? null);

          if (existingRow) {
            dbHandle.stmtUpdateRecord.run(
              nextVersion,
              change.timestamp,
              change.clientId,
              isDeleted,
              dataStr,
              tableName,
              effectiveUserId,
              recordId,
            );
          } else {
            dbHandle.stmtInsertRecord.run(
              tableName,
              effectiveUserId,
              recordId,
              nextVersion,
              change.timestamp,
              change.clientId,
              isDeleted,
              dataStr,
            );
          }

          const res = dbHandle.stmtInsertChangelog.run(
            tableName,
            effectiveUserId,
            recordId,
            change.op,
            nextVersion,
            change.timestamp,
            change.clientId,
            isDeleted,
            dataStr,
          ) as { lastInsertRowid: number | bigint };

          const assignedSeq = Number(res.lastInsertRowid);
          newSeq = assignedSeq;

          appliedList.push({
            seq: assignedSeq,
            table: tableName,
            id: recordId,
            op: change.op,
            version: nextVersion,
            timestamp: change.timestamp,
            clientId: change.clientId,
            data: change.op === OperationType.Delete ? undefined : change.data,
          });
        }
      }

      if (newSeq > 0) {
        const metaRow = dbHandle.stmtGetMeta.get() as
          | { current_seq: number; min_seq: number }
          | undefined;
        const minSeq = metaRow && metaRow.min_seq > 0 ? metaRow.min_seq : 1;
        dbHandle.stmtSetMeta.run(newSeq, minSeq);
      } else {
        const metaRow = dbHandle.stmtGetMeta.get() as
          | { current_seq: number; min_seq: number }
          | undefined;
        newSeq = metaRow?.current_seq ?? 0;
      }

      // Phase 3: Automatic compaction with hysteresis (+50)
      const metaRow = dbHandle.stmtGetMeta.get() as
        | { current_seq: number; min_seq: number }
        | undefined;
      if (metaRow && metaRow.current_seq > 0) {
        const targetMinSeq = Math.max(
          1,
          metaRow.current_seq - defaultMaxHistory + 1,
        );
        if (targetMinSeq > (metaRow.min_seq ?? 1) + 50) {
          dbHandle.stmtPruneChangelog.run(targetMinSeq);
          dbHandle.stmtSetMeta.run(metaRow.current_seq, targetMinSeq);
        }
      }

      dbHandle.db.exec('COMMIT;');
    } catch (err) {
      dbHandle.db.exec('ROLLBACK;');
      throw err;
    }

    return { applied: appliedList, newSeq };
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
    const dbHandle = this.getTablesDb();
    const metaRow = dbHandle.stmtGetMeta.get() as
      | { current_seq: number; min_seq: number }
      | undefined;
    const currentSeq = metaRow?.current_seq ?? 0;
    const minSeq = metaRow?.min_seq ?? 0;

    if ((fromSeq < minSeq && minSeq > 0) || fromSeq > currentSeq) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const rows = dbHandle.stmtGetChangelogSince.all(
      fromSeq,
    ) as unknown as Array<{
      seq: number;
      table_name: string;
      user_id: string;
      id: string;
      op: string;
      version: number;
      timestamp: number;
      client_id: string;
      deleted: number;
      data: string | null;
    }>;

    const changes: ChangeRecord[] = [];
    for (const r of rows) {
      const table = await this.getTable(r.table_name);
      if (!table || !canRead(table, user)) continue;
      if (tableFilters && !tableFilters.includes(r.table_name)) continue;

      const isPrivate = isPrivateTable(table);
      if (isPrivate && (!user || r.user_id !== user.id)) continue;

      changes.push({
        seq: r.seq,
        table: r.table_name,
        id: r.id,
        op: r.op as OperationType,
        version: r.version,
        timestamp: r.timestamp,
        clientId: r.client_id,
        data: r.data ? JSON.parse(r.data) : undefined,
      });
    }

    return { changes, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(_user?: UserStorage): Promise<number> {
    const dbHandle = this.getTablesDb();
    const metaRow = dbHandle.stmtGetMeta.get() as
      | { current_seq: number; min_seq: number }
      | undefined;
    return metaRow?.current_seq ?? 0;
  }

  async checkpoint(_tableName?: string): Promise<MaintenanceResult> {
    this.getUsersDb().db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.getTablesDb().db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    return {
      action: 'checkpoint',
      backend: BackendType.Sqlite,
      affectedCount: 2,
      message: 'Checkpoint completed successfully across databases',
    };
  }

  async vacuum(): Promise<MaintenanceResult> {
    this.getUsersDb().db.exec('VACUUM;');
    this.getTablesDb().db.exec('VACUUM;');

    return {
      action: 'vacuum',
      backend: BackendType.Sqlite,
      affectedCount: 2,
      message: 'Vacuum completed successfully across databases',
    };
  }

  async prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult> {
    const keep = keepCount ?? this.options.maxHistoryEntries ?? 1000;
    const dbHandle = this.getTablesDb();
    const metaRow = dbHandle.stmtGetMeta.get() as
      | { current_seq: number; min_seq: number }
      | undefined;
    let totalPruned = 0;

    if (metaRow && metaRow.current_seq > 0) {
      const targetMinSeq = Math.max(1, metaRow.current_seq - keep + 1);
      if (targetMinSeq > metaRow.min_seq) {
        const res = dbHandle.stmtPruneChangelog.run(targetMinSeq) as {
          changes: number;
        };
        totalPruned = res.changes;
        dbHandle.stmtSetMeta.run(metaRow.current_seq, targetMinSeq);
      }
    }

    return {
      action: 'prune',
      backend: BackendType.Sqlite,
      tableName,
      affectedCount: totalPruned,
      message: `Prune completed successfully. Removed ${totalPruned} changelog record(s)`,
    };
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
    if (this.tablesHandle) {
      try {
        this.tablesHandle.db.close();
      } catch {
        // Ignore
      }
      this.tablesHandle = null;
    }
    this.tableInstances.clear();
  }

  protected override getBaseDir(): string | undefined {
    return this.inMemory ? ':memory:' : this.baseDir;
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

    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    if (!this.inMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }

    initUsersSchema(db);

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

  getTablesDb(): TablesDbHandle {
    if (this.tablesHandle) return this.tablesHandle;

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };

    const dbPath = this.inMemory
      ? ':memory:'
      : path.join(this.baseDir, 'tables.sqlite');

    const db = new DatabaseSync(dbPath);

    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    if (!this.inMemory) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }

    initTablesSchema(db);

    this.tablesHandle = {
      db,
      stmtFindTable: db.prepare(
        'SELECT name, settings, created_at FROM tables WHERE name = ?',
      ),
      stmtInsertTable: db.prepare(
        'INSERT INTO tables (name, settings, created_at) VALUES (?, ?, ?)',
      ),
      stmtUpdateTableSettings: db.prepare(
        'UPDATE tables SET settings = ? WHERE name = ?',
      ),
      stmtListTables: db.prepare(
        'SELECT name, settings, created_at FROM tables ORDER BY created_at ASC',
      ),
      stmtDeleteTable: db.prepare('DELETE FROM tables WHERE name = ?'),
      stmtGetRecord: db.prepare(
        'SELECT id, version, timestamp, client_id, deleted, data FROM records WHERE table_name = ? AND user_id = ? AND id = ?',
      ),
      stmtGetRecordForUpdate: db.prepare(
        'SELECT version, timestamp, client_id, deleted FROM records WHERE table_name = ? AND user_id = ? AND id = ?',
      ),
      stmtGetSnapshotByTable: db.prepare(
        'SELECT table_name, user_id, id, version, timestamp, client_id, deleted, data FROM records WHERE table_name = ? AND user_id = ? AND deleted = 0',
      ),
      stmtInsertRecord: db.prepare(
        'INSERT INTO records (table_name, user_id, id, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      stmtUpdateRecord: db.prepare(
        'UPDATE records SET version = ?, timestamp = ?, client_id = ?, deleted = ?, data = ? WHERE table_name = ? AND user_id = ? AND id = ?',
      ),
      stmtCountTableRecords: db.prepare(
        'SELECT COUNT(*) as count FROM records WHERE table_name = ? AND user_id = ? AND deleted = 0',
      ),
      stmtDeleteTableRecords: db.prepare(
        'DELETE FROM records WHERE table_name = ?',
      ),
      stmtInsertChangelog: db.prepare(
        'INSERT INTO changelog (table_name, user_id, id, op, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      stmtGetChangelogSince: db.prepare(
        'SELECT seq, table_name, user_id, id, op, version, timestamp, client_id, deleted, data FROM changelog WHERE seq > ? ORDER BY seq ASC',
      ),
      stmtPruneChangelog: db.prepare('DELETE FROM changelog WHERE seq < ?'),
      stmtDeleteTableChangelog: db.prepare(
        'DELETE FROM changelog WHERE table_name = ?',
      ),
      stmtGetMeta: db.prepare(
        'SELECT current_seq, min_seq FROM meta WHERE rowid = 1',
      ),
      stmtSetMeta: db.prepare(
        'INSERT INTO meta (rowid, current_seq, min_seq) VALUES (1, ?, ?) ON CONFLICT(rowid) DO UPDATE SET current_seq = excluded.current_seq, min_seq = excluded.min_seq',
      ),
    };

    return this.tablesHandle;
  }

  updateTableSettingsInDb(name: string, settings: TableSettings): void {
    const safeName = validateTableName(name);
    const dbHandle = this.getTablesDb();
    dbHandle.stmtUpdateTableSettings.run(JSON.stringify(settings), safeName);
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

  deleteTable(name: string): boolean {
    const safeName = validateTableName(name);
    const dbHandle = this.getTablesDb();
    const res = dbHandle.stmtDeleteTable.run(safeName) as {
      changes: number;
    };
    if (res.changes === 0) return false;

    dbHandle.stmtDeleteTableRecords.run(safeName);
    dbHandle.stmtDeleteTableChangelog.run(safeName);
    this.tableInstances.delete(safeName);
    return true;
  }

  deleteUser(id: string): boolean {
    const safeUserId = validateUserId(id);
    const usersDb = this.getUsersDb();
    const res = usersDb.stmtDeleteUser.run(safeUserId) as {
      changes: number;
    };
    if (res.changes === 0) return false;

    if (this.tablesHandle) {
      this.tablesHandle.db
        .prepare('DELETE FROM records WHERE user_id = ?')
        .run(safeUserId);
      this.tablesHandle.db
        .prepare('DELETE FROM changelog WHERE user_id = ?')
        .run(safeUserId);
    }
    return true;
  }
}

// -- Private Schema Helpers -------------------------------------------------

function initUsersSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
  `);
}

function initTablesSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS tables (
      name TEXT PRIMARY KEY,
      settings TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      table_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      deleted INTEGER NOT NULL,
      data TEXT,
      PRIMARY KEY (table_name, user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_records_lookup
      ON records (table_name, user_id, deleted);

    CREATE TABLE IF NOT EXISTS changelog (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      op TEXT NOT NULL,
      version INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      deleted INTEGER NOT NULL,
      data TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_changelog_seq
      ON changelog (seq, table_name, user_id);

    CREATE TABLE IF NOT EXISTS meta (
      rowid INTEGER PRIMARY KEY,
      current_seq INTEGER NOT NULL,
      min_seq INTEGER NOT NULL
    );
  `);
}
