import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../server/index.js';
import { readServerLock } from '../../server/lock.js';
import { DEFAULT_TABLE_PERMISSIONS } from '../../server/storage/base/index.js';
import { getUserBucket } from '../../server/validate.js';
import { BackendType, type StoredRecord } from '../../shared/types.js';

/**
 * Result metrics returned after running a storage migration.
 */
export interface MigrationResult {
  /** Target backend engine. */
  backend: BackendType;
  /** Number of tables migrated. */
  migratedTables: number;
  /** Number of user partitions migrated. */
  migratedUsers: number;
  /** Number of records migrated across all tables and partitions. */
  migratedRecords: number;
  /** Number of changelog / sync entries migrated. */
  migratedChangelogEntries: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Handles the 'migrate' command to migrate an offline database from v1 to v2 format.
 *
 * @param positionalArgs - CLI arguments passed to the command.
 * @param backend - Storage backend type ('sqlite' | 'file').
 * @param dir - Target database directory.
 * @returns Result summary of the migration.
 */
export async function handleMigrateCommand(
  positionalArgs: string[] = [],
  backend: BackendType = BackendType.Sqlite,
  dir = '.data',
): Promise<MigrationResult> {
  const resolvedDir = path.resolve(dir);
  assertDatabaseIsOffline(resolvedDir);

  if (backend === BackendType.Memory) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      'Migration is only supported for persistent storage backends (--sqlite or --file)',
    );
  }

  const appFilter = parseAppOption(positionalArgs);

  if (backend === BackendType.Sqlite) {
    const result = await migrateSqliteStorage(resolvedDir, appFilter);
    console.log(result.message);
    return result;
  }

  const result = await migrateFileStorage(resolvedDir, appFilter);
  console.log(result.message);
  return result;
}

// -- SQLite Migration --------------------------------------------------------

