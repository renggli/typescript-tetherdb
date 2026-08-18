import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteStorage } from '../../../../src/server/storage/sqlite/index.js';
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
});
