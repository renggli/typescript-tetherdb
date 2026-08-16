import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TetherClient } from '../../src/client/client.js';
import { Storage } from '../../src/client/storage.js';
import { OperationType } from '../../src/shared/types.js';

describe('TetherClient local operations (src/client/)', () => {
  let db: TetherClient;

  beforeEach(() => {
    db = new TetherClient({
      name: `test-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('should insert, retrieve, update and delete items locally', async () => {
    const todos = db.table<{ title: string; completed: boolean }>('todos');

    // Put item
    const item1 = await todos.put('1', {
      title: 'Buy groceries',
      completed: false,
    });
    expect(item1.title).toBe('Buy groceries');

    // Get item
    const retrieved = await todos.get('1');
    expect(retrieved).toEqual({ title: 'Buy groceries', completed: false });

    // Update item
    await todos.put('1', { title: 'Buy groceries', completed: true });
    const updated = await todos.get('1');
    expect(updated?.completed).toBe(true);

    // Get all
    await todos.put('2', { title: 'Read paper', completed: false });
    const all = await todos.getAll();
    expect(all).toHaveLength(2);

    // Delete item
    const deleted = await todos.delete('1');
    expect(deleted).toBe(true);

    const afterDelete = await todos.get('1');
    expect(afterDelete).toBeNull();

    const remaining = await todos.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Read paper');
  });

  it('should perform atomic bulk operations (putAll, deleteAll, getAll with ids)', async () => {
    const todos = db.table<{ title: string }>('todos');

    // Empty operations handle gracefully
    expect(await todos.putAll([])).toEqual([]);
    expect(await todos.deleteAll([])).toBe(0);
    expect(await todos.getAll([])).toEqual([]);

    // Bulk put
    const items = [
      { id: 'b1', data: { title: 'Bulk 1' } },
      { id: 'b2', data: { title: 'Bulk 2' } },
      { id: 'b3', data: { title: 'Bulk 3' } },
    ];
    const saved = await todos.putAll(items);
    expect(saved).toHaveLength(3);

    // Filtered getAll
    const subset = await todos.getAll(['b1', 'b3', 'nonexistent']);
    expect(subset).toHaveLength(2);
    expect(subset).toEqual([{ title: 'Bulk 1' }, { title: 'Bulk 3' }]);

    // Bulk delete
    const deletedCount = await todos.deleteAll(['b1', 'b2']);
    expect(deletedCount).toBe(2);

    const remaining = await todos.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Bulk 3');
  });

  it('should retrieve active records with metadata and remove them upon delete', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.put('m1', { title: 'Meta 1' });
    await todos.put('m1', { title: 'Meta 1 v2' });

    const rec = await todos.getWithMetadata('m1');
    expect(rec).toBeDefined();
    expect(rec?.version).toBe(2);
    expect(rec?.data.title).toBe('Meta 1 v2');

    expect(await todos.getAllWithMetadata()).toHaveLength(1);

    await todos.delete('m1');
    expect(await todos.getWithMetadata('m1')).toBeUndefined();
    expect(await todos.getAllWithMetadata()).toHaveLength(0);
  });

  it('should support reactive subscription callbacks for local modifications', async () => {
    const todos = db.table<{ title: string }>('todos');
    const receivedEvents: Array<{
      op: OperationType;
      id: string;
      title?: string;
    }> = [];

    const unsubscribe = todos.subscribe((events) => {
      for (const e of events) {
        receivedEvents.push({
          op: e.op,
          id: e.id,
          title: e.data?.title,
        });
      }
    });

    await todos.put('sub1', { title: 'Reactive Item 1' });
    await todos.putAll([
      { id: 'sub2', data: { title: 'Reactive Item 2' } },
      { id: 'sub3', data: { title: 'Reactive Item 3' } },
    ]);
    await todos.delete('sub1');
    await todos.deleteAll(['sub2', 'sub3']);

    expect(receivedEvents).toHaveLength(6);
    expect(receivedEvents[0]).toEqual({
      op: OperationType.Put,
      id: 'sub1',
      title: 'Reactive Item 1',
    });
    expect(receivedEvents[3]).toEqual({
      op: OperationType.Delete,
      id: 'sub1',
      title: undefined,
    });

    unsubscribe();
    await todos.put('sub4', { title: 'After unsubscribe' });
    expect(receivedEvents).toHaveLength(6);
  });

  it('should support subscribeAll live reactive subscriptions', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.put('item1', { title: 'First Item' });

    const snapshots: Array<Array<{ title: string }>> = [];
    const unsubscribe = todos.subscribeAll((items) => {
      snapshots.push(items);
    });

    // Wait for initial async fetch
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(1);
    expect(snapshots[0][0].title).toBe('First Item');

    // Add item
    await todos.put('item2', { title: 'Second Item' });
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toHaveLength(2);

    // Delete item
    await todos.delete('item1');
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toHaveLength(1);
    expect(snapshots[2][0].title).toBe('Second Item');

    // Unsubscribe
    unsubscribe();
    await todos.put('item3', { title: 'Third Item' });
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshots).toHaveLength(3);
  });

  it('should record local mutations into outbox', async () => {
    const rawStorage = new Storage(
      `outbox-test-${Math.random().toString(36).substring(2, 8)}`,
    );
    const todos = rawStorage.table<{ title: string }>('todos');
    await todos.put('out1', { title: 'Outbox Test' });

    const outbox = await rawStorage.getPendingOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].change.table).toBe('todos');
    expect(outbox[0].change.id).toBe('out1');
    expect(outbox[0].change.op).toBe(OperationType.Put);
    expect(outbox[0].change.clientId).toBe(rawStorage.clientId);
    expect(outbox[0].change.data).toEqual({ title: 'Outbox Test' });
    await rawStorage.close();
  });

  it('should dynamically instantiate tables on demand', async () => {
    const dynamicTable = db.table<{ value: number }>('dynamic_metrics');
    await dynamicTable.put('cpu', { value: 42 });

    const retrieved = await dynamicTable.get('cpu');
    expect(retrieved?.value).toBe(42);
  });

  it('should manage and persist sync metadata (lastSyncSeq, tokens)', async () => {
    const rawStorage = new Storage(
      `meta-test-${Math.random().toString(36).substring(2, 8)}`,
    );
    await rawStorage.setMeta('lastSyncSeq', 12345);
    const seq = await rawStorage.getMeta<number>('lastSyncSeq');
    expect(seq).toBe(12345);

    await rawStorage.setMeta('authToken', 'sample.jwt.token');
    const token = await rawStorage.getMeta<string>('authToken');
    expect(token).toBe('sample.jwt.token');

    await rawStorage.deleteMeta('authToken');
    const deletedToken = await rawStorage.getMeta<string>('authToken');
    expect(deletedToken).toBeUndefined();
    await rawStorage.close();
  });

  it('should expose storage name and clientId on Storage coordinator', async () => {
    const rawStorage = new Storage(
      `name-test-${Math.random().toString(36).substring(2, 8)}`,
    );
    expect(rawStorage.clientId).toBeDefined();
    expect(typeof rawStorage.clientId).toBe('string');
    expect(rawStorage.name).toBeDefined();
    expect(rawStorage.name.startsWith('name-test-')).toBe(true);
    await rawStorage.close();
  });

  it('should require name on database initialization', () => {
    expect(
      () =>
        new TetherClient({
          name: '',
        } as unknown as { name: string }),
    ).toThrow('Missing required name in TetherClient options.');
  });

  it('should clear table contents completely using table.clear()', async () => {
    const table = db.table<{ name: string }>('tags');
    await table.putAll([
      { id: 't1', data: { name: 'work' } },
      { id: 't2', data: { name: 'personal' } },
      { id: 't3', data: { name: 'urgent' } },
    ]);

    expect(await table.getAll()).toHaveLength(3);
    const clearedCount = await table.clear();
    expect(clearedCount).toBe(3);
    expect(await table.getAll()).toHaveLength(0);
    expect(await table.getAllWithMetadata()).toHaveLength(0);
  });
});
