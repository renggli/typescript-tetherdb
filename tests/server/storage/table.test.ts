import { describe, expect, it } from 'vitest';
import type { InternalStoredRecord } from '../../../src/server/security/types.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { OperationType, Permission } from '../../../src/shared/types.js';

describe('Table', () => {
  it('evaluates CRUD permissions on table and records', async () => {
    const storage = new MemoryStorage();
    const alice = await storage.createUser('alice', 'pass123');
    const bob = await storage.createUser('bob', 'pass123');

    const table = await storage.createTable('tasks', {
      permissions: {
        create: Permission.Authenticated,
        read: Permission.Everybody,
        update: Permission.Owner,
        delete: Permission.Owner,
      },
    });

    // Create
    expect(table.canCreate(undefined)).toBe(false);
    expect(table.canCreate(alice)).toBe(true);

    // Read
    expect(table.canRead(undefined)).toBe(true);
    expect(table.canRead(alice)).toBe(true);

    // Update
    expect(
      table.canUpdate(alice, { userId: alice.userId } as InternalStoredRecord),
    ).toBe(true);
    expect(
      table.canUpdate(bob, { userId: alice.userId } as InternalStoredRecord),
    ).toBe(false);
    expect(
      table.canUpdate(undefined, {
        userId: alice.userId,
      } as InternalStoredRecord),
    ).toBe(false);

    // Delete
    expect(
      table.canDelete(alice, { userId: alice.userId } as InternalStoredRecord),
    ).toBe(true);
    expect(
      table.canDelete(bob, { userId: alice.userId } as InternalStoredRecord),
    ).toBe(false);
    expect(
      table.canDelete(undefined, {
        userId: alice.userId,
      } as InternalStoredRecord),
    ).toBe(false);
  });

  it('updates settings dynamically', async () => {
    const storage = new MemoryStorage();
    const table = await storage.createTable('docs');

    expect(table.settings.permissions.read).toBe(Permission.Owner);
    await table.updateSettings({
      permissions: { read: Permission.Everybody },
      maxRecords: 50,
    });

    expect(table.settings.permissions.read).toBe(Permission.Everybody);
    expect(table.settings.maxRecords).toBe(50);
  });

  it('retrieves and sanitizes single and all records with userName', async () => {
    const storage = new MemoryStorage();
    const alice = await storage.createUser('alice', 'pass123');

    const table = await storage.createTable('notes', {
      permissions: {
        create: Permission.Everybody,
        read: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });

    await table.applyChanges(alice, [
      {
        table: 'notes',
        id: 'n1',
        op: OperationType.Put,
        data: { text: 'hello' },
        timestamp: 1000,
      },
    ]);

    const record = await table.getRecord(undefined, 'n1');
    expect(record).toBeDefined();
    expect(record?.id).toBe('n1');
    expect(record?.data).toEqual({ text: 'hello' });
    expect(record?.userName).toBe('alice');
    expect((record as Record<string, unknown>).userId).toBeUndefined();

    const all = await table.getAllRecords();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('n1');
    expect(all[0].userName).toBe('alice');
    expect((all[0] as Record<string, unknown>).userId).toBeUndefined();
  });

  it('inserts initial rows and resolves usernames', async () => {
    const storage = new MemoryStorage();
    await storage.createUser('alice', 'pass123');

    const table = await storage.createTable('items', {
      permissions: {
        create: Permission.Everybody,
        read: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });

    const inserted = await table.insertRows([
      { id: 'i1', data: { name: 'Item 1' }, userName: 'alice' },
      { id: 'i2', data: { name: 'Item 2' } },
    ]);

    expect(inserted).toBe(2);

    const records = await table.getAllRecords();
    expect(records).toHaveLength(2);
    const item1 = records.find((r) => r.id === 'i1');
    expect(item1?.userName).toBe('alice');
  });

  it('deletes table through table instance', async () => {
    const storage = new MemoryStorage();
    const table = await storage.createTable('temp');

    expect(await storage.getTable('temp')).toBeDefined();
    const deleted = await table.delete();
    expect(deleted).toBe(true);
    expect(await storage.getTable('temp')).toBeUndefined();
  });
});
