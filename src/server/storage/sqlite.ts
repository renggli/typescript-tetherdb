import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
import { getOrCreateKeyfileSecret, hashPassword } from '../shared/crypto.js';
import { assertNoActiveServerLock } from '../shared/lock.js';
import {
  normalizeUserName,
  validateKeepCount,
  validatePassword,
  validateRecordId,
  validateTableName,
  validateTableSettings,
  validateUserId,
  validateUserName,
} from '../shared/validate.js';
import {
  createAppliedRecords,
  type MaintenanceResult,
  Storage,
  type StorageOptions,
  StorageType,
  validateBatchChanges,
} from './storage.js';
import { Table } from './table.js';
import { createAuthenticatedUser, type User } from './user.js';

export interface SqliteUserData {
  userId: string;
  userName: string;
  passwordHash: string | null;
  createdAt: number;
}

export interface UsersDbHandle {
  db: DatabaseSync;
  stmtFindById: StatementSync;
  stmtFindByUserName: StatementSync;
  stmtInsertUser: StatementSync;
  stmtUpdatePassword: StatementSync;
  stmtRenameUser: StatementSync;
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
 * SQLite storage engine persisting records in consolidated SQLite databases.
 */
export class SqliteStorage extends Storage {
  readonly type = StorageType.Sqlite;
  readonly baseDir?: string;
  readonly inMemory: boolean;
  readonly secret: string;
  override readonly options: SqliteStorageOptions;
  private usersHandle: UsersDbHandle | null = null;
  private tablesHandle: TablesDbHandle | null = null;
  private tableInstances: Map<string, Table> = new Map();

  constructor(options: SqliteStorageOptions = {}) {
    super(options);
    this.options = options;
    this.inMemory = Boolean(
      options.inMemory ||
        options.baseDir === ':memory:' ||
        (!options.baseDir && options.inMemory),
    );
    this.baseDir = this.inMemory
      ? undefined
      : path.resolve(options.baseDir ?? '.data');
    this.secret =
      options.secret ??
      (this.baseDir
        ? getOrCreateKeyfileSecret(this.baseDir)
        : crypto.randomBytes(32).toString('hex'));

    if (this.baseDir) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch {
        // Ignore directory creation error
      }
    }

    // Eagerly initialize both databases so schema is set up at startup
    // and any schema errors surface immediately rather than on first request.
    this.getUsersDb();
    this.getTablesDb();
  }

