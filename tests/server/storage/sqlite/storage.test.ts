import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../../../src/server/storage/sqlite/index.js';
import { getUserBucket } from '../../../../src/server/validate.js';
import { OperationType } from '../../../../src/shared/types.js';

describe('src/server/storage/sqlite/ (SqliteStorage)', () => {
  let tmpDir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-sqlitestorage-${Math.random().toString(36).substring(2, 10)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = new SqliteStorage({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should store users in users.sqlite, apps in apps.sqlite, and user data in bucketed user SQLite files', async () => {
    const user = await storage.createUser('dave', 'davePass');
    const app = await storage.createApp('todo_app');
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

    const usersFile = path.join(tmpDir, 'users.sqlite');
    const appsFile = path.join(tmpDir, 'apps.sqlite');
    const bucket = getUserBucket(user.id);
    const userDbFile = path.join(
      tmpDir,
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
    const user = await storage.createUser('evelyn', 'evePass');
    const app = await storage.createApp('temp_app');

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

    expect(await storage.getApp('temp_app')).toBeDefined();

    await app.delete();
    expect(await storage.getApp('temp_app')).toBeUndefined();

    const appDir = path.join(tmpDir, 'temp_app');
    let exists = true;
    try {
      await fs.stat(appDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
