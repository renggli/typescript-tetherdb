import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexDirection,
  IndexRange,
  type Table,
  type TableChangeEvent,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage.js';
import { OperationType } from '../../src/shared/types.js';

interface TestItem {
  title: string;
  count?: number;
  tags?: string[];
  category?: string;
  priority?: number;
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

  describe('Index', () => {
    it('should expose index configuration properties correctly', () => {
      const customTable = storage.table<TestItem>('prop_tests');
      const byTitle = customTable.index<string>('title', { unique: true });
      const byTags = customTable.index<string>('tags', { multiEntry: true });
      const byCatPriority = customTable.index<[string, number]>([
        'category',
        'priority',
      ]);

      expect(byTitle.name).toBe('title');
      expect(byTitle.keyPath).toBe('title');
      expect(byTitle.unique).toBe(true);
      expect(byTitle.multiEntry).toBe(false);
      expect(byTitle.table).toBe(customTable);

      expect(byTags.name).toBe('tags');
      expect(byTags.multiEntry).toBe(true);
      expect(byCatPriority.name).toBe('category,priority');
      expect(byCatPriority.keyPath).toEqual(['category', 'priority']);
    });

    it('should register indexes on table and expose them via table.indexes', () => {
      const customTable = storage.table<TestItem>('custom');
      customTable.index<string>('title');
      customTable.index<number>('count');

      expect(customTable.indexes).toHaveLength(2);
      expect(customTable.indexes[0].name).toBe('title');
      expect(customTable.indexes[1].name).toBe('count');
    });

    it('should retrieve records using index.get and index.getWithMetadata', async () => {
      const itemsTable = storage.table<TestItem>('indexed_items');
      const indexed = itemsTable.index<string>('title');

      await itemsTable.put('id-1', { title: 'Apple', count: 5 });
      await itemsTable.put('id-2', { title: 'Banana', count: 10 });

      expect(indexed.name).toBe('title');
      expect(indexed.keyPath).toBe('title');

      const found = await indexed.get('Banana');
      expect(found).toEqual({ title: 'Banana', count: 10 });

      const missing = await indexed.get('Cherry');
      expect(missing).toBeUndefined();

      const withMeta = await indexed.getWithMetadata('Apple');
      expect(withMeta?.id).toBe('id-1');
      expect(withMeta?.data.title).toBe('Apple');
      expect(withMeta?.version).toBe(1);
    });

    it('should retrieve all records using index.getAll and index.getAllWithMetadata', async () => {
      const catTable = storage.table<TestItem>('categories');
      const indexed = catTable.index<string>('category');

      await catTable.putAll([
        { id: '1', data: { title: 'Book 1', category: 'books' } },
        { id: '2', data: { title: 'Toy 1', category: 'toys' } },
        { id: '3', data: { title: 'Book 2', category: 'books' } },
      ]);

      const books = await indexed.getAll('books');
      expect(books).toHaveLength(2);
      expect(books.map((b) => b.title).sort()).toEqual(['Book 1', 'Book 2']);

      const all = await indexed.getAll();
      expect(all).toHaveLength(3);

      const allWithMeta = await indexed.getAllWithMetadata('books');
      expect(allWithMeta).toHaveLength(2);
      expect(allWithMeta.map((r) => r.id).sort()).toEqual(['1', '3']);
    });

    it('should support pagination, limit, offset, and direction on index queries', async () => {
      const rankedTable = storage.table<TestItem>('ranked');
      const indexed = rankedTable.index<number>('count');

      await rankedTable.putAll([
        { id: '1', data: { title: 'A', count: 10 } },
        { id: '2', data: { title: 'B', count: 20 } },
        { id: '3', data: { title: 'C', count: 30 } },
        { id: '4', data: { title: 'D', count: 40 } },
        { id: '5', data: { title: 'E', count: 50 } },
      ]);

      // Limit only
      const limited = await indexed.getAll(undefined, { limit: 2 });
      expect(limited.map((i) => i.count)).toEqual([10, 20]);

      // Offset & Limit
      const paged = await indexed.getAll(undefined, { offset: 2, limit: 2 });
      expect(paged.map((i) => i.count)).toEqual([30, 40]);

      // Reverse direction
      const reversed = await indexed.getAll(undefined, {
        direction: IndexDirection.Prev,
        limit: 3,
      });
      expect(reversed.map((i) => i.count)).toEqual([50, 40, 30]);

      // Keys & Primary Keys
      const keys = await indexed.getKeys(undefined, { limit: 3 });
      expect(keys).toEqual([10, 20, 30]);

      const pkeys = await indexed.getPrimaryKeys(undefined, {
        direction: IndexDirection.Prev,
        limit: 2,
      });
      expect(pkeys).toEqual(['5', '4']);
    });

    it('should count records matching query or range', async () => {
      const countTable = storage.table<TestItem>('counts');
      const indexed = countTable.index<string>('category');

      await countTable.putAll([
        { id: '1', data: { title: 'Item 1', category: 'electronics' } },
        { id: '2', data: { title: 'Item 2', category: 'furniture' } },
        { id: '3', data: { title: 'Item 3', category: 'electronics' } },
      ]);

      expect(await indexed.count('electronics')).toBe(2);
      expect(await indexed.count('furniture')).toBe(1);
      expect(await indexed.count('clothing')).toBe(0);
      expect(await indexed.count()).toBe(3);
    });

    it('should query ranges using IndexRange helpers', async () => {
      const rangeTable = storage.table<TestItem>('range_items');
      const indexed = rangeTable.index<string>('title');

      await rangeTable.putAll([
        { id: '1', data: { title: 'Alice' } },
        { id: '2', data: { title: 'Albert' } },
        { id: '3', data: { title: 'Bob' } },
        { id: '4', data: { title: 'Charlie' } },
      ]);

      // Prefix match
      const alPrefix = await indexed.getAll(IndexRange.startsWith('Al'));
      expect(alPrefix.map((i) => i.title).sort()).toEqual(['Albert', 'Alice']);

      // Bounded range
      const bound = await indexed.getAll(IndexRange.bound('Albert', 'Bob'));
      expect(bound.map((i) => i.title).sort()).toEqual([
        'Albert',
        'Alice',
        'Bob',
      ]);

      // Lower bound
      const lower = await indexed.getAll(IndexRange.lowerBound('Bob'));
      expect(lower.map((i) => i.title).sort()).toEqual(['Bob', 'Charlie']);
    });

    it('should support multi-entry indexes for array properties', async () => {
      const tagTable = storage.table<TestItem>('tagged_items');
      const indexed = tagTable.index<string>('tags', { multiEntry: true });

      await tagTable.putAll([
        { id: '1', data: { title: 'Post 1', tags: ['news', 'tech'] } },
        { id: '2', data: { title: 'Post 2', tags: ['tech', 'gaming'] } },
        { id: '3', data: { title: 'Post 3', tags: ['cooking'] } },
      ]);

      const techPosts = await indexed.getAll('tech');
      expect(techPosts.map((p) => p.title).sort()).toEqual([
        'Post 1',
        'Post 2',
      ]);

      const newsPosts = await indexed.getAll('news');
      expect(newsPosts.map((p) => p.title)).toEqual(['Post 1']);

      const gamingPosts = await indexed.getAll('gaming');
      expect(gamingPosts.map((p) => p.title)).toEqual(['Post 2']);
    });

    it('should support compound indexes', async () => {
      const compTable = storage.table<TestItem>('compound_items');
      const indexed = compTable.index<[string, number]>([
        'category',
        'priority',
      ]);

      await compTable.putAll([
        { id: '1', data: { title: 'Task 1', category: 'work', priority: 1 } },
        { id: '2', data: { title: 'Task 2', category: 'work', priority: 2 } },
        { id: '3', data: { title: 'Task 3', category: 'home', priority: 1 } },
      ]);

      const workP1 = await indexed.getAll(['work', 1]);
      expect(workP1.map((t) => t.title)).toEqual(['Task 1']);

      const workP2 = await indexed.getAll(['work', 2]);
      expect(workP2.map((t) => t.title)).toEqual(['Task 2']);
    });

    it('should dynamically add an index to an existing table with existing data', async () => {
      // Initially create table with NO indexes
      const dynamicTable = storage.table<TestItem>('dynamic_test');
      await dynamicTable.putAll([
        { id: '1', data: { title: 'Delta', count: 100 } },
        { id: '2', data: { title: 'Echo', count: 200 } },
      ]);

      // Acquire index on table
      const indexed = dynamicTable.index<number>('count');
      const found = await indexed.get(200);
      expect(found).toEqual({ title: 'Echo', count: 200 });

      const all = await indexed.getAll();
      expect(all).toHaveLength(2);
    });

    it('should reactively subscribe to index queries via index.subscribe', async () => {
      const reactiveTable = storage.table<TestItem>('reactive_test');
      const indexed = reactiveTable.index<string>('category');

      await reactiveTable.put('1', {
        title: 'Initial Tech',
        category: 'tech',
      });

      const snapshots: TestItem[][] = [];
      const unsubscribe = indexed.subscribe('tech', (items) => {
        snapshots.push(items);
      });

      // Wait for initial fetch
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual([
        { title: 'Initial Tech', category: 'tech' },
      ]);

      // Add matching item
      await reactiveTable.put('2', {
        title: 'Second Tech',
        category: 'tech',
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toHaveLength(2);

      // Add non-matching item (re-query evaluates to same matching subset)
      await reactiveTable.put('3', {
        title: 'Life item',
        category: 'life',
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(3);
      expect(snapshots[2]).toHaveLength(2);

      // Delete matching item
      await reactiveTable.delete('1');
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(4);
      expect(snapshots[3]).toEqual([
        { title: 'Second Tech', category: 'tech' },
      ]);

      unsubscribe();
    });
  });

  describe('live()', () => {
    it('should stream live snapshots as an async iterable', async () => {
      const liveTable = storage.table<TestItem>('live_stream_test');
      await liveTable.put('1', { title: 'First' });

      const iterator = liveTable.live()[Symbol.asyncIterator]();

      // First yield: initial snapshot
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual([{ title: 'First' }]);

      // Mutate table
      const nextPromise = iterator.next();
      await liveTable.put('2', { title: 'Second' });

      const second = await nextPromise;
      expect(second.done).toBe(false);
      expect(second.value).toHaveLength(2);

      // Cleanup
      await iterator.return?.();
    });
  });
});
