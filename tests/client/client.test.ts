import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TetherDB } from '../../src/client/db.js';
import { OperationType } from '../../src/shared/types.js';

describe('TetherDB local operations (src/client/)', () => {
  let db: TetherDB;

  beforeEach(() => {
    db = new TetherDB({
      name: `test-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      tables: ['todos', 'notes'],
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

  it('should store and retrieve internal metadata', async () => {
    expect(await db.idbManager.getMeta('nonexistent')).toBeUndefined();
    await db.idbManager.setMeta('seq', 42);
    expect(await db.idbManager.getMeta('seq')).toBe(42);
  });

  it('should dynamically create new object stores on demand', async () => {
    const dynamicTable = db.table<{ content: string }>('dynamic_store');
    await dynamicTable.put('d1', { content: 'Dynamic content' });
    const res = await dynamicTable.get('d1');
    expect(res?.content).toBe('Dynamic content');
  });

  it('should record local changes into outbox in batch', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.putAll([
      { id: 'task-1', data: { title: 'Write tests' } },
      { id: 'task-2', data: { title: 'Refactor' } },
    ]);
    await todos.deleteAll(['task-1']);

    const outbox = await db.idbManager.getPendingOutbox();
    expect(outbox).toHaveLength(3);
    expect(outbox[0].change.op).toBe(OperationType.Put);
    expect(outbox[0].change.id).toBe('task-1');
    expect(outbox[1].change.op).toBe(OperationType.Put);
    expect(outbox[1].change.id).toBe('task-2');
    expect(outbox[2].change.op).toBe(OperationType.Delete);
    expect(outbox[2].change.id).toBe('task-1');
  });

  it('should trigger change subscriptions with event lists for single and bulk operations', async () => {
    const notes = db.table<{ text: string }>('notes');
    const eventBatches: Array<Array<{ op: OperationType; id: string }>> = [];

    const unsubscribe = notes.subscribe((events) => {
      eventBatches.push(events.map((e) => ({ op: e.op, id: e.id })));
    });

    // Single put
    await notes.put('n1', { text: 'Hello' });
    // Bulk put
    await notes.putAll([
      { id: 'n2', data: { text: 'World' } },
      { id: 'n3', data: { text: 'Bulk' } },
    ]);
    // Bulk delete
    await notes.deleteAll(['n1', 'n2']);

    unsubscribe();
    await notes.put('n4', { text: 'Unsubscribed' });

    expect(eventBatches).toHaveLength(3);
    // Batch 1: single put
    expect(eventBatches[0]).toEqual([{ op: OperationType.Put, id: 'n1' }]);
    // Batch 2: bulk put of 2 items
    expect(eventBatches[1]).toEqual([
      { op: OperationType.Put, id: 'n2' },
      { op: OperationType.Put, id: 'n3' },
    ]);
    // Batch 3: bulk delete of 2 items
    expect(eventBatches[2]).toEqual([
      { op: OperationType.Delete, id: 'n1' },
      { op: OperationType.Delete, id: 'n2' },
    ]);
  });

  it('should persist and reload local database across multiple TetherDB instances', async () => {
    const dbName = `persistent-db-${Date.now()}`;
    const instance1 = new TetherDB({ name: dbName, appId: 'test-app' });
    const table1 = instance1.table<{ title: string }>('bookmarks');
    await table1.put('b1', { title: 'GitHub' });
    await table1.put('b2', { title: 'MDN' });
    await instance1.close();

    // Reopen database with new instance
    const instance2 = new TetherDB({ name: dbName, appId: 'test-app' });
    const table2 = instance2.table<{ title: string }>('bookmarks');
    const items = await table2.getAll();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).sort()).toEqual(['GitHub', 'MDN']);
    await instance2.close();
  });

  it('should dynamically create undeclared stores on demand', async () => {
    const dynamicDb = new TetherDB({
      name: `dyn-db-${Date.now()}`,
      appId: 'test-app',
    });

    const customTable = dynamicDb.table<{ val: number }>('custom_metrics');
    await customTable.put('cpu', { val: 42 });
    const record = await customTable.get('cpu');
    expect(record?.val).toBe(42);

    await dynamicDb.close();
  });

  it('should require appId on database initialization', () => {
    expect(
      () =>
        new TetherDB({
          name: 'missing-app-id',
        } as unknown as { name: string; appId: string }),
    ).toThrow('Missing required appId in TetherDB options.');
  });

  it('should default name to appId when name is not specified', async () => {
    const autoNamedDb = new TetherDB({
      appId: 'auto-named-app',
    });
    expect(autoNamedDb.dbName).toBe('auto-named-app');
    expect(autoNamedDb.applicationIdentifier).toBe('auto-named-app');
    await autoNamedDb.close();
  });

  it('should allow custom name override separate from appId', async () => {
    const customNamedDb = new TetherDB({
      appId: 'my-app',
      name: 'custom_idb_name',
    });
    expect(customNamedDb.dbName).toBe('custom_idb_name');
    expect(customNamedDb.applicationIdentifier).toBe('my-app');
    await customNamedDb.close();
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
