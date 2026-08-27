import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../../../src/server/storage/sqlite/index.js';
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

  it('should store users and tables in consolidated SQLite files', async () => {
    const user = await context.backend.createUser('dave', 'davePass');
    const table = await context.backend.createTable('tasks');

    await context.backend.applyChanges(user, [
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
    const tablesFile = path.join(context.dir, 'tables.sqlite');

    expect(await fs.stat(usersFile)).toBeDefined();
    expect(await fs.stat(tablesFile)).toBeDefined();

    const record = await table.getRecord(user, 'task_1');
    expect(record?.data).toEqual({ text: 'SQLite Task' });
  });

  it('should delete tables and clean up their records cleanly', async () => {
    const user = await context.backend.createUser('evelyn', 'evePass');
    const table = await context.backend.createTable('temp_items');

    await context.backend.applyChanges(user, [
      {
        table: 'temp_items',
        id: 'i1',
        op: OperationType.Put,
        data: 'temp',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await context.backend.getTable('temp_items')).toBeDefined();

    await table.delete();
    expect(await context.backend.getTable('temp_items')).toBeUndefined();
  });

  it('should support concurrent writes across multiple storage instances without SQLITE_BUSY locking errors', async () => {
    const user = await context.backend.createUser('concurrent_user', 'pass123');
    const table = await context.backend.createTable('shared_records');

    // Create a second storage instance accessing the same baseDir
    const storage2 = new SqliteStorage({ baseDir: context.dir });

    try {
      const user2 = await storage2.getUser(user.id);
      expect(user2).toBeDefined();
      const table2 = await storage2.getTable('shared_records');
      expect(table2).toBeDefined();
      if (!user2 || !table2) throw new Error('user2 or table2 not found');

      // Interleave multiple concurrent batches across both instances
      const batch1 = context.backend.applyChanges(user, [
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

      const batch2 = storage2.applyChanges(user2, [
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

  it('should execute checkpoint and vacuum across databases', async () => {
    await context.backend.createTable('t1');
    await context.backend.createTable('t2');

    const user1 = await context.backend.createUser('user_one', 'pass');
    const user2 = await context.backend.createUser('user_two', 'pass');

    // Add data to produce WAL activity
    await context.backend.applyChanges(user1, [
      {
        table: 't1',
        id: 'rec1',
        op: OperationType.Put,
        data: { text: 'val1' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);
    await context.backend.applyChanges(user2, [
      {
        table: 't2',
        id: 'rec2',
        op: OperationType.Put,
        data: { text: 'val2' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    // Checkpoint
    const res = await context.backend.checkpoint();
    expect(res.action).toBe('checkpoint');
    expect(res.backend).toBe('sqlite');
    expect(res.affectedCount).toBeGreaterThan(0);

    // Vacuum
    const vac = await context.backend.vacuum();
    expect(vac.action).toBe('vacuum');
    expect(vac.affectedCount).toBeGreaterThan(0);
  });

  it('should prune changelogs with custom or default retention limits', async () => {
    await context.backend.createTable('history');
    const user = await context.backend.createUser('prune_user', 'pass');

    // Create 10 entries
    for (let i = 1; i <= 10; i++) {
      await context.backend.applyChanges(user, [
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
    const pruneRes = await context.backend.prune(3, 'history');
    expect(pruneRes.action).toBe('prune');
    expect(pruneRes.affectedCount).toBe(7);

    // Pruning again with same limit should prune 0 entries
    const pruneRes2 = await context.backend.prune(3, 'history');
    expect(pruneRes2.affectedCount).toBe(0);
  });

  it('should initialize and maintain PRAGMA user_version across SQLite databases', async () => {
    const user = await context.backend.createUser('version_user', 'pass');
    await context.backend.createTable('version_table');

    await context.backend.applyChanges(user, [
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
    const tablesDb = context.backend.getTablesDb().db;

    const usersVer = usersDb.prepare('PRAGMA user_version;').get() as {
      user_version: number;
    };
    const tablesVer = tablesDb.prepare('PRAGMA user_version;').get() as {
      user_version: number;
    };

    expect(usersVer.user_version).toBe(1);
    expect(tablesVer.user_version).toBe(1);
  });

  it('should enforce maxRecords limit when configured', async () => {
    const limitedContext = await sqliteStorage.createBackend({
      maxRecords: 2,
    });
    try {
      const user = await limitedContext.backend.createUser('lim_user', 'pass');
      const table = await limitedContext.backend.createTable('lim_table');

      await limitedContext.backend.applyChanges(user, [
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
      const table = await limitedContext.backend.createTable('lim_table2');

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
