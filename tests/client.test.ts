import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeamedClientDB } from '../src/client/db.js';
import { OperationType } from '../src/shared/types.js';

describe('BeamedClientDB local operations', () => {
  let db: BeamedClientDB;

  beforeEach(() => {
    db = new BeamedClientDB({
      name: `test-db-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['todos', 'notes'],
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

  it('should record local changes into outbox', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.put('task-1', { title: 'Write tests' });
    await todos.delete('task-1');

    const outbox = await db.idbManager.getPendingOutbox();
    expect(outbox).toHaveLength(2);
    expect(outbox[0].change.op).toBe(OperationType.Put);
    expect(outbox[0].change.id).toBe('task-1');
    expect(outbox[1].change.op).toBe(OperationType.Delete);
    expect(outbox[1].change.id).toBe('task-1');
  });

  it('should trigger change subscriptions', async () => {
    const notes = db.table<{ text: string }>('notes');
    const events: Array<{
      op: OperationType;
      id: string;
      data?: { text: string };
      isRemote?: boolean;
    }> = [];

    const unsubscribe = notes.subscribe((e) => {
      events.push(e);
    });

    await notes.put('n1', { text: 'Hello' });
    await notes.delete('n1');

    unsubscribe();
    await notes.put('n2', { text: 'Unsubscribed' });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      op: OperationType.Put,
      id: 'n1',
      data: { text: 'Hello' },
      isRemote: false,
    });
    expect(events[1]).toEqual({
      op: OperationType.Delete,
      id: 'n1',
      data: undefined,
      isRemote: false,
    });
  });
});