  async createTable(
    name: string,
    settings: Partial<TableSettings> = {},
  ): Promise<Table> {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeName = validateTableName(name);
    const validatedSettings = validateTableSettings(settings);
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
      JSON.stringify(validatedSettings),
      Date.now(),
    );
    const table = new Table(safeName, this, validatedSettings);
    this.tableInstances.set(safeName, table);
    return table;
  }

  getTableSync(name: string): Table | undefined {
    const safeName = validateTableName(name);
    const existingInstance = this.tableInstances.get(safeName);
    if (existingInstance) return existingInstance;

    const dbHandle = this.getTablesDb();
    const row = dbHandle.stmtFindTable.get(safeName) as
      | { name: string; settings: string | null; created_at: number }
      | undefined;
    if (!row) return undefined;

    let parsedSettings: Partial<TableSettings> = {};
    if (row.settings) {
      try {
        parsedSettings = JSON.parse(row.settings);
      } catch {
        // Ignore JSON parse error
      }
    }

    const table = new Table(row.name, this, parsedSettings);
    this.tableInstances.set(safeName, table);
    return table;
  }

  async getTable(name: string): Promise<Table | undefined> {
    return this.getTableSync(name);
  }

  updateTableSettings(name: string, settings: TableSettings): void {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeName = validateTableName(name);
    const dbHandle = this.getTablesDb();
    dbHandle.stmtUpdateTableSettings.run(JSON.stringify(settings), safeName);
    const existing = this.tableInstances.get(safeName);
    if (existing) {
      existing.settings = settings;
    }
  }

  async getTables(): Promise<Table[]> {
    const dbHandle = this.getTablesDb();
    const rows = dbHandle.stmtListTables.all() as Array<{
      name: string;
      settings: string | null;
      created_at: number;
    }>;

    const tables: Table[] = [];
    for (const r of rows) {
      let instance = this.tableInstances.get(r.name);
      if (!instance) {
        let parsedSettings: Partial<TableSettings> = {};
        if (r.settings) {
          try {
            parsedSettings = JSON.parse(r.settings);
          } catch {
            // Ignore
          }
        }
        instance = new Table(r.name, this, parsedSettings);
        this.tableInstances.set(r.name, instance);
      }
      tables.push(instance);
    }
    return tables;
  }

  async createUser(userName: string, password: string): Promise<User> {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeUserName = validateUserName(userName);
    const validPassword = validatePassword(password);
    const usersDb = this.getUsersDb();

    const existing = usersDb.stmtFindByUserName.get(safeUserName);
    if (existing) {
      throw new TetherServerError(
        TetherServerErrorCode.AlreadyExists,
        'Username is already registered',
      );
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(validPassword);
    const createdAt = Date.now();

    usersDb.stmtInsertUser.run(userId, safeUserName, passwordHash, createdAt);
    return createAuthenticatedUser(userId, safeUserName, createdAt, this);
  }

  async getUser(userId: string): Promise<User | undefined> {
    const safeUserId = validateUserId(userId);
    const data = this.findUserDataById(safeUserId);
    if (data) {
      return createAuthenticatedUser(
        data.userId,
        data.userName,
        data.createdAt,
        this,
      );
    }
    return undefined;
  }

  async getUserByUserName(userName: string): Promise<User | undefined> {
    const safeUserName = normalizeUserName(userName);
    if (!safeUserName) return undefined;
    const usersDb = this.getUsersDb();
    const row = usersDb.stmtFindByUserName.get(safeUserName) as
      | {
          id: string;
          user_name: string;
          password_hash: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return createAuthenticatedUser(row.id, row.user_name, row.created_at, this);
  }

  async getUsers(): Promise<User[]> {
    const usersDb = this.getUsersDb();
    const rows = usersDb.stmtListUsers.all() as Array<{
      id: string;
      user_name: string;
      password_hash: string | null;
      created_at: number;
    }>;
    return rows.map((r) =>
      createAuthenticatedUser(r.id, r.user_name, r.created_at, this),
    );
  }

  async getUserPasswordHash(
    userId: string,
  ): Promise<string | null | undefined> {
    const safeUserId = validateUserId(userId);
    const user = this.findUserDataById(safeUserId);
    return user?.passwordHash;
  }

  async setUserPasswordHash(userId: string, hash: string): Promise<void> {
    this.updateUserData(userId, hash);
  }

  async getRawRecord(
    tableName: string,
    partition: string,
    id: string,
  ): Promise<InternalStoredRecord | undefined> {
    const safeId = validateRecordId(id);
    const dbHandle = this.getTablesDb();

    const row = dbHandle.stmtGetRecord.get(
      tableName,
      partition,
      safeId,
    ) as unknown as SqliteRecordRow | undefined;

    return row ? rowToInternalStoredRecord(row, safeId) : undefined;
  }

  async getRawRecords(
    tableName: string,
    partition: string,
  ): Promise<InternalStoredRecord[]> {
    const dbHandle = this.getTablesDb();
    const rows = dbHandle.stmtGetSnapshotByTable.all(
      tableName,
      partition,
    ) as unknown as SqliteRecordRow[];

    return rows.map((row) => rowToInternalStoredRecord(row));
  }

  async getRawChangesSince(
    fromSeq: number,
    _user: User,
  ): Promise<{
    rawChanges: InternalChangeRecord[];
    currentSeq: number;
    minSeq: number;
  }> {
    const dbHandle = this.getTablesDb();
    let currentSeq = 0;
    let minSeq = 0;
    let rows: Array<{
      seq: number;
      table_name: string;
      partition: string;
      id: string;
      op: string;
      version: number;
      timestamp: number;
      client_id: string | null;
      deleted: number;
      data: string | null;
      user_id: string | null;
    }> = [];

    try {
      dbHandle.db.exec('BEGIN DEFERRED;');
      const metaRow = dbHandle.stmtGetMeta.get() as
        | { current_seq: number; min_seq: number }
        | undefined;
      currentSeq = metaRow?.current_seq ?? 0;
      minSeq = metaRow?.min_seq ?? 0;

      rows = dbHandle.stmtGetChangelogSince.all(
        fromSeq,
      ) as unknown as typeof rows;
      dbHandle.db.exec('COMMIT;');
    } catch (err) {
      try {
        dbHandle.db.exec('ROLLBACK;');
      } catch {}
      throw err;
    }

    const rawChanges: InternalChangeRecord[] = rows.map((r) => ({
      seq: r.seq,
      table: r.table_name,
      id: r.id,
      op: r.op as OperationType,
      version: r.version,
      timestamp: r.timestamp,
      clientId: r.client_id ?? undefined,
      data: parseJsonData(r.data),
      userId: r.user_id ?? undefined,
    }));

    return { rawChanges, currentSeq, minSeq };
  }

  async applyChanges(
    user: User,
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
    const appliedList: InternalChangeRecord[] = [];
    let newSeq = 0;

    try {
      for (const change of changes) {
        const tableName = validateTableName(change.table);
        const recordId = validateRecordId(change.id);
        const table = this.getTableSync(tableName);
        if (!table) continue;

        if (table.isPrivate && user.isAnonymous) {
          throw new TetherServerError(
            TetherServerErrorCode.Forbidden,
            'Authentication required',
          );
        }

        const effectiveUserId: string =
          table.isPrivate && user.isAuthenticated && !user.isAdmin
            ? user.userId
            : '__shared__';

        const maxRecords = table.settings.maxRecords ?? defaultMaxRecords;

        const existingRow = dbHandle.stmtGetRecordForUpdate.get(
          tableName,
          effectiveUserId,
          recordId,
        ) as unknown as SqliteRecordRow | undefined;

        const existing: InternalStoredRecord | undefined = existingRow
          ? rowToInternalStoredRecord(existingRow, recordId)
          : undefined;

        table.assertCanApplyChange(user, change, existing);

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
          const { updatedRecord, appliedChange } = createAppliedRecords(
            change,
            existing,
            user,
            0,
          );
          const isDeleted = updatedRecord.deleted ? 1 : 0;
          const dataStr = updatedRecord.deleted
            ? null
            : JSON.stringify(updatedRecord.data);
          const userId = updatedRecord.userId ?? null;

          if (existingRow) {
            dbHandle.stmtUpdateRecord.run(
              updatedRecord.version,
              updatedRecord.timestamp,
              updatedRecord.clientId ?? null,
              isDeleted,
              dataStr,
              userId,
              tableName,
              effectiveUserId,
              recordId,
            );
          } else {
            dbHandle.stmtInsertRecord.run(
              tableName,
              effectiveUserId,
              recordId,
              updatedRecord.version,
              updatedRecord.timestamp,
              updatedRecord.clientId ?? null,
              isDeleted,
              dataStr,
              userId,
            );
          }

          const res = dbHandle.stmtInsertChangelog.run(
            tableName,
            effectiveUserId,
            recordId,
            change.op,
            updatedRecord.version,
            updatedRecord.timestamp,
            updatedRecord.clientId ?? null,
            isDeleted,
            dataStr,
            userId,
          ) as { lastInsertRowid: number | bigint };

          const assignedSeq = Number(res.lastInsertRowid);
          newSeq = assignedSeq;
          appliedChange.seq = assignedSeq;

          appliedList.push(appliedChange);
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

    const resolver = new UserResolver(this);
    const publicApplied = await resolver.resolvePublicChanges(
      appliedList,
      user,
    );

    return { applied: publicApplied, newSeq };
  }

  async getCurrentSeq(_user: User): Promise<number> {
    const dbHandle = this.getTablesDb();
    const metaRow = dbHandle.stmtGetMeta.get() as
      | { current_seq: number; min_seq: number }
      | undefined;
    return metaRow?.current_seq ?? 0;
  }

  async checkpoint(): Promise<MaintenanceResult> {
    this.getUsersDb().db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.getTablesDb().db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    return {
      action: 'checkpoint',
      type: StorageType.Sqlite,
      affectedCount: 2,
      message: 'Checkpoint completed successfully across databases',
    };
  }

  async vacuum(): Promise<MaintenanceResult> {
    this.getUsersDb().db.exec('VACUUM;');
    this.getTablesDb().db.exec('VACUUM;');

    return {
      action: 'vacuum',
      type: StorageType.Sqlite,
      affectedCount: 2,
      message: 'Vacuum completed successfully across databases',
    };
  }

  async prune(keepCount?: number): Promise<MaintenanceResult> {
    const keep = validateKeepCount(
      keepCount,
      this.options.maxHistoryEntries ?? 1000,
    );
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
      type: StorageType.Sqlite,
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

  getUsersDb(): UsersDbHandle {
    if (this.usersHandle) return this.usersHandle;

    const db = createDatabase(this.baseDir, 'users.sqlite', this.inMemory);
    initUsersSchema(db);

    this.usersHandle = {
      db,
      stmtFindById: db.prepare(
        'SELECT id, user_name, password_hash, created_at FROM users WHERE id = ?',
      ),
      stmtFindByUserName: db.prepare(
        'SELECT id, user_name, password_hash, created_at FROM users WHERE user_name = ?',
      ),
      stmtInsertUser: db.prepare(
        'INSERT INTO users (id, user_name, password_hash, created_at) VALUES (?, ?, ?, ?)',
      ),
      stmtUpdatePassword: db.prepare(
        'UPDATE users SET password_hash = ? WHERE id = ?',
      ),
      stmtRenameUser: db.prepare('UPDATE users SET user_name = ? WHERE id = ?'),
      stmtDeleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
      stmtListUsers: db.prepare(
        'SELECT id, user_name, password_hash, created_at FROM users ORDER BY created_at ASC',
      ),
    };

    return this.usersHandle;
  }

  getTablesDb(): TablesDbHandle {
    if (this.tablesHandle) return this.tablesHandle;

    const db = createDatabase(this.baseDir, 'tables.sqlite', this.inMemory);
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
        'SELECT id, version, timestamp, client_id, deleted, data, user_id FROM records WHERE table_name = ? AND partition = ? AND id = ?',
      ),
      stmtGetRecordForUpdate: db.prepare(
        'SELECT version, timestamp, client_id, deleted, user_id FROM records WHERE table_name = ? AND partition = ? AND id = ?',
      ),
      stmtGetSnapshotByTable: db.prepare(
        'SELECT table_name, partition, id, version, timestamp, client_id, deleted, data, user_id FROM records WHERE table_name = ? AND partition = ? AND deleted = 0',
      ),
      stmtInsertRecord: db.prepare(
        'INSERT INTO records (table_name, partition, id, version, timestamp, client_id, deleted, data, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      stmtUpdateRecord: db.prepare(
        'UPDATE records SET version = ?, timestamp = ?, client_id = ?, deleted = ?, data = ?, user_id = ? WHERE table_name = ? AND partition = ? AND id = ?',
      ),
      stmtCountTableRecords: db.prepare(
        'SELECT COUNT(*) as count FROM records WHERE table_name = ? AND partition = ? AND deleted = 0',
      ),
      stmtDeleteTableRecords: db.prepare(
        'DELETE FROM records WHERE table_name = ?',
      ),
      stmtInsertChangelog: db.prepare(
        'INSERT INTO changelog (table_name, partition, id, op, version, timestamp, client_id, deleted, data, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      stmtGetChangelogSince: db.prepare(
        'SELECT seq, table_name, partition, id, op, version, timestamp, client_id, deleted, data, user_id FROM changelog WHERE seq > ? ORDER BY seq ASC',
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

  findUserDataById(userId: string): SqliteUserData | undefined {
    const usersDb = this.getUsersDb();
    const row = usersDb.stmtFindById.get(userId) as
      | {
          id: string;
          user_name: string;
          password_hash: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      userId: row.id,
      userName: row.user_name,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  }

  updateUserData(userId: string, passwordHash: string): void {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const usersDb = this.getUsersDb();
    usersDb.stmtUpdatePassword.run(passwordHash, userId);
  }

  deleteTable(name: string): boolean {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeName = validateTableName(name);
    const dbHandle = this.getTablesDb();

    dbHandle.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = dbHandle.stmtDeleteTable.run(safeName) as {
        changes: number;
      };
      if (res.changes === 0) {
        dbHandle.db.exec('ROLLBACK;');
        return false;
      }

      dbHandle.stmtDeleteTableRecords.run(safeName);
      dbHandle.stmtDeleteTableChangelog.run(safeName);
      dbHandle.db.exec('COMMIT;');
      this.tableInstances.delete(safeName);
      return true;
    } catch (err) {
      dbHandle.db.exec('ROLLBACK;');
      throw err;
    }
  }

  deleteUser(userId: string): boolean {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeUserId = validateUserId(userId);
    const usersDb = this.getUsersDb();

    usersDb.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = usersDb.stmtDeleteUser.run(safeUserId) as {
        changes: number;
      };
      if (res.changes === 0) {
        usersDb.db.exec('ROLLBACK;');
        return false;
      }
      usersDb.db.exec('COMMIT;');
    } catch (err) {
      usersDb.db.exec('ROLLBACK;');
      throw err;
    }

    if (this.tablesHandle) {
      this.tablesHandle.db.exec('BEGIN IMMEDIATE;');
      try {
        const sharedRecords = this.tablesHandle.db
          .prepare(
            "SELECT table_name, id, version, timestamp, client_id FROM records WHERE partition = '__shared__' AND user_id = ? AND deleted = 0",
          )
          .all(safeUserId) as Array<{
          table_name: string;
          id: string;
          version: number;
          timestamp: number;
          client_id: string | null;
        }>;

        const now = Date.now();
        let currentSeq = 0;
        const metaRow = this.tablesHandle.stmtGetMeta.get() as
          | { current_seq: number; min_seq: number }
          | undefined;
        currentSeq = metaRow?.current_seq ?? 0;
        const minSeq = metaRow && metaRow.min_seq > 0 ? metaRow.min_seq : 1;

        for (const rec of sharedRecords) {
          const nextVersion = rec.version + 1;
          this.tablesHandle.stmtUpdateRecord.run(
            nextVersion,
            now,
            rec.client_id ?? null,
            1,
            null,
            safeUserId,
            rec.table_name,
            '__shared__',
            rec.id,
          );

          const res = this.tablesHandle.stmtInsertChangelog.run(
            rec.table_name,
            '__shared__',
            rec.id,
            OperationType.Delete,
            nextVersion,
            now,
            rec.client_id ?? null,
            1,
            null,
            safeUserId,
          ) as { lastInsertRowid: number | bigint };

          currentSeq = Number(res.lastInsertRowid);
        }

        if (currentSeq > (metaRow?.current_seq ?? 0)) {
          this.tablesHandle.stmtSetMeta.run(currentSeq, minSeq);
        }

        this.tablesHandle.db
          .prepare('DELETE FROM records WHERE partition = ?')
          .run(safeUserId);
        this.tablesHandle.db
          .prepare('DELETE FROM changelog WHERE partition = ?')
          .run(safeUserId);
        this.tablesHandle.db.exec('COMMIT;');
      } catch (err) {
        this.tablesHandle.db.exec('ROLLBACK;');
        throw err;
      }
    }
    return true;
  }

  async renameUser(userId: string, newUserName: string): Promise<User> {
    if (this.baseDir) assertNoActiveServerLock(this.baseDir, 'sqlite');
    const safeUserId = validateUserId(userId);
    const safeNewName = validateUserName(newUserName);
    const usersDb = this.getUsersDb();

    const existing = this.findUserDataById(safeUserId);
    if (!existing) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `User "${safeUserId}" not found`,
      );
    }
    if (existing.userName !== safeNewName) {
      const conflict = usersDb.stmtFindByUserName.get(safeNewName);
      if (conflict) {
        throw new TetherServerError(
          TetherServerErrorCode.AlreadyExists,
          'Username is already registered',
        );
      }
    }
    usersDb.stmtRenameUser.run(safeNewName, safeUserId);
    return createAuthenticatedUser(
      safeUserId,
      safeNewName,
      existing.createdAt,
      this,
    );
  }
}

// -- Private Schema Helpers -------------------------------------------------

function parseJsonData(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface SqliteRecordRow {
  id?: string;
  version: number;
  timestamp: number;
  client_id?: string | null;
  deleted: number | boolean;
  data?: string | null;
  user_id?: string | null;
}

function rowToInternalStoredRecord(
  row: SqliteRecordRow,
  defaultId?: string,
): InternalStoredRecord {
  return {
    id: row.id ?? defaultId ?? '',
    version: row.version,
    timestamp: row.timestamp,
    clientId: row.client_id ?? undefined,
    deleted: Boolean(row.deleted),
    data: parseJsonData(row.data ?? null),
    userId: row.user_id ?? undefined,
  };
}

function initUsersSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      user_name TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_user_name ON users (user_name);
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
      partition TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      client_id TEXT,
      deleted INTEGER NOT NULL,
      data TEXT,
      user_id TEXT,
      PRIMARY KEY (table_name, partition, id)
    );

    CREATE INDEX IF NOT EXISTS idx_records_lookup
      ON records (table_name, partition, deleted);

    CREATE TABLE IF NOT EXISTS changelog (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      partition TEXT NOT NULL,
      id TEXT NOT NULL,
      op TEXT NOT NULL,
      version INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      client_id TEXT,
      deleted INTEGER NOT NULL,
      data TEXT,
      user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_changelog_seq
      ON changelog (seq, table_name, partition);

    CREATE TABLE IF NOT EXISTS meta (
      rowid INTEGER PRIMARY KEY,
      current_seq INTEGER NOT NULL,
      min_seq INTEGER NOT NULL
    );
  `);
}

function createDatabase(
  baseDir: string | undefined,
  filename: string,
  inMemory: boolean,
): DatabaseSync {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };

  const dbPath =
    inMemory || !baseDir ? ':memory:' : path.join(baseDir, filename);
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  if (!inMemory && baseDir) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }

  return db;
}
