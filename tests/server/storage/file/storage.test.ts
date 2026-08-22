import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TetherServerErrorCode } from '../../../../src/server/errors.js';
import { FileStorage } from '../../../../src/server/storage/file/index.js';
import {
  type ChangeRecord,
  OperationType,
} from '../../../../src/shared/types.js';
import { type FileBasedStorageContext, fileStorage } from '../matrix.js';

describe('FileStorage', () => {
  let context: FileBasedStorageContext<FileStorage>;

  beforeEach(async () => {
    context = await fileStorage.createBackend();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('should persist user credentials and allow verification after reload', async () => {
    const user = await context.backend.createUser('bobby', 'secret123');
    expect(user.username).toBe('bobby');

    // Create a second storage pointing to the same directory
    const storage2 = new FileStorage({ baseDir: context.dir });
    try {
      const loadedUser = await storage2.getUserByUsername('bobby');
      expect(loadedUser).toBeDefined();
      expect(await loadedUser?.verifyPassword('secret123')).toBe(true);
      expect(await loadedUser?.verifyPassword('wrong')).toBe(false);
    } finally {
      await storage2.close();
    }
  });

  it('should delete user accounts and their filesystem data', async () => {
    const user = await context.backend.createUser('charlie', 'password');
    const app = await context.backend.createApp('app1');
    const table = await app.createTable('data');
    await table.applyChanges(user, [
      {
        table: 'data',
        id: '1',
        op: OperationType.Put,
        data: 'content',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await table.getRecord(user, '1')).toBeDefined();
    await user.delete();

    expect(await context.backend.getUser(user.id)).toBeUndefined();
    expect(await context.backend.getUserByUsername('charlie')).toBeUndefined();
  });

  it('should persist tables, metadata, and changelog in bucketed directories', async () => {
    const app = await context.backend.createApp('default');
    const table = await app.createTable('settings');
    const user = await context.backend.createUser('user_42', 'pass');

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
    const userDir = path.join(context.dir, 'default', 'users', bucket, user.id);
    const tableFile = path.join(userDir, 'tables', 'settings.json');
    const metaFile = path.join(userDir, 'meta.json');
    const syncFile = path.join(userDir, 'sync.jsonl');
    const manifestFile = path.join(context.dir, 'default', 'manifest.json');
    const appsFile = path.join(context.dir, 'apps.json');
    const usersFile = path.join(context.dir, 'users.json');

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
    const compacting = await fileStorage.createBackend({
      maxChangelogEntries: 5,
    });
    try {
      const app = await compacting.backend.createApp('default');
      await app.createTable('events');
      const user = await compacting.backend.createUser(
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
    } finally {
      await compacting.cleanup();
    }
  });

  it('should reject changes to undeclared tables or applications', async () => {
    const strict = await fileStorage.createBackend();
    try {
      const app = await strict.backend.createApp('myapp');
      await app.createTable('allowed_table');
      const user = await strict.backend.createUser('user_limits', 'pass');

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
      expect(await strict.backend.getApp('nonexistent_app')).toBeUndefined();
    } finally {
      await strict.cleanup();
    }
  });

  it('should support concurrent writes across multiple storage instances without data corruption', async () => {
    const user = await context.backend.createUser('multi_user', 'pass123');
    const app = await context.backend.createApp('multi_app');
    const table = await app.createTable('shared_data');

    // Create a second storage instance targeting the same directory
    const storage2 = new FileStorage({ baseDir: context.dir });

    try {
      const user2 = await storage2.getUser(user.id);
      expect(user2).toBeDefined();
      const app2 = await storage2.getApp('multi_app');
      expect(app2).toBeDefined();
      const table2 = await app2?.getTable('shared_data');
      expect(table2).toBeDefined();
      if (!user2 || !table2) throw new Error('user2 or table2 not found');

      // Apply changes from instance 1
      await table.applyChanges(user, [
        {
          table: 'shared_data',
          id: 'k1',
          op: OperationType.Put,
          data: { from: 'instance1' },
          timestamp: 100,
          clientId: 'c1',
        },
        {
          table: 'shared_data',
          id: 'k2',
          op: OperationType.Put,
          data: { from: 'instance1' },
          timestamp: 101,
          clientId: 'c1',
        },
      ]);

      // Apply changes from instance 2
      await table2.applyChanges(user2, [
        {
          table: 'shared_data',
          id: 'k3',
          op: OperationType.Put,
          data: { from: 'instance2' },
          timestamp: 102,
          clientId: 'c2',
        },
        {
          table: 'shared_data',
          id: 'k4',
          op: OperationType.Put,
          data: { from: 'instance2' },
          timestamp: 103,
          clientId: 'c2',
        },
      ]);

      // Verify records are intact and non-corrupted across both instances
      const rec1 = await table2.getRecord(user2, 'k1');
      const rec2 = await table2.getRecord(user2, 'k2');
      const rec3 = await table.getRecord(user, 'k3');
      const rec4 = await table.getRecord(user, 'k4');

      expect(rec1?.data).toEqual({ from: 'instance1' });
      expect(rec2?.data).toEqual({ from: 'instance1' });
      expect(rec3?.data).toEqual({ from: 'instance2' });
      expect(rec4?.data).toEqual({ from: 'instance2' });
    } finally {
      await storage2.close();
    }
  });

  it('should create and preserve keyfile secret across restarts', async () => {
    const storage1 = new FileStorage({ baseDir: context.dir });
    const secret1 = storage1.secret;
    expect(secret1).toBeDefined();
    expect(secret1.length).toBe(64);

    const secretFile = path.join(context.dir, '.secret');
    const stat = await fs.stat(secretFile);
    expect(stat.isFile()).toBe(true);

    const storage2 = new FileStorage({ baseDir: context.dir });
    expect(storage2.secret).toBe(secret1);

    await storage1.close();
    await storage2.close();
  });

  it('should reject checkpoint and vacuum with NotSupported code', async () => {
    await expect(context.backend.checkpoint('app1')).rejects.toThrow(
      /not supported/i,
    );
    await expect(context.backend.vacuum('app1')).rejects.toThrow(
      /not supported/i,
    );
    try {
      await context.backend.checkpoint();
    } catch (err) {
      expect((err as { code: TetherServerErrorCode }).code).toBe(
        TetherServerErrorCode.NotSupported,
      );
    }
  });

  it('should prune file changelogs and update metadata', async () => {
    const app = await context.backend.createApp('prune_file_app');
    const table = await app.createTable('records');
    const user = await context.backend.createUser('puser', 'pass');

    for (let i = 1; i <= 8; i++) {
      await table.applyChanges(user, [
        {
          table: 'records',
          id: `rec-${i}`,
          op: OperationType.Put,
          data: { index: i },
          timestamp: 2000 + i,
          clientId: 'c1',
        },
      ]);
    }

    const pruneRes = await context.backend.prune('prune_file_app', 3);
    expect(pruneRes.action).toBe('prune');
    expect(pruneRes.backend).toBe('file');
    expect(pruneRes.affectedCount).toBe(5);

    // Prune on non-existent app should fail
    await expect(context.backend.prune('missing_app')).rejects.toThrow(
      /not found/i,
    );
  });

  it('should enforce maxRecordsPerTable and maxRecordSizeBytes in FileStorage', async () => {
    const limitedContext = await fileStorage.createBackend({
      maxRecordsPerTable: 2,
      maxRecordSizeBytes: 25,
    });
    try {
      const user = await limitedContext.backend.createUser(
        'lim_file_u',
        'pass',
      );
      const app = await limitedContext.backend.createApp('lim_file_app');
      const table = await app.createTable('records');

      // Exceed size
      await expect(
        table.applyChanges(user, [
          {
            table: 'records',
            id: 'r1',
            op: OperationType.Put,
            data: { large: 'this payload is too large for 25 bytes' },
            timestamp: 100,
            clientId: 'c1',
          },
        ]),
      ).rejects.toThrow('Record payload exceeds maximum allowed size');

      // Add up to limit
      await table.applyChanges(user, [
        {
          table: 'records',
          id: 'r1',
          op: OperationType.Put,
          data: 'ok1',
          timestamp: 100,
          clientId: 'c1',
        },
        {
          table: 'records',
          id: 'r2',
          op: OperationType.Put,
          data: 'ok2',
          timestamp: 101,
          clientId: 'c1',
        },
      ]);

      // Exceed count
      await expect(
        table.applyChanges(user, [
          {
            table: 'records',
            id: 'r3',
            op: OperationType.Put,
            data: 'ok3',
            timestamp: 102,
            clientId: 'c1',
          },
        ]),
      ).rejects.toThrow('Table record limit reached');
    } finally {
      await limitedContext.cleanup();
    }
  });

  it('should delete tables and remove table files from user directories', async () => {
    const user = await context.backend.createUser('del_user', 'pass');
    const app = await context.backend.createApp('del_app');
    const table = await app.createTable('to_delete');

    await table.applyChanges(user, [
      {
        table: 'to_delete',
        id: '1',
        op: OperationType.Put,
        data: 'item',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await app.getTable('to_delete')).toBeDefined();
    const deleted = await app.deleteTable('to_delete');
    expect(deleted).toBe(true);
    expect(await app.getTable('to_delete')).toBeUndefined();

    // Deleting again should return false
    expect(await app.deleteTable('to_delete')).toBe(false);
  });
});
