import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import type { Storage } from '../../../src/server/storage/storage.js';
import {
  type ChangeRecord,
  OperationType,
  Permission,
} from '../../../src/shared/types.js';
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
    await storage.createTable('todos');
    await storage.createTable('notes');
    await storage.createTable('items');
  });

  it('should create and authenticate users directly through UserStorage', async () => {
    const user = await storage.createUser('alice', 'password123');
    expect(user.userId).toBeDefined();
    expect(user.userName).toBe('alice');

    expect(await user.verifyPassword('password123')).toBe(true);
    expect(await user.verifyPassword('  password123  ')).toBe(true);
    expect(await user.verifyPassword('wrongPassword')).toBe(false);
    expect(await user.verifyPassword('')).toBe(false);

    const token = await user.createToken();
    expect(await user.verifyToken(token)).toBe(true);

    const retrievedUser = await storage.getUserByToken(token);
    expect(retrievedUser?.userId).toBe(user.userId);
    expect(retrievedUser?.userName).toBe('alice');

    const byUsername = await storage.getUserByUserName('  ALICE  ');
    expect(byUsername?.userId).toBe(user.userId);

    const allUsers = await storage.getUsers();
    expect(allUsers.some((u) => u.userId === user.userId)).toBe(true);
  });

  it('should apply changes and assign sequential numbers', async () => {
    const todosTable = await storage.getTable('todos');
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

    const res = await storage.applyChanges(user, changes);
    expect(res.applied).toHaveLength(2);
    expect(res.newSeq).toBe(2);

    const record = await todosTable?.getRecord(user, 't1');
    expect(record?.data).toEqual({ title: 'Item 1' });

    const all = await todosTable?.getAllRecords(user);
    expect(all).toHaveLength(2);

    expect(await storage.getCurrentSeq(user)).toBe(2);
  });

  it('should isolate data between different users on user-private tables', async () => {
    const notesTable = await storage.getTable('notes');
    expect(notesTable).toBeDefined();

    const userA = await storage.createUser('user_a', 'pass');
    const userB = await storage.createUser('user_b', 'pass');

    await storage.applyChanges(userA, [
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

  it('should share data between users on public-read-write tables', async () => {
    const sharedTable = await storage.createTable('public_board', {
      permissions: {
        read: Permission.Everybody,
        create: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });
    expect(sharedTable).toBeDefined();

    const userA = await storage.createUser('user_pub_a', 'pass');
    const userB = await storage.createUser('user_pub_b', 'pass');

    await storage.applyChanges(userA, [
      {
        table: 'public_board',
        id: 'post1',
        op: OperationType.Put,
        data: { text: 'Hello everyone' },
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const recordForA = await sharedTable.getRecord(userA, 'post1');
    const recordForB = await sharedTable.getRecord(userB, 'post1');
    expect(recordForA?.data).toEqual({ text: 'Hello everyone' });
    expect(recordForB?.data).toEqual({ text: 'Hello everyone' });
  });

  it('should handle diffs since sequence', async () => {
    const user = await storage.createUser('user_diff', 'pass');

    await storage.applyChanges(user, [
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

    const diff = await storage.getChangesSince(user, 1);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((c) => c.id)).toEqual(['2', '3']);
    expect(diff.currentSeq).toBe(3);

    // Apply Delete operation and verify in changelog
    await storage.applyChanges(user, [
      {
        table: 'items',
        id: '2',
        op: OperationType.Delete,
        timestamp: 40,
        clientId: 'c',
      },
    ]);

    const diffWithDelete = await storage.getChangesSince(user, 3);
    expect(diffWithDelete.changes).toHaveLength(1);
    expect(diffWithDelete.changes[0].op).toBe(OperationType.Delete);
    expect(diffWithDelete.changes[0].data).toBeUndefined();

    // fromSeq > currentSeq requires snapshot
    const invalidFutureSeq = await storage.getChangesSince(user, 9999);
    expect(invalidFutureSeq.requiresSnapshot).toBe(true);
    expect(invalidFutureSeq.changes).toHaveLength(0);
  });

  it('should throw an error when createTable is called with an existing table name', async () => {
    await storage.createTable('duplicate_table');

    await expect(storage.createTable('duplicate_table')).rejects.toThrow(
      TetherServerError,
    );
    await expect(storage.createTable('duplicate_table')).rejects.toMatchObject({
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

  it('should delete a user and cascade their records across tables', async () => {
    const user = await storage.createUser('user_to_delete', 'pass');
    await storage.applyChanges(user, [
      {
        table: 'todos',
        id: 'td1',
        op: OperationType.Put,
        data: 'app1 data',
        timestamp: 100,
        clientId: 'c1',
      },
      {
        table: 'notes',
        id: 'nt1',
        op: OperationType.Put,
        data: 'notes data',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    const todosTable = await storage.getTable('todos');
    const notesTable = await storage.getTable('notes');
    expect(await todosTable?.getRecord(user, 'td1')).toBeDefined();
    expect(await notesTable?.getRecord(user, 'nt1')).toBeDefined();

    const deleted = await user.delete();
    expect(deleted).toBe(true);

    expect(await storage.getUser(user.userId)).toBeUndefined();
    expect(await storage.getUserByUserName('user_to_delete')).toBeUndefined();
    expect(await todosTable?.getRecord(user, 'td1')).toBeUndefined();
    expect(await notesTable?.getRecord(user, 'nt1')).toBeUndefined();

    // Directly test storage.deleteUser
    const user2 = await storage.createUser('user_to_delete_direct', 'pass');
    expect(await storage.deleteUser(user2.userId)).toBe(true);
    expect(await storage.deleteUser(user2.userId)).toBe(false);
  });

  it('should insert initial rows with author userName', async () => {
    const user = await storage.createUser('seed_author', 'pass');
    const table = await storage.createTable('seeded_table');

    const count = await table.insertRows?.([
      { id: 's1', data: { title: 'First' }, userName: 'seed_author' },
      { id: 's2', data: { title: 'Second' }, userName: 'non_existent_author' },
      { id: 's3', data: { title: 'Third' } },
    ]);

    expect(count).toBe(3);
    const rec1 = await table.getRecord(user, 's1');
    expect(rec1?.data).toEqual({ title: 'First' });
    expect(rec1?.userName).toBe(user.userName);
  });

  it('should delete a table via table.delete and clean up all data', async () => {
    const user = await storage.createUser('table_del_user', 'pass');
    const table = await storage.createTable('to_be_deleted');

    // Put records into the table
    await storage.applyChanges(user, [
      {
        table: 'to_be_deleted',
        id: 'del_1',
        op: OperationType.Put,
        data: { text: 'To delete' },
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    expect(await table.getRecord(user, 'del_1')).toBeDefined();
    expect(
      (await storage.getTables()).some((t) => t.name === 'to_be_deleted'),
    ).toBe(true);

    // Delete table via table.delete()
    const deleted = await table.delete();
    expect(deleted).toBe(true);

    // Verify it is no longer in getTables()
    expect(
      (await storage.getTables()).some((t) => t.name === 'to_be_deleted'),
    ).toBe(false);
    expect(await storage.getTable('to_be_deleted')).toBeUndefined();

    // Deleting again should return false
    expect(await table.delete()).toBe(false);

    // Recreate deleted table and verify fresh empty state
    const recreated = await storage.createTable('to_be_deleted');
    expect(await recreated.getRecord(user, 'del_1')).toBeUndefined();
    expect(await recreated.getAllRecords(user)).toHaveLength(0);
  });

  it('should return storage status and metadata', async () => {
    const status = await storage.getStatus();
    expect(status.type).toBeDefined();
    expect(status.tablesCount).toBeGreaterThanOrEqual(3);
  });

  it('should handle checkpoint and vacuum or throw NotSupported', async () => {
    const isSqlite = (await storage.getStatus()).type === 'sqlite';

    if (isSqlite) {
      const checkpointRes = await storage.checkpoint();
      expect(checkpointRes.action).toBe('checkpoint');
      expect(checkpointRes.affectedCount).toBeGreaterThan(0);

      const vacuumRes = await storage.vacuum();
      expect(vacuumRes.action).toBe('vacuum');
      expect(vacuumRes.affectedCount).toBeGreaterThan(0);
    } else {
      await expect(storage.checkpoint()).rejects.toThrow(/not supported/i);
      await expect(storage.vacuum()).rejects.toThrow(/not supported/i);
    }
  });

  it('should prune changelogs across storage backends', async () => {
    const user = await storage.createUser('prune_user', 'password');
    const table = await storage.getTable('todos');
    expect(table).toBeDefined();

    // Apply 5 changes
    for (let i = 1; i <= 5; i++) {
      await storage.applyChanges(user, [
        {
          table: 'todos',
          id: `todo_${i}`,
          op: OperationType.Put,
          data: { title: `Task ${i}` },
          timestamp: 1000 + i,
          clientId: 'c1',
        },
      ]);
    }

    // Prune keeping 2
    const pruneRes = await storage.prune(2);
    expect(pruneRes.action).toBe('prune');
    expect(pruneRes.affectedCount).toBeGreaterThanOrEqual(3);
  });

  it('should reject mutations with timestamps far in the future', async () => {
    const user = await storage.createUser('time_user', 'password');

    const farFuture = Date.now() + 10 * 60 * 1000; // 10 minutes in future
    await expect(
      storage.applyChanges(user, [
        {
          table: 'todos',
          id: 'future-task',
          op: OperationType.Put,
          data: { title: 'Poison' },
          timestamp: farFuture,
          clientId: 'malicious-client',
        },
      ]),
    ).rejects.toThrow('Timestamp drift exceeds maximum allowable threshold');
  });

  it('should reject change records with invalid or missing operation type', async () => {
    const user = await storage.createUser('op_user', 'password');

    const invalidChange = {
      table: 'todos',
      id: 'invalid-op-task',
      op: 'invalid_operation' as unknown as OperationType,
      data: { title: 'Invalid' },
      timestamp: Date.now(),
    };

    await expect(storage.applyChanges(user, [invalidChange])).rejects.toThrow(
      /Invalid change operation/,
    );
  });

  it('should require snapshot if requested sequence is older than minSeq after pruning', async () => {
    const user = await storage.createUser('snap_user', 'password');
    for (let i = 1; i <= 6; i++) {
      await storage.applyChanges(user, [
        {
          table: 'todos',
          id: `task_${i}`,
          op: OperationType.Put,
          data: { title: `Task ${i}` },
          timestamp: 1000 + i,
          clientId: 'c1',
        },
      ]);
    }
    await storage.prune(2);
    const res = await storage.getChangesSince(user, 1);
    expect(res.requiresSnapshot).toBe(true);
    expect(res.changes).toHaveLength(0);
  });

  it('should invalidate session tokens when password changes or user is deleted', async () => {
    const user = await storage.createUser('token_user', 'old_password');
    const token = await user.createToken();
    expect(await storage.getUserByToken(token)).toBeDefined();
    await user.changePassword('new_password');
    expect(await storage.getUserByToken(token)).toBeUndefined();
    const token2 = await user.createToken();
    await user.delete();
    expect(await storage.getUserByToken(token2)).toBeUndefined();
  });
}
