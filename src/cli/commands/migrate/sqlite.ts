import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../server/errors.js';
import { StorageType } from '../../../server/storage/storage.js';
import { DEFAULT_TABLE_PERMISSIONS } from '../../../shared/types.js';
import type { MigrationResult } from '../migrate.js';
import { backupFile, filterTargetApps } from './helpers.js';

/**
 * Migrates a v1 multi-app SQLite database to the v2 unified storage format.
 *
 * @param baseDir - Directory containing v1 SQLite database files.
 * @param appFilter - Optional application identifier to migrate.
 * @returns Migration result statistics.
 */
export async function migrateSqliteStorage(
  baseDir: string,
  appFilter?: string,
): Promise<MigrationResult> {
  const appsDbPath = path.join(baseDir, 'apps.sqlite');
  const tablesDbPath = path.join(baseDir, 'tables.sqlite');

  if (!fs.existsSync(appsDbPath)) {
    if (fs.existsSync(tablesDbPath)) {
      return {
        type: StorageType.Sqlite,
        migratedTables: 0,
        migratedUsers: 0,
        migratedRecords: 0,
        migratedChangelogEntries: 0,
        message:
          'Database is already on the current schema (v2). No migration required.',
      };
    }
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      `No v1 SQLite database found to migrate in "${baseDir}" (missing apps.sqlite)`,
    );
  }

  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };

  const appsDb = new DatabaseSync(appsDbPath);
  const tablesDb = new DatabaseSync(tablesDbPath);

  initV2TablesSchema(tablesDb);

  let migratedTables = 0;
  let migratedUsers = 0;
  let migratedRecords = 0;
  let migratedChangelogEntries = 0;
  let globalMaxSeq = 0;

  try {
    const apps = appsDb
      .prepare('SELECT id, created_at FROM apps')
      .all() as Array<{ id: string; created_at: number }>;
    const targetApps = filterTargetApps(apps, appFilter);

    const stmtInsertTable = tablesDb.prepare(
      'INSERT OR IGNORE INTO tables (name, settings, created_at) VALUES (?, ?, ?)',
    );
    const stmtInsertRecord = tablesDb.prepare(
      'INSERT OR REPLACE INTO records (table_name, partition, id, version, timestamp, client_id, deleted, data, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const stmtInsertChangelog = tablesDb.prepare(
      'INSERT OR REPLACE INTO changelog (seq, table_name, partition, id, op, version, timestamp, client_id, deleted, data, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const appTables = appsDb
      .prepare('SELECT app_id, name, created_at FROM tables')
      .all() as Array<{ app_id: string; name: string; created_at: number }>;

    const defaultSettings = JSON.stringify({
      permissions: { ...DEFAULT_TABLE_PERMISSIONS },
    });

    for (const app of targetApps) {
      const tablesForApp = appTables.filter((t) => t.app_id === app.id);
      for (const t of tablesForApp) {
        stmtInsertTable.run(t.name, defaultSettings, t.created_at);
        migratedTables++;
      }

      const appDir = path.join(baseDir, app.id);
      if (!fs.existsSync(appDir)) continue;

      const userDbFiles = findUserSqliteDbs(appDir);
      for (const { userId, dbPath } of userDbFiles) {
        migratedUsers++;
        const userDb = new DatabaseSync(dbPath);
        try {
          const recordsTableExists = userDb
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='records'",
            )
            .get();
          if (recordsTableExists) {
            const records = userDb
              .prepare(
                'SELECT table_name, id, version, timestamp, client_id, deleted, data FROM records',
              )
              .all() as Array<{
              table_name: string;
              id: string;
              version: number;
              timestamp: number;
              client_id: string;
              deleted: number;
              data: string | null;
            }>;

            for (const r of records) {
              stmtInsertRecord.run(
                r.table_name,
                userId,
                r.id,
                r.version,
                r.timestamp,
                r.client_id,
                r.deleted,
                r.data,
                userId,
              );
              migratedRecords++;
            }
          }

          const changelogTableExists = userDb
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='changelog'",
            )
            .get();
          if (changelogTableExists) {
            const changelogs = userDb
              .prepare(
                'SELECT seq, table_name, id, op, version, timestamp, client_id, deleted, data FROM changelog ORDER BY seq ASC',
              )
              .all() as Array<{
              seq: number;
              table_name: string;
              id: string;
              op: string;
              version: number;
              timestamp: number;
              client_id: string;
              deleted: number;
              data: string | null;
            }>;

            for (const c of changelogs) {
              stmtInsertChangelog.run(
                c.seq,
                c.table_name,
                userId,
                c.id,
                c.op,
                c.version,
                c.timestamp,
                c.client_id,
                c.deleted,
                c.data,
                userId,
              );
              migratedChangelogEntries++;
              if (c.seq > globalMaxSeq) globalMaxSeq = c.seq;
            }
          }
        } finally {
          userDb.close();
        }
      }
    }

    tablesDb
      .prepare(
        'INSERT OR REPLACE INTO meta (rowid, current_seq, min_seq) VALUES (1, ?, ?)',
      )
      .run(globalMaxSeq, globalMaxSeq > 0 ? 1 : 0);
  } finally {
    appsDb.close();
    tablesDb.close();
  }

  backupFile(appsDbPath);
  backupFile(`${appsDbPath}-wal`);
  backupFile(`${appsDbPath}-shm`);

  return {
    type: StorageType.Sqlite,
    migratedTables,
    migratedUsers,
    migratedRecords,
    migratedChangelogEntries,
    message: `SQLite migration completed: migrated ${migratedTables} table(s), ${migratedUsers} user partition(s), ${migratedRecords} record(s), and ${migratedChangelogEntries} changelog entries.`,
  };
}

// -- Private Helpers --------------------------------------------------------

function initV2TablesSchema(db: DatabaseSync): void {
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

function findUserSqliteDbs(
  appDir: string,
): Array<{ userId: string; dbPath: string }> {
  const results: Array<{ userId: string; dbPath: string }> = [];
  try {
    const entries = fs.readdirSync(appDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const bucketPath = path.join(appDir, entry.name);
        const userEntries = fs.readdirSync(bucketPath, { withFileTypes: true });
        for (const u of userEntries) {
          if (u.isFile() && u.name.endsWith('.sqlite')) {
            const userId = path.basename(u.name, '.sqlite');
            results.push({ userId, dbPath: path.join(bucketPath, u.name) });
          } else if (u.isDirectory()) {
            const nestedPath = path.join(bucketPath, u.name);
            const nestedEntries = fs.readdirSync(nestedPath, {
              withFileTypes: true,
            });
            for (const n of nestedEntries) {
              if (n.isFile() && n.name.endsWith('.sqlite')) {
                const userId = path.basename(n.name, '.sqlite');
                results.push({ userId, dbPath: path.join(nestedPath, n.name) });
              }
            }
          }
        }
      }
    }
  } catch {
    // Directory unreadable or missing
  }
  return results;
}
