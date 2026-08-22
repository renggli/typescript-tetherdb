import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../src/client/storage.js';
import type { Table, TableChangeEvent } from '../../src/client/table.js';
import { OperationType } from '../../src/shared/types.js';

interface TestItem {
  title: string;
  count?: number;
}

describe('Table', () => {
  let storage: Storage;
  let table: Table<TestItem>;

  beforeEach(() => {
    storage = new Storage(
      `test-table-${Math.random().toString(36).substring(2, 8)}`,
    );
    table = storage.table<TestItem>('items');
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should expose table name and clientId from storage', () => {
    expect(table.name).toBe('items');
    expect(table.clientId).toBe(storage.clientId);
    expect(typeof table.clientId).toBe('string');
  });

  describe('get & getAll', () => {
    it('should return undefined when getting a non-existent record', async () => {
      const result = await table.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should retrieve a single record after put', async () => {
      await table.put('item-1', { title: 'First Item', count: 10 });
      const result = await table.get('item-1');
      expect(result).toEqual({ title: 'First Item', count: 10 });
    });

    it('should retrieve all records when no ids are provided to getAll', async () => {
      expect(await table.getAll()).toEqual([]);

      await table.put('item-1', { title: 'First Item' });
      await table.put('item-2', { title: 'Second Item' });

      const all = await table.getAll();
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          { title: 'First Item' },
          { title: 'Second Item' },
        ]),
      );
    });

    it('should return an empty array when getAll is called with an empty list of ids', async () => {
      await table.put('item-1', { title: 'First Item' });
      const result = await table.getAll([]);
      expect(result).toEqual([]);
    });

    it('should retrieve only specified records in requested order, ignoring missing ids', async () => {
      await table.put('a', { title: 'Alpha' });
      await table.put('b', { title: 'Beta' });
      await table.put('c', { title: 'Gamma' });

      const subset = await table.getAll(['c', 'missing', 'a']);
      expect(subset).toEqual([{ title: 'Gamma' }, { title: 'Alpha' }]);
    });
  });

  describe('getWithMetadata & getAllWithMetadata', () => {
    it('should return undefined when getWithMetadata is called for non-existent id', async () => {
      const rec = await table.getWithMetadata('missing');
      expect(rec).toBeUndefined();
    });

    it('should return stored record with metadata and increment version on updates', async () => {
      await table.put('m1', { title: 'Initial' });
      const rec1 = await table.getWithMetadata('m1');
      expect(rec1).toBeDefined();
      expect(rec1?.id).toBe('m1');
      expect(rec1?.data).toEqual({ title: 'Initial' });
      expect(rec1?.version).toBe(1);
      expect(rec1?.deleted).toBeFalsy();
      expect(rec1?.timestamp).toBeGreaterThan(0);

      await table.put('m1', { title: 'Updated' });
      const rec2 = await table.getWithMetadata('m1');
      expect(rec2?.version).toBe(2);
      expect(rec2?.data).toEqual({ title: 'Updated' });
    });

    it('should return all records with metadata via getAllWithMetadata', async () => {
      await table.put('m1', { title: 'First' });
      await table.put('m2', { title: 'Second' });

      const records = await table.getAllWithMetadata();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
      expect(records.every((r) => r.version === 1)).toBe(true);
    });
  });

  describe('put & putAll', () => {
    it('should handle putAll with empty array without errors', async () => {
      const result = await table.putAll([]);
      expect(result).toEqual([]);
    });

    it('should atomically put multiple entries, increment versions, and fire onChange events', async () => {
      const events: TableChangeEvent<TestItem>[][] = [];
      table.onChange.register((ev) => events.push(ev));

      // Put initial items
      const saved = await table.putAll([
        { id: 'p1', data: { title: 'P1' } },
        { id: 'p2', data: { title: 'P2' } },
      ]);
      expect(saved).toEqual([{ title: 'P1' }, { title: 'P2' }]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual([
        {
          op: OperationType.Put,
          id: 'p1',
          data: { title: 'P1' },
          isRemote: false,
        },
        {
          op: OperationType.Put,
          id: 'p2',
          data: { title: 'P2' },
          isRemote: false,
        },
      ]);

      // Update one existing item and insert one new item
      await table.putAll([
        { id: 'p1', data: { title: 'P1 v2' } },
        { id: 'p3', data: { title: 'P3' } },
      ]);

      const recP1 = await table.getWithMetadata('p1');
      const recP3 = await table.getWithMetadata('p3');
      expect(recP1?.version).toBe(2);
      expect(recP3?.version).toBe(1);

      // Verify outbox queue
      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(4);
      expect(outbox[2].change.version).toBe(2);
      expect(outbox[3].change.version).toBe(1);
    });
  });

  describe('delete, deleteAll & clear', () => {
    it('should return false when deleting a non-existent item', async () => {
      const deleted = await table.delete('missing');
      expect(deleted).toBe(false);
    });

    it('should return true when deleting an existing item and fire onChange event', async () => {
      await table.put('d1', { title: 'To Delete' });

      const events: TableChangeEvent<TestItem>[][] = [];
      table.onChange.register((ev) => events.push(ev));

      const deleted = await table.delete('d1');
      expect(deleted).toBe(true);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual([
        {
          op: OperationType.Delete,
          id: 'd1',
          isRemote: false,
        },
      ]);

      expect(await table.get('d1')).toBeUndefined();
    });

    it('should handle deleteAll with empty array returning 0', async () => {
      expect(await table.deleteAll([])).toBe(0);
    });

    it('should only delete existing items in deleteAll and skip missing ones', async () => {
      await table.put('d1', { title: 'D1' });
      await table.put('d2', { title: 'D2' });

      const events: TableChangeEvent<TestItem>[][] = [];
      table.onChange.register((ev) => events.push(ev));

      const count = await table.deleteAll(['d1', 'missing', 'd2']);
      expect(count).toBe(2);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual([
        { op: OperationType.Delete, id: 'd1', isRemote: false },
        { op: OperationType.Delete, id: 'd2', isRemote: false },
      ]);

      expect(await table.getAll()).toEqual([]);
    });

    it('should skip already deleted items when calling deleteAll again', async () => {
      await table.put('d1', { title: 'D1' });
      await table.delete('d1');

      const count = await table.deleteAll(['d1']);
      expect(count).toBe(0);
    });

    it('should clear all records in the table and return the deleted count', async () => {
      await table.putAll([
        { id: 'c1', data: { title: 'C1' } },
        { id: 'c2', data: { title: 'C2' } },
        { id: 'c3', data: { title: 'C3' } },
      ]);

      const cleared = await table.clear();
      expect(cleared).toBe(3);
      expect(await table.getAll()).toHaveLength(0);

      // Calling clear on empty table returns 0
      const clearedAgain = await table.clear();
      expect(clearedAgain).toBe(0);
    });
  });

  describe('subscribeAll', () => {
    it('should immediately invoke listener with current items and re-invoke on changes', async () => {
      await table.put('s1', { title: 'Initial' });

      const snapshots: TestItem[][] = [];
      const unsubscribe = table.subscribeAll((items) => {
        snapshots.push(items);
      });

      // Wait for initial async microtask fetch
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual([{ title: 'Initial' }]);

      // Trigger put
      await table.put('s2', { title: 'Second' });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toHaveLength(2);

      // Trigger delete
      await table.delete('s1');
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(3);
      expect(snapshots[2]).toEqual([{ title: 'Second' }]);

      // Unsubscribe and verify no more calls
      unsubscribe();
      await table.put('s3', { title: 'Third' });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(3);
    });

    it('should not invoke listener if unsubscribed before initial async fetch completes', async () => {
      const snapshots: TestItem[][] = [];
      const unsubscribe = table.subscribeAll((items) => {
        snapshots.push(items);
      });

      // Immediately unsubscribe before microtask resolves
      unsubscribe();
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(0);
    });

    it('should silently handle error if getAll fails inside subscribeAll fetch without calling listener', async () => {
      const getAllSpy = vi
        .spyOn(table, 'getAll')
        .mockRejectedValue(new Error('Storage failure'));

      const listener = vi.fn();
      table.subscribeAll(listener);

      await new Promise((r) => setTimeout(r, 2));
      expect(listener).not.toHaveBeenCalled();
      getAllSpy.mockRestore();
    });

    it('should maintain latest version and ignore out-of-order stale fetch resolutions', async () => {
      const snapshots: TestItem[][] = [];
      const unsubscribe = table.subscribeAll((items) => {
        snapshots.push([...items]);
      });

      // Rapidly fire multiple puts
      await table.put('item1', { title: 'First' });
      await table.put('item2', { title: 'Second' });
      await table.put('item3', { title: 'Third' });

      await new Promise((r) => setTimeout(r, 2));

      const lastSnapshot = snapshots[snapshots.length - 1];
      expect(lastSnapshot).toHaveLength(3);
      expect(lastSnapshot.map((i) => i.title).sort()).toEqual([
        'First',
        'Second',
        'Third',
      ]);
      unsubscribe();
    });
  });

  describe('notifyRemoteChanges', () => {
    it('should do nothing when notifyRemoteChanges is called with an empty array', () => {
      const listener = vi.fn();
      table.onChange.register(listener);

      table.notifyRemoteChanges([]);
      expect(listener).not.toHaveBeenCalled();
    });

    it('should broadcast remote events to subscribers', () => {
      const listener = vi.fn();
      table.onChange.register(listener);

      table.notifyRemoteChanges([
        {
          op: OperationType.Put,
          id: 'rem1',
          data: { title: 'Remote' },
          isRemote: true,
        },
      ]);

      expect(listener).toHaveBeenCalledWith([
        {
          op: OperationType.Put,
          id: 'rem1',
          data: { title: 'Remote' },
          isRemote: true,
        },
      ]);
    });
  });

  describe('deleteAll edge cases', () => {
    it('should handle deleteAll on records with missing version or timestamp metadata', async () => {
      // Direct raw record without version
      await storage.applySnapshotBatch([
        {
          table: 'items',
          id: 'raw1',
          data: { title: 'Raw item' },
          timestamp: 100,
          version: undefined as unknown as number,
          clientId: 'c0',
        },
      ]);

      const deletedCount = await table.deleteAll(['raw1', 'nonexistent']);
      expect(deletedCount).toBe(1);

      const record = await table.get('raw1');
      expect(record).toBeUndefined();

      // Deleting again should return 0
      const secondDelete = await table.deleteAll(['raw1']);
      expect(secondDelete).toBe(0);
    });
  });
});
