import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../../../src/server/storage/sqlite/index.js';
import { getUserBucket } from '../../../../src/server/validate.js';
import { OperationType } from '../../../../src/shared/types.js';
import { type FileBasedStorageContext, sqliteStorage } from '../matrix.js';

describe('SqliteStorage', () => {
  let context: FileBasedStorageContext<SqliteStorage>;

  beforeEach(async () => {
    context = await sqliteStorage.createBackend();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('should store users, apps, and user data in bucketed SQLite files', async () => {
    const user = await context.backend.createUser('dave', 'davePass');
    const app = await context.backend.createApp('todo_app');
    const table = await app.createTable('tasks');

    await table.applyChanges(user, [
      {
        table: 'tasks',
        id: 'task_1',
        op: OperationType.Put,
        data: { text: 'SQLite Task' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    const usersFile = path.join(context.dir, 'users.sqlite');
    const appsFile = path.join(context.dir, 'apps.sqlite');
    const bucket = getUserBucket(user.id);
    const userDbFile = path.join(
      context.dir,
      'todo_app',
      bucket,
      `${user.id}.sqlite`,
    );

    expect(await fs.stat(usersFile)).toBeDefined();
    expect(await fs.stat(appsFile)).toBeDefined();
    expect(await fs.stat(userDbFile)).toBeDefined();

    const record = await table.getRecord(user, 'task_1');
    expect(record?.data).toEqual({ text: 'SQLite Task' });
  });

  it('should delete applications and their SQLite files cleanly', async () => {
    const user = await context.backend.createUser('evelyn', 'evePass');
    const app = await context.backend.createApp('temp_app');

    const table = await app.createTable('items');

    await table.applyChanges(user, [
      {
        table: 'items',
        id: 'i1',
        op: OperationType.Put,
        data: 'temp',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await context.backend.getApp('temp_app')).toBeDefined();

    await app.delete();
    expect(await context.backend.getApp('temp_app')).toBeUndefined();

    const appDir = path.join(context.dir, 'temp_app');
    let exists = true;
    try {
      await fs.stat(appDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('should support concurrent writes across multiple storage instances without SQLITE_BUSY locking errors', async () => {
    const user = await context.backend.createUser('concurrent_user', 'pass123');
    const app = await context.backend.createApp('concurrent_app');
    const table = await app.createTable('shared_records');

    // Create a second storage instance accessing the same baseDir
    const storage2 = new SqliteStorage({ baseDir: context.dir });

    try {
      const user2 = await storage2.getUser(user.id);
      expect(user2).toBeDefined();
      const app2 = await storage2.getApp('concurrent_app');
      expect(app2).toBeDefined();
      const table2 = await app2?.getTable('shared_records');
      expect(table2).toBeDefined();
      if (!user2 || !table2) throw new Error('user2 or table2 not found');

      // Interleave multiple concurrent batches across both instances
      const batch1 = table.applyChanges(user, [
        {
          table: 'shared_records',
          id: 'item-1',
          op: OperationType.Put,
          data: { writer: 'instance-1' },
          timestamp: 100,
          clientId: 'c1',
        },
        {
          table: 'shared_records',
          id: 'item-2',
          op: OperationType.Put,
          data: { writer: 'instance-1' },
          timestamp: 101,
          clientId: 'c1',
        },
      ]);

      const batch2 = table2.applyChanges(user2, [
        {
          table: 'shared_records',
          id: 'item-3',
          op: OperationType.Put,
          data: { writer: 'instance-2' },
          timestamp: 102,
          clientId: 'c2',
        },
        {
          table: 'shared_records',
          id: 'item-4',
          op: OperationType.Put,
          data: { writer: 'instance-2' },
          timestamp: 103,
          clientId: 'c2',
        },
      ]);

      const [res1, res2] = await Promise.all([batch1, batch2]);
      expect(res1.applied).toHaveLength(2);
      expect(res2.applied).toHaveLength(2);

      // Verify all items are readable
      const rec1 = await table2.getRecord(user2, 'item-1');
      const rec4 = await table.getRecord(user, 'item-4');
      expect(rec1?.data).toEqual({ writer: 'instance-1' });
      expect(rec4?.data).toEqual({ writer: 'instance-2' });
    } finally {
      await storage2.close();
    }
  });

  it('should enforce maxOpenDatabases limit with LRU eviction preventing file descriptor and memory leaks', async () => {
    const lruStorage = new SqliteStorage({
      baseDir: context.dir,
      maxOpenDatabases: 3,
    });

    try {
      const app = await lruStorage.createApp('lru_app');
      const table = await app.createTable('records');

      // Create 6 users
      const users = await Promise.all([
        lruStorage.createUser('user_1', 'pass'),
        lruStorage.createUser('user_2', 'pass'),
        lruStorage.createUser('user_3', 'pass'),
        lruStorage.createUser('user_4', 'pass'),
        lruStorage.createUser('user_5', 'pass'),
        lruStorage.createUser('user_6', 'pass'),
      ]);

      // Write data for all 6 users (which will trigger evictions to stay <= 3 open handles)
      for (const [idx, user] of users.entries()) {
        await table.applyChanges(user, [
          {
            table: 'records',
            id: `doc-${idx}`,
            op: OperationType.Put,
            data: { userIndex: idx },
            timestamp: 100 + idx,
            clientId: 'c1',
          },
        ]);
      }

      // Verify that user 1 (evicted earlier) transparently reloads without data loss
      const firstUserDoc = await table.getRecord(users[0], 'doc-0');
      expect(firstUserDoc?.data).toEqual({ userIndex: 0 });

      // Verify all other users are intact
      for (const [idx, user] of users.entries()) {
        const doc = await table.getRecord(user, `doc-${idx}`);
        expect(doc?.data).toEqual({ userIndex: idx });
      }
    } finally {
      await lruStorage.close();
    }
  });

  it('should create and preserve keyfile secret across restarts', async () => {
    const storage1 = new SqliteStorage({ baseDir: context.dir });
    const secret1 = storage1.secret;
    expect(secret1).toBeDefined();
    expect(secret1.length).toBe(64);

    const secretFile = path.join(context.dir, '.secret');
    const stat = await fs.stat(secretFile);
    expect(stat.isFile()).toBe(true);

    const storage2 = new SqliteStorage({ baseDir: context.dir });
    expect(storage2.secret).toBe(secret1);

    await storage1.close();
    await storage2.close();
  });

  it('should execute checkpoint and vacuum across single app or all apps', async () => {
    const app1 = await context.backend.createApp('app_one');
    const app2 = await context.backend.createApp('app_two');
    const table1 = await app1.createTable('t1');
    const table2 = await app2.createTable('t2');

    const user1 = await context.backend.createUser('user_one', 'pass');
    const user2 = await context.backend.createUser('user_two', 'pass');

    // Add and delete data to produce WAL activity and fragmentation
    await table1.applyChanges(user1, [
      {
        table: 't1',
        id: 'rec1',
        op: OperationType.Put,
        data: { text: 'val1' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);
    await table2.applyChanges(user2, [
      {
        table: 't2',
        id: 'rec2',
        op: OperationType.Put,
        data: { text: 'val2' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    // Checkpoint specific app
    const resApp1 = await context.backend.checkpoint('app_one');
    expect(resApp1.action).toBe('checkpoint');
    expect(resApp1.backend).toBe('sqlite');
    expect(resApp1.appId).toBe('app_one');
    expect(resApp1.affectedCount).toBeGreaterThan(0);

    // Checkpoint all apps
    const resAll = await context.backend.checkpoint();
    expect(resAll.action).toBe('checkpoint');
    expect(resAll.affectedCount).toBeGreaterThanOrEqual(
      resApp1.affectedCount ?? 0,
    );

    // Vacuum specific app
    const vacApp1 = await context.backend.vacuum('app_one');
    expect(vacApp1.action).toBe('vacuum');
    expect(vacApp1.affectedCount).toBeGreaterThan(0);

    // Vacuum all apps
    const vacAll = await context.backend.vacuum();
    expect(vacAll.action).toBe('vacuum');
    expect(vacAll.affectedCount).toBeGreaterThanOrEqual(
      vacApp1.affectedCount ?? 0,
    );

    // Error on non-existent app
    await expect(context.backend.checkpoint('nonexistent_app')).rejects.toThrow(
      /not found/i,
    );
    await expect(context.backend.vacuum('nonexistent_app')).rejects.toThrow(
      /not found/i,
    );
  });

  it('should prune changelogs with custom or default retention limits', async () => {
    const app = await context.backend.createApp('prune_app');
    const table = await app.createTable('history');
    const user = await context.backend.createUser('prune_user', 'pass');

    // Create 10 entries
    for (let i = 1; i <= 10; i++) {
      await table.applyChanges(user, [
        {
          table: 'history',
          id: `h_${i}`,
          op: OperationType.Put,
          data: { step: i },
          timestamp: 1000 + i,
          clientId: 'c1',
        },
      ]);
    }

    // Prune keeping 3
    const pruneRes = await context.backend.prune('prune_app', 3);
    expect(pruneRes.action).toBe('prune');
    expect(pruneRes.affectedCount).toBe(7);

    // Pruning again with same limit should prune 0 entries
    const pruneRes2 = await context.backend.prune('prune_app', 3);
    expect(pruneRes2.affectedCount).toBe(0);

    // Error on non-existent app
    await expect(context.backend.prune('missing_app')).rejects.toThrow(
      /not found/i,
    );
  });

  it('should initialize and maintain PRAGMA user_version across all SQLite databases', async () => {
    const user = await context.backend.createUser('version_user', 'pass');
    const app = await context.backend.createApp('version_app');
    const table = await app.createTable('version_table');

    await table.applyChanges(user, [
      {
        table: 'version_table',
        id: 'rec_1',
        op: OperationType.Put,
        data: { test: true },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    const usersDb = context.backend.getUsersDb().db;
    const appsDb = context.backend.getAppsDb().db;
    const userAppDb = context.backend.getUserAppDb('version_app', user.id).db;

    const usersVer = usersDb.prepare('PRAGMA user_version;').get() as {
      user_version: number;
    };
    const appsVer = appsDb.prepare('PRAGMA user_version;').get() as {
      user_version: number;
    };
    const userAppVer = userAppDb.prepare('PRAGMA user_version;').get() as {
      user_version: number;
    };

    expect(usersVer.user_version).toBe(1);
    expect(appsVer.user_version).toBe(1);
    expect(userAppVer.user_version).toBe(1);
  });

  it('should enforce maxRecordsPerTable limit when configured', async () => {
    const limitedContext = await sqliteStorage.createBackend({
      maxRecordsPerTable: 2,
    });
    try {
      const user = await limitedContext.backend.createUser('lim_user', 'pass');
      const app = await limitedContext.backend.createApp('lim_app');
      const table = await app.createTable('lim_table');

      await table.applyChanges(user, [
        {
          table: 'lim_table',
          id: 'r1',
          op: OperationType.Put,
          data: 'data1',
          timestamp: 100,
          clientId: 'c1',
        },
        {
          table: 'lim_table',
          id: 'r2',
          op: OperationType.Put,
          data: 'data2',
          timestamp: 101,
          clientId: 'c1',
        },
      ]);

      await expect(
        table.applyChanges(user, [
          {
            table: 'lim_table',
            id: 'r3',
            op: OperationType.Put,
            data: 'data3',
            timestamp: 102,
            clientId: 'c1',
          },
        ]),
      ).rejects.toThrow('Table record limit reached');
    } finally {
      await limitedContext.cleanup();
    }
  });

  it('should enforce maxRecordSizeBytes limit when configured', async () => {
    const limitedContext = await sqliteStorage.createBackend({
      maxRecordSizeBytes: 20,
    });
    try {
      const user = await limitedContext.backend.createUser('lim_user2', 'pass');
      const app = await limitedContext.backend.createApp('lim_app2');
      const table = await app.createTable('lim_table2');

      await expect(
        table.applyChanges(user, [
          {
            table: 'lim_table2',
            id: 'r1',
            op: OperationType.Put,
            data: { longText: 'this is too long for the 20 bytes limit' },
            timestamp: 100,
            clientId: 'c1',
          },
        ]),
      ).rejects.toThrow('Record payload exceeds maximum allowed size');
    } finally {
      await limitedContext.cleanup();
    }
  });
});