async function migrateSqliteStorage(
  baseDir: string,
  appFilter?: string,
): Promise<MigrationResult> {
  const appsDbPath = path.join(baseDir, 'apps.sqlite');
  const tablesDbPath = path.join(baseDir, 'tables.sqlite');

  if (!fs.existsSync(appsDbPath)) {
    if (fs.existsSync(tablesDbPath)) {
      return {
        backend: BackendType.Sqlite,
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
    const targetApps = appFilter
      ? apps.filter((a) => a.id === appFilter)
      : apps;

    if (appFilter && targetApps.length === 0) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Application "${appFilter}" not found in v1 database`,
      );
    }

    const stmtInsertTable = tablesDb.prepare(
      'INSERT OR IGNORE INTO tables (name, settings, created_at) VALUES (?, ?, ?)',
    );
    const stmtInsertRecord = tablesDb.prepare(
      'INSERT OR REPLACE INTO records (table_name, user_id, id, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const stmtInsertChangelog = tablesDb.prepare(
      'INSERT OR REPLACE INTO changelog (seq, table_name, user_id, id, op, version, timestamp, client_id, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
          // Check if records table exists
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
              );
              migratedRecords++;
            }
          }

          // Check if changelog table exists
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

    // Update global metadata
    tablesDb
      .prepare(
        'INSERT OR REPLACE INTO meta (rowid, current_seq, min_seq) VALUES (1, ?, ?)',
      )
      .run(globalMaxSeq, globalMaxSeq > 0 ? 1 : 0);
  } finally {
    appsDb.close();
    tablesDb.close();
  }

  // Rename v1 database file to backup
  backupFile(appsDbPath);
  backupFile(`${appsDbPath}-wal`);
  backupFile(`${appsDbPath}-shm`);

  return {
    backend: BackendType.Sqlite,
    migratedTables,
    migratedUsers,
    migratedRecords,
    migratedChangelogEntries,
    message: `SQLite migration completed: migrated ${migratedTables} table(s), ${migratedUsers} user partition(s), ${migratedRecords} record(s), and ${migratedChangelogEntries} changelog entries.`,
  };
}

// -- Filesystem Storage Migration -------------------------------------------

async function migrateFileStorage(
  baseDir: string,
  appFilter?: string,
): Promise<MigrationResult> {
  const appsJsonPath = path.join(baseDir, 'apps.json');
  const tablesJsonPath = path.join(baseDir, 'tables.json');

  if (!fs.existsSync(appsJsonPath)) {
    if (fs.existsSync(tablesJsonPath)) {
      return {
        backend: BackendType.File,
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
      `No v1 File database found to migrate in "${baseDir}" (missing apps.json)`,
    );
  }

  const rawApps = await fs.promises.readFile(appsJsonPath, 'utf-8');
  const apps = JSON.parse(rawApps) as Array<{ id: string; createdAt: number }>;
  const targetApps = appFilter ? apps.filter((a) => a.id === appFilter) : apps;

  if (appFilter && targetApps.length === 0) {
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      `Application "${appFilter}" not found in v1 database`,
    );
  }

  const tablesMap = new Map<
    string,
    { name: string; settings: Record<string, unknown>; createdAt: number }
  >();
  if (fs.existsSync(tablesJsonPath)) {
    try {
      const rawTables = await fs.promises.readFile(tablesJsonPath, 'utf-8');
      const list = JSON.parse(rawTables) as Array<{
        name: string;
        settings: Record<string, unknown>;
        createdAt: number;
      }>;
      for (const t of list) tablesMap.set(t.name, t);
    } catch {
      // Ignore
    }
  }

  let migratedTables = 0;
  let migratedUsers = 0;
  let migratedRecords = 0;
  let migratedChangelogEntries = 0;

  for (const app of targetApps) {
    const appDir = path.join(baseDir, app.id);
    const manifestPath = path.join(appDir, 'manifest.json');

    if (fs.existsSync(manifestPath)) {
      try {
        const rawManifest = await fs.promises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(rawManifest) as {
          tables?: string[];
          createdAt?: number;
        };
        for (const tableName of manifest.tables ?? []) {
          if (!tablesMap.has(tableName)) {
            tablesMap.set(tableName, {
              name: tableName,
              settings: {},
              createdAt: manifest.createdAt ?? Date.now(),
            });
            migratedTables++;
          }
        }
      } catch {
        // Ignore
      }
    }

    // Traverse v1 users directory: <appDir>/users/<bucket>/<userId>/
    const appUsersDir = path.join(appDir, 'users');
    if (!fs.existsSync(appUsersDir)) continue;

    const buckets = await fs.promises.readdir(appUsersDir, {
      withFileTypes: true,
    });
    for (const b of buckets) {
      if (!b.isDirectory()) continue;
      const bucketDir = path.join(appUsersDir, b.name);
      const users = await fs.promises.readdir(bucketDir, {
        withFileTypes: true,
      });

      for (const u of users) {
        if (!u.isDirectory()) continue;
        migratedUsers++;
        const userId = u.name;
        const userBucket = getUserBucket(userId);
        const userSrcDir = path.join(bucketDir, userId);
        const userDestDir = path.join(baseDir, 'users', userBucket, userId);
        await fs.promises.mkdir(userDestDir, { recursive: true });

        // 1. Migrate table records from <userSrcDir>/tables/<tableName>.json
        const srcTablesDir = path.join(userSrcDir, 'tables');
        if (fs.existsSync(srcTablesDir)) {
          const tableFiles = await fs.promises.readdir(srcTablesDir);
          for (const file of tableFiles) {
            if (!file.endsWith('.json')) continue;
            const tableName = path.basename(file, '.json');
            if (!tablesMap.has(tableName)) {
              tablesMap.set(tableName, {
                name: tableName,
                settings: {},
                createdAt: Date.now(),
              });
              migratedTables++;
            }

            const rawContent = await fs.promises.readFile(
              path.join(srcTablesDir, file),
              'utf-8',
            );
            try {
              const records = JSON.parse(rawContent) as StoredRecord[];
              migratedRecords += records.length;
              const destTableDir = path.join(userDestDir, tableName);
              await fs.promises.mkdir(destTableDir, { recursive: true });
              await fs.promises.writeFile(
                path.join(destTableDir, 'records.json'),
                JSON.stringify(records, null, 2),
                'utf-8',
              );
            } catch {
              // Ignore
            }
          }
        }

        // 2. Migrate sync.jsonl
        const srcSyncPath = path.join(userSrcDir, 'sync.jsonl');
        if (fs.existsSync(srcSyncPath)) {
          const rawSync = await fs.promises.readFile(srcSyncPath, 'utf-8');
          const lines = rawSync
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          migratedChangelogEntries += lines.length;
          await fs.promises.writeFile(
            path.join(userDestDir, 'sync.jsonl'),
            rawSync,
            'utf-8',
          );
        }

        // 3. Migrate meta.json
        const srcMetaPath = path.join(userSrcDir, 'meta.json');
        if (fs.existsSync(srcMetaPath)) {
          const rawMeta = await fs.promises.readFile(srcMetaPath, 'utf-8');
          await fs.promises.writeFile(
            path.join(userDestDir, 'meta.json'),
            rawMeta,
            'utf-8',
          );
        }
      }
    }
  }

  // Write merged tables.json
  await fs.promises.writeFile(
    tablesJsonPath,
    JSON.stringify(Array.from(tablesMap.values()), null, 2),
    'utf-8',
  );

  // Backup apps.json
  backupFile(appsJsonPath);

  return {
    backend: BackendType.File,
    migratedTables,
    migratedUsers,
    migratedRecords,
    migratedChangelogEntries,
    message: `Filesystem migration completed: migrated ${migratedTables} table(s), ${migratedUsers} user partition(s), ${migratedRecords} record(s), and ${migratedChangelogEntries} changelog entries.`,
  };
}

// -- Private Helpers --------------------------------------------------------

function assertDatabaseIsOffline(dir: string): void {
  const lock = readServerLock(dir);
  if (lock && lock.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Cannot migrate database while server is running (PID ${lock.pid}). Please stop the server before migrating.`,
    );
  }
}

function parseAppOption(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--app=')) {
      return arg.slice(6);
    }
  }
  return undefined;
}

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

function backupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, `${filePath}.v1.bak`);
    }
  } catch {
    // Ignore backup failure
  }
}
