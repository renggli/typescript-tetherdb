import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../../../src/server/storage/sqlite/index.js';
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

  it('should store auth in auth.sqlite and apps in separate SQLite files', async () => {
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

    const authFile = path.join(tmpDir, 'auth.sqlite');
    const appFile = path.join(tmpDir, 'todo_app.sqlite');

    expect(await fs.stat(authFile)).toBeDefined();
    expect(await fs.stat(appFile)).toBeDefined();

    const record = await table.getRecord(user, 'task_1');
    expect(record?.data).toEqual({ text: 'SQLite Task' });
  });

  it('should delete applications and their SQLite files cleanly', async () => {
    const app = await storage.createApp('temp_app');
    await app.createTable('items');
    expect(await storage.getApp('temp_app')).toBeDefined();

    await app.delete();
    expect(await storage.getApp('temp_app')).toBeUndefined();
  });
});
