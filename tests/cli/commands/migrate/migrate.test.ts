import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleMigrateCommand } from '../../../../src/cli/commands/migrate.js';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../../src/server/errors.js';
import { acquireServerLock } from '../../../../src/server/shared/lock.js';
import { getUserBucket } from '../../../../src/server/shared/validate.js';
import { FileStorage } from '../../../../src/server/storage/file.js';
import { SqliteStorage } from '../../../../src/server/storage/sqlite.js';
import { StorageType } from '../../../../src/server/storage/storage.js';
import { createAuthenticatedUser } from '../../../../src/server/storage/user.js';
import { OperationType } from '../../../../src/shared/types.js';

describe('handleMigrateCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-migrate-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should reject migration when memory backend is specified', async () => {
    await expect(
      handleMigrateCommand(['migrate'], StorageType.Memory, tmpDir),
    ).rejects.toThrow(
      new TetherServerError(
        TetherServerErrorCode.NotSupported,
        'Migration is only supported for persistent storage backends (--sqlite or --file)',
      ),
    );
  });

  it('should reject migration when server is actively running with a lock', async () => {
    const lockHandle = acquireServerLock(tmpDir, {
      port: 8080,
      host: '127.0.0.1',
      type: StorageType.Sqlite,
    });

    // Overwrite lock with active PID different than process.pid (e.g. process.ppid)
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: process.ppid,
        port: 8080,
        host: '127.0.0.1',
        type: StorageType.Sqlite,
        startedAt: Date.now(),
      }),
      'utf-8',
    );

    await expect(
      handleMigrateCommand(['migrate'], StorageType.Sqlite, tmpDir),
    ).rejects.toThrow(/Cannot migrate database while server is running/);

    lockHandle.release();
  });

  it('should report no migration required if database is already on v2 schema', async () => {
    // Create modern v2 database
    const storage = new SqliteStorage({ baseDir: tmpDir });
    await storage.createTable('todos');
    await storage.close();

    const result = await handleMigrateCommand(
      ['migrate'],
      StorageType.Sqlite,
      tmpDir,
    );
    expect(result.migratedTables).toBe(0);
    expect(result.message).toContain('already on the current schema');
  });

  it('should migrate v1 SQLite database to v2 storage format', async () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };

    // 1. Setup v1 apps.sqlite
    const appsDbPath = path.join(tmpDir, 'apps.sqlite');
    const appsDb = new DatabaseSync(appsDbPath);
    appsDb.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, created_at INTEGER);
      CREATE TABLE tables (app_id TEXT, name TEXT, created_at INTEGER, PRIMARY KEY (app_id, name));
      INSERT INTO apps (id, created_at) VALUES ('todo-app', 1000);
      INSERT INTO tables (app_id, name, created_at) VALUES ('todo-app', 'todos', 1000);
      INSERT INTO tables (app_id, name, created_at) VALUES ('todo-app', 'notes', 1000);
    `);
    appsDb.close();

    // 2. Setup v1 user database: <tmpDir>/todo-app/<bucket>/<userId>.sqlite
    const userId = 'user-1234-uuid';
    const bucket = getUserBucket(userId);
    const userDbDir = path.join(tmpDir, 'todo-app', bucket);
    await fs.mkdir(userDbDir, { recursive: true });

    const userDbPath = path.join(userDbDir, `${userId}.sqlite`);
    const userDb = new DatabaseSync(userDbPath);
    userDb.exec(`
      CREATE TABLE records (
        table_name TEXT,
        id TEXT,
        version INTEGER,
        timestamp INTEGER,
        client_id TEXT,
        deleted INTEGER,
        data TEXT,
        PRIMARY KEY (table_name, id)
      );
      CREATE TABLE changelog (
        seq INTEGER PRIMARY KEY,
        table_name TEXT,
        id TEXT,
        op TEXT,
        version INTEGER,
        timestamp INTEGER,
        client_id TEXT,
        deleted INTEGER,
        data TEXT
      );
      CREATE TABLE user_meta (current_seq INTEGER, min_seq INTEGER);

      INSERT INTO records VALUES ('todos', 'rec1', 1, 1000, 'client1', 0, '{"title":"Buy milk"}');
      INSERT INTO records VALUES ('notes', 'note1', 1, 1000, 'client1', 0, '{"content":"Important"}');
      INSERT INTO changelog VALUES (1, 'todos', 'rec1', 'put', 1, 1000, 'client1', 0, '{"title":"Buy milk"}');
      INSERT INTO user_meta VALUES (1, 1);
    `);
    userDb.close();

    // 3. Run migration
    const result = await handleMigrateCommand(['migrate'], 'sqlite', tmpDir);
    expect(result.migratedTables).toBe(2);
    expect(result.migratedUsers).toBe(1);
    expect(result.migratedRecords).toBe(2);
    expect(result.migratedChangelogEntries).toBe(1);

    // 4. Verify v2 database can open and read the migrated data
    const storage = new SqliteStorage({ baseDir: tmpDir });
    const tables = await storage.getTables();
    expect(tables.map((t) => t.name).sort()).toEqual(['notes', 'todos']);

    const todosTable = await storage.getTable('todos');
    expect(todosTable).toBeDefined();

    const mockUser = createAuthenticatedUser(userId, 'test', 1000, storage);
    const records = await todosTable?.getAllRecords(mockUser);
    expect(records).toHaveLength(1);
    expect(records?.[0].id).toBe('rec1');
    expect(records?.[0].data).toEqual({ title: 'Buy milk' });

    await storage.close();
  });

  it('should migrate v1 File database to v2 storage format', async () => {
    // 1. Setup v1 apps.json
    const appsJsonPath = path.join(tmpDir, 'apps.json');
    await fs.writeFile(
      appsJsonPath,
      JSON.stringify([{ id: 'todo-app', createdAt: 1000 }], null, 2),
      'utf-8',
    );

    // 2. Setup v1 manifest.json: <tmpDir>/todo-app/manifest.json
    const appDir = path.join(tmpDir, 'todo-app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'manifest.json'),
      JSON.stringify({ id: 'todo-app', tables: ['todos'], createdAt: 1000 }),
      'utf-8',
    );

    // 3. Setup v1 user directory: <tmpDir>/todo-app/users/<bucket>/<userId>/tables/todos.json
    const userId = 'user-5678-uuid';
    const bucket = getUserBucket(userId);
    const userDir = path.join(appDir, 'users', bucket, userId);
    const userTablesDir = path.join(userDir, 'tables');
    await fs.mkdir(userTablesDir, { recursive: true });

    await fs.writeFile(
      path.join(userTablesDir, 'todos.json'),
      JSON.stringify(
        [
          {
            id: 'todo1',
            version: 1,
            timestamp: 1000,
            clientId: 'client1',
            deleted: false,
            data: { title: 'File Todo' },
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );

    await fs.writeFile(
      path.join(userDir, 'sync.jsonl'),
      `${JSON.stringify({
        seq: 1,
        table: 'todos',
        id: 'todo1',
        op: OperationType.Put,
        version: 1,
        timestamp: 1000,
        clientId: 'client1',
        data: { title: 'File Todo' },
      })}\n`,
      'utf-8',
    );

    await fs.writeFile(
      path.join(userDir, 'meta.json'),
      JSON.stringify({ currentSeq: 1, minSeq: 1 }, null, 2),
      'utf-8',
    );

    // 4. Run migration
    const result = await handleMigrateCommand(
      ['migrate'],
      StorageType.File,
      tmpDir,
    );
    expect(result.migratedTables).toBe(1);
    expect(result.migratedUsers).toBe(1);
    expect(result.migratedRecords).toBe(1);
    expect(result.migratedChangelogEntries).toBe(1);

    // 5. Verify v2 FileStorage reads migrated data
    const storage = new FileStorage({ baseDir: tmpDir });
    const tables = await storage.getTables();
    expect(tables.map((t) => t.name)).toEqual(['todos']);

    const todosTable = await storage.getTable('todos');
    expect(todosTable).toBeDefined();

    const mockUser = createAuthenticatedUser(userId, 'fileuser', 1000, storage);
    const records = await todosTable?.getAllRecords(mockUser);
    expect(records).toHaveLength(1);
    expect(records?.[0].id).toBe('todo1');
    expect(records?.[0].data).toEqual({ title: 'File Todo' });

    await storage.close();
  });

  it('should return early when File database is already on v2 schema', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'tables.json'),
      JSON.stringify([{ name: 'todos', settings: {}, createdAt: Date.now() }]),
      'utf-8',
    );

    const result = await handleMigrateCommand(
      ['migrate'],
      StorageType.File,
      tmpDir,
    );
    expect(result.migratedTables).toBe(0);
    expect(result.message).toContain(
      'Database is already on the current schema (v2)',
    );
  });

  it('should throw NotFound when no v1 database or apps.json exists', async () => {
    await expect(
      handleMigrateCommand(['migrate'], StorageType.File, tmpDir),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });
    await expect(
      handleMigrateCommand(['migrate'], StorageType.Sqlite, tmpDir),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });
  });

  it('should throw NotFound when --app filter does not match any app in v1 database', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'apps.json'),
      JSON.stringify([{ id: 'existing-app', createdAt: 1000 }]),
      'utf-8',
    );
    await expect(
      handleMigrateCommand(
        ['migrate', '--app=nonexistent-app'],
        StorageType.File,
        tmpDir,
      ),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });
  });

  it('should migrate SQLite databases with nested user directory structures', async () => {
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => DatabaseSync;
    };
    const appsDbPath = path.join(tmpDir, 'apps.sqlite');
    const appsDb = new DatabaseSync(appsDbPath);
    appsDb.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, created_at INTEGER);
      CREATE TABLE tables (app_id TEXT, name TEXT, created_at INTEGER, PRIMARY KEY (app_id, name));
      INSERT INTO apps (id, created_at) VALUES ('nested-app', 1000);
      INSERT INTO tables (app_id, name, created_at) VALUES ('nested-app', 'nested_table', 1000);
    `);
    appsDb.close();
    const nestedUserDir = path.join(
      tmpDir,
      'nested-app',
      'bucket1',
      'subfolder',
    );
    await fs.mkdir(nestedUserDir, { recursive: true });
    const userDbPath = path.join(nestedUserDir, 'nested-user.sqlite');
    const userDb = new DatabaseSync(userDbPath);
    userDb.exec(`
      CREATE TABLE records (table_name TEXT, id TEXT, version INTEGER, timestamp INTEGER, client_id TEXT, deleted INTEGER, data TEXT, PRIMARY KEY (table_name, id));
      CREATE TABLE changelog (seq INTEGER PRIMARY KEY, table_name TEXT, id TEXT, op TEXT, version INTEGER, timestamp INTEGER, client_id TEXT, deleted INTEGER, data TEXT);
      INSERT INTO records VALUES ('nested_table', 'n1', 1, 1000, 'c1', 0, '{"data":123}');
    `);
    userDb.close();
    const result = await handleMigrateCommand(['migrate'], 'sqlite', tmpDir);
    expect(result.migratedUsers).toBe(1);
    expect(result.migratedRecords).toBe(1);
  });

  it('should migrate File database discovering unmanifested tables and handling existing tables.json', async () => {
    const appsJsonPath = path.join(tmpDir, 'apps.json');
    await fs.writeFile(
      appsJsonPath,
      JSON.stringify([{ id: 'unmanifested-app', createdAt: 1000 }]),
      'utf-8',
    );
    const tablesJsonPath = path.join(tmpDir, 'tables.json');
    await fs.writeFile(tablesJsonPath, 'invalid json content', 'utf-8');
    const appDir = path.join(tmpDir, 'unmanifested-app');
    const userDir = path.join(appDir, 'users', 'b1', 'u1', 'tables');
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      path.join(userDir, 'extra_table.json'),
      JSON.stringify([
        {
          id: 'e1',
          version: 1,
          timestamp: 1000,
          clientId: 'c1',
          deleted: false,
          data: {},
        },
      ]),
      'utf-8',
    );
    const result = await handleMigrateCommand(
      ['migrate'],
      StorageType.File,
      tmpDir,
    );
    expect(result.migratedTables).toBe(1);
    expect(result.migratedUsers).toBe(1);
  });
});
