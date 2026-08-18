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
});
