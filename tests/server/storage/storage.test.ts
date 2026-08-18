import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import type { Storage } from '../../../src/server/storage/index.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';
import { type StorageContext, storageDescriptors } from './matrix.js';

describe.each(storageDescriptors)('$name', (descriptor) => {
  let context: StorageContext;

  beforeEach(async () => {
    context = await descriptor.createBackend();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  runStorageTestSuite(() => context.backend);
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
