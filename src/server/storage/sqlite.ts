import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { shouldOverwrite } from '../../shared/clock.js';
import {
  calculateByteSize,
  validateAppId,
  validateRecordId,
  validateStoreName,
  validateUserId,
} from '../../shared/sanitize.js';
import {
  type ChangeRecord,
  OperationType,
  type RecordSnapshotItem,
  type ServerLimits,
  type StoredRecord,
} from '../../shared/types.js';
import type { StorageAdapter } from './adapter.js';

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSync;
};

/**
 * Options for configuring the SQLite storage adapter.
 */
export interface SqliteStorageOptions {
  /** Directory path where per-app SQLite database files `<appId>.sqlite` will be stored. Defaults to '.data'. */
  baseDir?: string;
  /** Whether to run purely in memory (:memory:) per application namespace. */
  inMemory?: boolean;
  /** Optional limits and quota configurations. */
  limits?: ServerLimits;
}

interface RawRecordRow {
  user_id: string;
  store: string;
  id: string;
  version: number;
  timestamp: number;
  client_id: string | null;
  deleted: number;
  data: string | null;
}

interface RawChangelogRow {
  user_id: string;
  seq: number;
  store: string;
  id: string;
  op: string;
  version: number;
  timestamp: number;
  client_id: string | null;
  deleted: number;
  data: string | null;
}

interface RawMetaRow {
  user_id: string;
  current_seq: number;
  min_seq: number;
}

interface AppDbHandle {
  db: DatabaseSync;
  stmtGetRecord: StatementSync;
  stmtGetAllRecords: StatementSync;
  stmtGetAllRecordsForStore: StatementSync;
  stmtGetMeta: StatementSync;
  stmtUpsertMeta: StatementSync;
  stmtGetRecordForUpdate: StatementSync;
  stmtUpsertRecord: StatementSync;
  stmtInsertChangelog: StatementSync;
  stmtCountStores: StatementSync;
  stmtCountActiveStoreRecords: StatementSync;
  stmtGetChangelogSince: StatementSync;
  stmtGetChangelogStats: StatementSync;
  stmtGetChangelogCutoff: StatementSync;
  stmtPruneChangelog: StatementSync;
  stmtListStores: StatementSync;
  stmtCheckUser: StatementSync;
}

/**
 * SQLite implementation of `StorageAdapter`.
 * Creates and manages an isolated SQLite database file per application namespace (`<baseDir>/<appId>.sqlite`).
 * Supports high concurrency WAL mode, atomic multi-statement transactions, and changelog compaction.
 */
