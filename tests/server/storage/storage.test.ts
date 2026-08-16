import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import {
  FileStorage,
  MemoryStorage,
  SqliteStorage,
  type Storage,
} from '../../../src/server/storage/index.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('Storage (src/server/storage/)', () => {
  describe('MemoryStorage', () => {
    runStorageTestSuite(() => new MemoryStorage());
  });

  describe('SqliteStorage (in-memory)', () => {
    runStorageTestSuite(() => new SqliteStorage({ inMemory: true }));
  });

  describe('SqliteStorage (file-based)', () => {
    let tmpDir: string;
    let storage: SqliteStorage;

    beforeEach(async () => {
      tmpDir = path.join(
        os.tmpdir(),
        `tetherdb-sqlite-suite-${Math.random().toString(36).substring(2, 10)}`,
      );
      await fs.mkdir(tmpDir, { recursive: true });
      storage = new SqliteStorage({ baseDir: tmpDir });
    });

    afterEach(async () => {
      await storage.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    runStorageTestSuite(() => storage);
  });

  describe('FileStorage', () => {
    let tmpDir: string;
    let storage: FileStorage;

    beforeEach(async () => {
      tmpDir = path.join(
        os.tmpdir(),
        `tetherdb-test-${Math.random().toString(36).substring(2, 10)}`,
      );
      await fs.mkdir(tmpDir, { recursive: true });
      storage = new FileStorage({ baseDir: tmpDir });
    });

    afterEach(async () => {
      await storage.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    runStorageTestSuite(() => storage);

    it('should write data in $basePath/<appId>/users/<bucket>/<userId>/tables/<tableName>.json on filesystem', async () => {
      const app = await storage.getApp('default');
      expect(app).toBeDefined();
      if (!app) return;
      const table = await app.createTable('settings');
      const user = await storage.createUser('user_42', 'pass');

      const change: ChangeRecord = {
        table: 'settings',
        id: 'theme',
        op: OperationType.Put,
        data: { dark: true },
        timestamp: Date.now(),
        clientId: 'client-1',
      };

      await app.applyChanges(user, [change]);

      // Direct layout: tmpDir / default / users / bucket / userId / tables / settings.json
      const bucket = user.id.slice(0, 2);
      const userDir = path.join(tmpDir, 'default', 'users', bucket, user.id);
      const tableFile = path.join(userDir, 'tables', 'settings.json');
      const metaFile = path.join(userDir, 'meta.json');
      const syncFile = path.join(userDir, 'sync.jsonl');
      const manifestFile = path.join(tmpDir, 'default', 'manifest.json');
      const appsFile = path.join(tmpDir, 'apps.json');
      const usersFile = path.join(tmpDir, 'users.json');

      expect(await fs.stat(appsFile)).toBeDefined();
      expect(await fs.stat(usersFile)).toBeDefined();
      expect(await fs.stat(manifestFile)).toBeDefined();
      expect(await fs.stat(syncFile)).toBeDefined();

      const manifestContent = JSON.parse(
        await fs.readFile(manifestFile, 'utf-8'),
      );
      expect(manifestContent.tables).toContain('settings');

      const fileContent = await fs.readFile(tableFile, 'utf-8');
      const tableRecords = JSON.parse(fileContent);
      expect(tableRecords[0].data).toEqual({ dark: true });

      const metaContent = await fs.readFile(metaFile, 'utf-8');
      const metaObj = JSON.parse(metaContent);
      expect(metaObj.currentSeq).toBe(1);

      const syncContent = await fs.readFile(syncFile, 'utf-8');
      const syncLines = syncContent
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(syncLines[0].data).toEqual({ dark: true });

      const record = await table.getRecord(user, 'theme');
      expect(record?.data).toEqual({ dark: true });
    });

    it('should compact changelog beyond maxChangelogEntries and flag requiresSnapshot', async () => {
      const compactingStorage = new FileStorage({
        baseDir: tmpDir,
        maxChangelogEntries: 5,
      });
      const app = await compactingStorage.getApp('default');
      expect(app).toBeDefined();
      if (!app) return;
      await app.createTable('events');
      const user = await compactingStorage.createUser(
        'user_compaction',
        'pass',
      );

      // Apply 10 changes sequentially
      for (let i = 1; i <= 10; i++) {
        await app.applyChanges(user, [
          {
            table: 'events',
            id: `e-${i}`,
            op: OperationType.Put,
            data: `event-${i}`,
            timestamp: 1000 + i,
            clientId: 'client-1',
          },
        ]);
      }

      // Asking for seq 1 (which was pruned) should return requiresSnapshot: true
      const oldDiff = await app.getChangesSince(user, 1);
      expect(oldDiff.requiresSnapshot).toBe(true);

      // Asking for recent seq 7 (retained in window) should return delta diff
      const recentDiff = await app.getChangesSince(user, 7);
      expect(recentDiff.requiresSnapshot).toBe(false);
      expect(recentDiff.changes).toHaveLength(3);
    });

    it('should reject changes to undeclared tables or applications', async () => {
      const strictStorage = new FileStorage({ baseDir: tmpDir });
      const app = await strictStorage.createApp('myapp');
      await app.createTable('allowed_table');
      const user = await strictStorage.createUser('user_limits', 'pass');

      // Disallowed table
      await expect(
        app.applyChanges(user, [
          {
            table: 'undeclared_table',
            id: '1',
            op: OperationType.Put,
            data: 'hello',
            timestamp: 100,
            clientId: 'client-1',
          },
        ]),
      ).rejects.toMatchObject({
        code: TetherServerErrorCode.NotFound,
      });

      // Nonexistent app
      expect(await strictStorage.getApp('nonexistent_app')).toBeUndefined();
    });
  });
});

function runStorageTestSuite(createStorage: () => Storage) {
  let storage: Storage;

  beforeEach(async () => {
    storage = createStorage();
    const app = await storage.createApp('default');
    await app.createTable('todos');
    await app.createTable('notes');
    await app.createTable('items');
  });

  it('should create and authenticate users directly through UserStorage', async () => {
    const user = await storage.createUser('alice', 'password123');
    expect(user.id).toBeDefined();
    expect(user.username).toBe('alice');

    expect(await user.verifyPassword('password123')).toBe(true);
    expect(await user.verifyPassword('  password123  ')).toBe(true);
    expect(await user.verifyPassword('wrongPassword')).toBe(false);
    expect(await user.verifyPassword('')).toBe(false);

    const token = await user.createToken();
    expect(await user.verifyToken(token)).toBe(true);

    const retrievedUser = await storage.getUserByToken(token);
    expect(retrievedUser?.id).toBe(user.id);
    expect(retrievedUser?.username).toBe('alice');

    const byUsername = await storage.getUserByUsername('  ALICE  ');
    expect(byUsername?.id).toBe(user.id);

    const allUsers = await storage.getUsers();
    expect(allUsers.some((u) => u.id === user.id)).toBe(true);
  });

  it('should apply changes and assign sequential numbers', async () => {
    const app = await storage.getApp('default');
    expect(app).toBeDefined();
    const todosTable = await app?.getTable('todos');
    expect(todosTable).toBeDefined();
    const user = await storage.createUser('user_apply', 'pass');

    const changes: ChangeRecord[] = [
      {
        table: 'todos',
        id: 't1',
        op: OperationType.Put,
        data: { title: 'Item 1' },
        timestamp: 1000,
        clientId: 'c1',
      },
      {
        table: 'todos',
        id: 't2',
        op: OperationType.Put,
        data: { title: 'Item 2' },
        timestamp: 1001,
        clientId: 'c1',
      },
    ];

    const res = await app?.applyChanges(user, changes);
    expect(res?.applied).toHaveLength(2);
    expect(res?.newSeq).toBe(2);

    const record = await todosTable?.getRecord(user, 't1');
    expect(record?.data).toEqual({ title: 'Item 1' });

    const all = await todosTable?.getAllRecords(user);
    expect(all).toHaveLength(2);
  });

  it('should isolate data between different users', async () => {
    const app = await storage.getApp('default');
    expect(app).toBeDefined();
    const notesTable = await app?.getTable('notes');
    expect(notesTable).toBeDefined();

    const userA = await storage.createUser('user_a', 'pass');
    const userB = await storage.createUser('user_b', 'pass');

    await app?.applyChanges(userA, [
      {
        table: 'notes',
        id: 'secret',
        op: OperationType.Put,
        data: { secret: 'User A secret' },
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const userARecord = await notesTable?.getRecord(userA, 'secret');
    expect(userARecord?.data).toEqual({ secret: 'User A secret' });

    const userBRecord = await notesTable?.getRecord(userB, 'secret');
    expect(userBRecord).toBeUndefined();

    const userBAll = await notesTable?.getAllRecords(userB);
    expect(userBAll).toHaveLength(0);
  });

  it('should handle diffs since sequence', async () => {
    const app = await storage.getApp('default');
    expect(app).toBeDefined();
    const user = await storage.createUser('user_diff', 'pass');

    await app?.applyChanges(user, [
      {
        table: 'items',
        id: '1',
        op: OperationType.Put,
        data: 'v1',
        timestamp: 10,
        clientId: 'c',
      },
      {
        table: 'items',
        id: '2',
        op: OperationType.Put,
        data: 'v2',
        timestamp: 20,
        clientId: 'c',
      },
      {
        table: 'items',
        id: '3',
        op: OperationType.Put,
        data: 'v3',
        timestamp: 30,
        clientId: 'c',
      },
    ]);

    const diff = await app?.getChangesSince(user, 1);
    expect(diff?.changes).toHaveLength(2);
    expect(diff?.changes.map((c) => c.id)).toEqual(['2', '3']);
    expect(diff?.currentSeq).toBe(3);
  });

  it('should throw an error when createApp is called with an existing appId', async () => {
    await storage.createApp('unique_app');

    await expect(storage.createApp('unique_app')).rejects.toThrow(
      TetherServerError,
    );
    await expect(storage.createApp('unique_app')).rejects.toMatchObject({
      code: TetherServerErrorCode.AlreadyExists,
    });
  });

  it('should throw an error when createTable is called with an existing table name', async () => {
    const app = await storage.createApp('table_test_app');
    await app.createTable('duplicate_table');

    await expect(app.createTable('duplicate_table')).rejects.toThrow(
      TetherServerError,
    );
    await expect(app.createTable('duplicate_table')).rejects.toMatchObject({
      code: TetherServerErrorCode.AlreadyExists,
    });
  });

  it('should throw an error when createUser is called with an existing username', async () => {
    await storage.createUser('duplicate_user', 'pass_initial');

    await expect(
      storage.createUser('duplicate_user', 'pass_new'),
    ).rejects.toThrow(TetherServerError);
    await expect(
      storage.createUser('duplicate_user', 'pass_new'),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.AlreadyExists,
    });

    await expect(
      storage.createUser('  DUPLICATE_USER  ', 'pass_new'),
    ).rejects.toThrow(TetherServerError);
    await expect(
      storage.createUser('  DUPLICATE_USER  ', 'pass_new'),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.AlreadyExists,
    });
  });

  it('should delete a user and cascade their records across multiple apps', async () => {
    const app1 = await storage.getApp('default');
    const app2 = await storage.createApp('second_app');
    await app2.createTable('items');

    const user = await storage.createUser('user_to_delete', 'pass');
    await app1?.applyChanges(user, [
      {
        table: 'todos',
        id: 'td1',
        op: OperationType.Put,
        data: 'app1 data',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);
    await app2.applyChanges(user, [
      {
        table: 'items',
        id: 'it1',
        op: OperationType.Put,
        data: 'app2 data',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    const todosTable = await app1?.getTable('todos');
    const itemsTable = await app2.getTable('items');
    expect(await todosTable?.getRecord(user, 'td1')).toBeDefined();
    expect(await itemsTable?.getRecord(user, 'it1')).toBeDefined();

    const deleted = await user.delete();
    expect(deleted).toBe(true);

    expect(await storage.getUser(user.id)).toBeUndefined();
    expect(await storage.getUserByUsername('user_to_delete')).toBeUndefined();
    expect(await todosTable?.getRecord(user, 'td1')).toBeUndefined();
    expect(await itemsTable?.getRecord(user, 'it1')).toBeUndefined();
  });

  it('should delete an application and cascade its tables and data', async () => {
    const app = await storage.createApp('temporary_app');
    const table = await app.createTable('temp_data');
    const user = await storage.createUser('temp_user', 'pass');

    await table.applyChanges(user, [
      {
        table: 'temp_data',
        id: 'rec1',
        op: OperationType.Put,
        data: 'temporary',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await storage.getApp('temporary_app')).toBeDefined();
    const deleted = await app.delete();
    expect(deleted).toBe(true);
    expect(await storage.getApp('temporary_app')).toBeUndefined();
  });
}
