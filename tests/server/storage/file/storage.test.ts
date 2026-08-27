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
    const table = await context.backend.createTable('data');
    await context.backend.applyChanges(user, [
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
    const table = await context.backend.createTable('settings');
    const user = await context.backend.createUser('user_42', 'pass');

    const change: ChangeRecord = {
      table: 'settings',
      id: 'theme',
      op: OperationType.Put,
      data: { dark: true },
      timestamp: Date.now(),
      clientId: 'client-1',
    };

    await context.backend.applyChanges(user, [change]);

    const bucket = user.id.slice(0, 2);
    const userDir = path.join(context.dir, 'users', bucket, user.id);
    const tableFile = path.join(userDir, 'settings', 'records.json');
    const metaFile = path.join(userDir, 'meta.json');
    const syncFile = path.join(userDir, 'sync.jsonl');
    const tablesFile = path.join(context.dir, 'tables.json');
    const usersFile = path.join(context.dir, 'users.json');

    expect(await fs.stat(tablesFile)).toBeDefined();
    expect(await fs.stat(usersFile)).toBeDefined();
    expect(await fs.stat(tableFile)).toBeDefined();
    expect(await fs.stat(syncFile)).toBeDefined();

    const tablesContent = JSON.parse(
      await fs.readFile(tablesFile, 'utf-8'),
    ) as Array<{ name: string }>;
    expect(tablesContent.some((t) => t.name === 'settings')).toBe(true);

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

  it('should compact changelog beyond maxHistoryEntries and flag requiresSnapshot', async () => {
    const compacting = await fileStorage.createBackend({
      maxHistoryEntries: 5,
    });
    try {
      await compacting.backend.createTable('events');
      const user = await compacting.backend.createUser(
        'user_compaction',
        'pass',
      );

      // Apply 10 changes sequentially
      for (let i = 1; i <= 10; i++) {
        await compacting.backend.applyChanges(user, [
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

      // Prune down to 5
      await compacting.backend.prune(5);

      // Asking for seq 1 (which was pruned) should return requiresSnapshot: true
      const oldDiff = await compacting.backend.getChangesSince(user, 1);
      expect(oldDiff.requiresSnapshot).toBe(true);

      // Asking for recent seq 7 (retained in window) should return delta diff
      const recentDiff = await compacting.backend.getChangesSince(user, 7);
      expect(recentDiff.requiresSnapshot).toBe(false);
      expect(recentDiff.changes).toHaveLength(3);
    } finally {
      await compacting.cleanup();
    }
  });

  it('should reject changes to undeclared tables', async () => {
    const strict = await fileStorage.createBackend();
    try {
      await strict.backend.createTable('allowed_table');
      const user = await strict.backend.createUser('user_limits', 'pass');

      // Disallowed table
      await expect(
        strict.backend.applyChanges(user, [
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
    } finally {
      await strict.cleanup();
    }
  });

  it('should support concurrent writes across multiple storage instances without data corruption', async () => {
    const user = await context.backend.createUser('multi_user', 'pass123');
    await context.backend.createTable('shared_data');

    // Create a second storage instance targeting the same directory
    const storage2 = new FileStorage({ baseDir: context.dir });

    try {
      const user2 = await storage2.getUser(user.id);
      expect(user2).toBeDefined();
      const table2 = await storage2.getTable('shared_data');
      expect(table2).toBeDefined();
      if (!user2 || !table2) throw new Error('user2 or table2 not found');

      // Apply changes from instance 1
      await context.backend.applyChanges(user, [
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
      await storage2.applyChanges(user2, [
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
      const rec3 = await table2.getRecord(user2, 'k3');
      const rec4 = await table2.getRecord(user2, 'k4');

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
    await expect(context.backend.checkpoint('t1')).rejects.toThrow(
      /not supported/i,
    );
    await expect(context.backend.vacuum()).rejects.toThrow(/not supported/i);
    try {
      await context.backend.checkpoint();
    } catch (err) {
      expect((err as { code: TetherServerErrorCode }).code).toBe(
        TetherServerErrorCode.NotSupported,
      );
    }
  });

  it('should prune file changelogs and update metadata', async () => {
    await context.backend.createTable('records');
    const user = await context.backend.createUser('puser', 'pass');

    for (let i = 1; i <= 8; i++) {
      await context.backend.applyChanges(user, [
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

    const pruneRes = await context.backend.prune(3, 'records');
    expect(pruneRes.action).toBe('prune');
    expect(pruneRes.backend).toBe('file');
    expect(pruneRes.affectedCount).toBe(5);
  });

  it('should enforce maxRecords and maxRecordSizeBytes in FileStorage', async () => {
    const limitedContext = await fileStorage.createBackend({
      maxRecords: 2,
      maxRecordSizeBytes: 25,
    });
    try {
      const user = await limitedContext.backend.createUser(
        'lim_file_u',
        'pass',
      );
      await limitedContext.backend.createTable('records');

      // Exceed size
      await expect(
        limitedContext.backend.applyChanges(user, [
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
      await limitedContext.backend.applyChanges(user, [
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
        limitedContext.backend.applyChanges(user, [
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
    await context.backend.createTable('to_delete');

    await context.backend.applyChanges(user, [
      {
        table: 'to_delete',
        id: '1',
        op: OperationType.Put,
        data: 'item',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    const tableToDelete = await context.backend.getTable('to_delete');
    expect(tableToDelete).toBeDefined();
    const deleted = await tableToDelete?.delete();
    expect(deleted).toBe(true);
    expect(await context.backend.getTable('to_delete')).toBeUndefined();
  });
});