export class SqliteStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private inMemory: boolean;
  private limits: ServerLimits;
  private appDbs: Map<string, AppDbHandle> = new Map();

  /**
   * Initializes a new SqliteStorageAdapter instance.
   *
   * @param options - SQLite storage configuration options.
   */
  constructor(options: SqliteStorageOptions = {}) {
    this.limits = options.limits ?? {};
    this.inMemory = options.inMemory || options.baseDir === ':memory:' || false;
    this.baseDir = this.inMemory
      ? ':memory:'
      : path.resolve(options.baseDir ?? '.data');

    if (!this.inMemory) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getAppDb(appId?: string): { handle: AppDbHandle; safeAppId: string } {
    const safeAppId = validateAppId(appId);
    let handle = this.appDbs.get(safeAppId);

    if (!handle) {
      let db: DatabaseSync;
      if (this.inMemory) {
        db = new NodeDatabaseSync(':memory:');
      } else {
        const filePath = path.join(this.baseDir, `${safeAppId}.sqlite`);
        db = new NodeDatabaseSync(filePath);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
      }
      db.exec('PRAGMA foreign_keys = ON;');

      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          user_id TEXT NOT NULL,
          store TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT,
          deleted INTEGER NOT NULL DEFAULT 0,
          data TEXT,
          PRIMARY KEY (user_id, store, id)
        );

        CREATE INDEX IF NOT EXISTS idx_records_lookup
          ON records (user_id, store, deleted);

        CREATE TABLE IF NOT EXISTS changelog (
          user_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          store TEXT NOT NULL,
          id TEXT NOT NULL,
          op TEXT NOT NULL,
          version INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          client_id TEXT,
          deleted INTEGER NOT NULL DEFAULT 0,
          data TEXT,
          PRIMARY KEY (user_id, seq)
        );

        CREATE TABLE IF NOT EXISTS user_meta (
          user_id TEXT PRIMARY KEY,
          current_seq INTEGER NOT NULL DEFAULT 0,
          min_seq INTEGER NOT NULL DEFAULT 0
        );
      `);

      handle = {
        db,
        stmtGetRecord: db.prepare(
          'SELECT id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND store = ? AND id = ?',
        ),
        stmtGetAllRecords: db.prepare(
          'SELECT store, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND deleted = 0',
        ),
        stmtGetAllRecordsForStore: db.prepare(
          'SELECT store, id, version, timestamp, client_id, deleted, data FROM records WHERE user_id = ? AND store = ? AND deleted = 0',
        ),
        stmtGetMeta: db.prepare(
          'SELECT current_seq, min_seq FROM user_meta WHERE user_id = ?',
        ),
        stmtUpsertMeta: db.prepare(`
          INSERT INTO user_meta (user_id, current_seq, min_seq)
          VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            current_seq = excluded.current_seq,
            min_seq = excluded.min_seq
        `),
        stmtGetRecordForUpdate: db.prepare(
          'SELECT version, timestamp, client_id, deleted FROM records WHERE user_id = ? AND store = ? AND id = ?',
        ),
        stmtUpsertRecord: db.prepare(`
          INSERT INTO records (user_id, store, id, version, timestamp, client_id, deleted, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, store, id) DO UPDATE SET
            version = excluded.version,
            timestamp = excluded.timestamp,
            client_id = excluded.client_id,
            deleted = excluded.deleted,
            data = excluded.data
        `),
        stmtInsertChangelog: db.prepare(`
          INSERT INTO changelog (user_id, seq, store, id, op, version, timestamp, client_id, deleted, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        stmtCountStores: db.prepare(
          'SELECT COUNT(DISTINCT store) as count FROM records WHERE user_id = ?',
        ),
        stmtCountActiveStoreRecords: db.prepare(
          'SELECT COUNT(*) as count FROM records WHERE user_id = ? AND store = ? AND deleted = 0',
        ),
        stmtGetChangelogSince: db.prepare(
          'SELECT seq, store, id, op, version, timestamp, client_id, deleted, data FROM changelog WHERE user_id = ? AND seq > ? ORDER BY seq ASC',
        ),
        stmtGetChangelogStats: db.prepare(
          'SELECT COUNT(*) as count FROM changelog WHERE user_id = ?',
        ),
        stmtGetChangelogCutoff: db.prepare(
          'SELECT seq FROM changelog WHERE user_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?',
        ),
        stmtPruneChangelog: db.prepare(
          'DELETE FROM changelog WHERE user_id = ? AND seq <= ?',
        ),
        stmtListStores: db.prepare(
          'SELECT DISTINCT store FROM records WHERE user_id = ? AND deleted = 0 ORDER BY store ASC',
        ),
        stmtCheckUser: db.prepare(
          'SELECT 1 FROM records WHERE user_id = ? UNION SELECT 1 FROM user_meta WHERE user_id = ? LIMIT 1',
        ),
      };

      this.appDbs.set(safeAppId, handle);
    }

    return { handle, safeAppId };
  }

  private parseData(raw: string | null): unknown {
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Retrieves a single stored record by table and ID for a user and application.
   *
   * @param userId - Target user account identifier.
   * @param store - Table/store name.
   * @param id - Record identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns The stored record, or `undefined` if not found.
   */
  async getRecord(
    userId: string,
    store: string,
    id: string,
    appId?: string,
  ): Promise<StoredRecord | undefined> {
    const { handle } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);
    validateStoreName(store, this.limits.allowedStores, safeUserId);
    validateRecordId(id, store, safeUserId);

    const row = handle.stmtGetRecord.get(safeUserId, store, id) as
      | RawRecordRow
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      deleted: Boolean(row.deleted),
      data: this.parseData(row.data),
    };
  }

  /**
   * Retrieves all active records across all stores (or for a specific store) for a user and application.
   *
   * @param userId - Target user account identifier.
   * @param store - Optional specific table name to filter records.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of snapshot record items.
   */
  async getAllRecords(
    userId: string,
    store?: string,
    appId?: string,
  ): Promise<RecordSnapshotItem[]> {
    const { handle, safeAppId } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);

    let rows: RawRecordRow[];
    if (store) {
      validateStoreName(store, this.limits.allowedStores, safeUserId);
      rows = handle.stmtGetAllRecordsForStore.all(
        safeUserId,
        store,
      ) as unknown as RawRecordRow[];
    } else {
      rows = handle.stmtGetAllRecords.all(
        safeUserId,
      ) as unknown as RawRecordRow[];
    }

    return rows.map((row) => ({
      appId: safeAppId,
      store: row.store,
      id: row.id,
      version: row.version,
      timestamp: row.timestamp,
      deleted: false,
      data: this.parseData(row.data),
    }));
  }

  /**
   * Applies an array of mutation change operations applying Last-Write-Wins rules,
   * enforcing quotas, and compacting old changelog entries.
   *
   * @param userId - Target user account identifier.
   * @param changes - Array of change records to apply.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Object with applied changes and new sequence number.
   */
  async applyChanges(
    userId: string,
    changes: ChangeRecord[],
    appId?: string,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const { handle, safeAppId } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);
    const applied: ChangeRecord[] = [];

    const maxStores = this.limits.maxStoresPerUser ?? 50;
    const maxRecords = this.limits.maxRecordsPerStore ?? 10000;
    const maxRecordSize = this.limits.maxRecordSizeBytes ?? 512 * 1024;
    const maxChangelog = this.limits.maxChangelogEntries ?? 1000;

    handle.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const metaRow = handle.stmtGetMeta.get(safeUserId) as
        | RawMetaRow
        | undefined;
      let currentSeq = metaRow?.current_seq ?? 0;
      let minSeq = metaRow?.min_seq ?? 0;

      for (const change of changes) {
        const storeName = validateStoreName(
          change.store,
          this.limits.allowedStores,
          safeUserId,
        );
        const recordId = validateRecordId(change.id, change.store, safeUserId);

        // Check store capacity limit
        const existingRecord = handle.stmtGetRecordForUpdate.get(
          safeUserId,
          storeName,
          recordId,
        ) as
          | Pick<
              RawRecordRow,
              'version' | 'timestamp' | 'client_id' | 'deleted'
            >
          | undefined;

        if (!existingRecord) {
          const storeCountRow = handle.stmtCountStores.get(safeUserId) as {
            count: number;
          };
          if (storeCountRow.count >= maxStores) {
            throw new Error(
              `Store limit reached. Maximum ${maxStores} tables allowed for user "${safeUserId}" in app "${safeAppId}".`,
            );
          }
        }

        // Check record size limit
        if (change.data !== undefined) {
          const payloadSize = calculateByteSize(change.data);
          if (payloadSize > maxRecordSize) {
            throw new Error(
              `Record size (${payloadSize} bytes) for record "${recordId}" in table "${storeName}" exceeds maximum allowed size of ${maxRecordSize} bytes for user "${safeUserId}" in app "${safeAppId}".`,
            );
          }
        }

        const isExistingActive = existingRecord && existingRecord.deleted === 0;
        const isInsertingActive =
          !isExistingActive &&
          !change.deleted &&
          change.op !== OperationType.Delete;

        if (isInsertingActive) {
          const activeCountRow = handle.stmtCountActiveStoreRecords.get(
            safeUserId,
            storeName,
          ) as { count: number };
          if (activeCountRow.count >= maxRecords) {
            throw new Error(
              `Table "${storeName}" has reached the maximum capacity of ${maxRecords} records for user "${safeUserId}" in app "${safeAppId}".`,
            );
          }
        }

        const existingRecordObj = existingRecord
          ? {
              version: existingRecord.version,
              timestamp: existingRecord.timestamp,
              clientId: existingRecord.client_id ?? undefined,
              deleted: Boolean(existingRecord.deleted),
            }
          : undefined;

        if (shouldOverwrite(change, existingRecordObj)) {
          currentSeq += 1;
          const seq = currentSeq;

          const isDelete =
            change.op === OperationType.Delete || Boolean(change.deleted);
          const newVersion = (existingRecord?.version ?? 0) + 1;
          const dataJson =
            change.data !== undefined ? JSON.stringify(change.data) : null;

          handle.stmtUpsertRecord.run(
            safeUserId,
            storeName,
            recordId,
            newVersion,
            change.timestamp,
            change.clientId ?? null,
            isDelete ? 1 : 0,
            dataJson,
          );

          handle.stmtInsertChangelog.run(
            safeUserId,
            seq,
            storeName,
            recordId,
            change.op ?? (isDelete ? OperationType.Delete : OperationType.Put),
            newVersion,
            change.timestamp,
            change.clientId ?? null,
            isDelete ? 1 : 0,
            dataJson,
          );

          const appliedChange: ChangeRecord & { seq: number } = {
            ...change,
            store: storeName,
            id: recordId,
            seq,
            version: newVersion,
            deleted: isDelete,
            appId: safeAppId,
          };

          applied.push(appliedChange);
        }
      }

      // Compact changelog if beyond threshold
      const stats = handle.stmtGetChangelogStats.get(safeUserId) as {
        count: number;
      };
      if (stats.count > maxChangelog) {
        const cutoffRow = handle.stmtGetChangelogCutoff.get(
          safeUserId,
          maxChangelog,
        ) as { seq: number } | undefined;
        if (cutoffRow) {
          handle.stmtPruneChangelog.run(safeUserId, cutoffRow.seq);
          minSeq = cutoffRow.seq + 1;
        }
      }

      handle.stmtUpsertMeta.run(safeUserId, currentSeq, minSeq);
      handle.db.exec('COMMIT');

      return { applied, newSeq: currentSeq };
    } catch (err) {
      handle.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Retrieves all changes applied since the given sequence number for a user in an application.
   * If `fromSeq < minSeq` (compacted window), `requiresSnapshot` is true.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Object with change records, current sequence number, and snapshot requirement flag.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
    appId?: string,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const { handle, safeAppId } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);

    const metaRow = handle.stmtGetMeta.get(safeUserId) as
      | RawMetaRow
      | undefined;
    const currentSeq = metaRow?.current_seq ?? 0;
    const minSeq = metaRow?.min_seq ?? 0;

    if (fromSeq < minSeq && minSeq > 0) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const rows = handle.stmtGetChangelogSince.all(
      safeUserId,
      fromSeq,
    ) as unknown as RawChangelogRow[];

    const changes: ChangeRecord[] = rows.map((row) => ({
      appId: safeAppId,
      seq: row.seq,
      store: row.store,
      id: row.id,
      op:
        row.op === OperationType.Delete
          ? OperationType.Delete
          : OperationType.Put,
      version: row.version,
      timestamp: row.timestamp,
      clientId: row.client_id ?? '',
      deleted: Boolean(row.deleted),
      data: this.parseData(row.data),
    }));

    return { changes, currentSeq, requiresSnapshot: false };
  }

  /**
   * Retrieves the current sequence number for a user's dataset in an application.
   *
   * @param userId - Target user account identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Current sequence number integer.
   */
  async getCurrentSeq(userId: string, appId?: string): Promise<number> {
    const { handle } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);
    const metaRow = handle.stmtGetMeta.get(safeUserId) as
      | RawMetaRow
      | undefined;
    return metaRow?.current_seq ?? 0;
  }

  /**
   * Lists all active application namespace identifiers on the server, or created by a user.
   *
   * @param userId - Optional user ID filter.
   * @returns Array of unique application IDs.
   */
  async listApps(userId?: string): Promise<string[]> {
    const appSet = new Set<string>();

    // Add active in-memory / cached app names
    for (const appId of this.appDbs.keys()) {
      if (userId) {
        const safeUserId = validateUserId(userId);
        const handle = this.appDbs.get(appId);
        const hasUser = handle?.stmtCheckUser.get(safeUserId, safeUserId);
        if (hasUser) appSet.add(appId);
      } else {
        appSet.add(appId);
      }
    }

    // If file-based, also scan directory for other app sqlite files
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
            const appId = file.replace(/\.sqlite$/, '');
            if (userId) {
              const { handle } = this.getAppDb(appId);
              const safeUserId = validateUserId(userId);
              const hasUser = handle.stmtCheckUser.get(safeUserId, safeUserId);
              if (hasUser) appSet.add(appId);
            } else {
              appSet.add(appId);
            }
          }
        }
      } catch {
        // Ignore directory read error
      }
    }

    return Array.from(appSet).sort();
  }

  /**
   * Lists all table/store names created within an application for a user.
   *
   * @param userId - Target user account identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of table names.
   */
  async listStores(userId: string, appId?: string): Promise<string[]> {
    const { handle } = this.getAppDb(appId);
    const safeUserId = validateUserId(userId);
    const rows = handle.stmtListStores.all(safeUserId) as Array<{
      store: string;
    }>;
    return rows.map((r) => r.store);
  }

  /**
   * Closes all underlying SQLite database connections cleanly.
   */
  async close(): Promise<void> {
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
