import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../../../src/client/storage.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('Storage', () => {
  let storage: Storage;
  let dbName: string;

  beforeEach(() => {
    dbName = `test-storage-${Math.random().toString(36).substring(2, 8)}`;
    storage = new Storage(dbName);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should initialize instance properties properly', () => {
    expect(storage.name).toBe(dbName);
    expect(typeof storage.clientId).toBe('string');
    expect(storage.clientId.length).toBeGreaterThan(0);
  });

  it('should cache and reuse Table instances by name', () => {
    const t1 = storage.table('todos');
    const t2 = storage.table('todos');
    const t3 = storage.table('notes');

    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
    expect(t1.name).toBe('todos');
    expect(t3.name).toBe('notes');
  });

  describe('Database Connection & Schema Management', () => {
    it('should open database and automatically create internal stores', async () => {
      const db = await storage.getDatabase();
      expect(db.objectStoreNames.contains('__tether_outbox')).toBe(true);
      expect(db.objectStoreNames.contains('__tether_meta')).toBe(true);
    });

    it('should dynamically create table object stores via ensureTable and ensureTables', async () => {
      await storage.ensureTable('users');
      let db = await storage.getDatabase();
      expect(db.objectStoreNames.contains('users')).toBe(true);

      // Multiple tables
      await storage.ensureTables(['orders', 'products', 'users']);
      db = await storage.getDatabase();
      expect(db.objectStoreNames.contains('orders')).toBe(true);
      expect(db.objectStoreNames.contains('products')).toBe(true);
      expect(db.objectStoreNames.contains('users')).toBe(true);

      // Calling ensureTables when all stores exist should be a no-op
      const currentVersion = db.version;
      await storage.ensureTables(['orders', 'products']);
      db = await storage.getDatabase();
      expect(db.version).toBe(currentVersion);
    });

    it('should close active IDBDatabase connection and allow reopening', async () => {
      const db1 = await storage.getDatabase();
      expect(db1).toBeDefined();

      await storage.close();
      const db2 = await storage.getDatabase();
      expect(db2).toBeDefined();
      expect(db2).not.toBe(db1);
    });
  });

  describe('Metadata Store (META_STORE)', () => {
    it('should return undefined for non-existent metadata key', async () => {
      const val = await storage.getMeta('non_existent');
      expect(val).toBeUndefined();
    });

    it('should set, get, and delete metadata entries', async () => {
      await storage.setMeta('seq', 42);
      await storage.setMeta('session', { token: 'xyz', user: 'bob' });

      expect(await storage.getMeta<number>('seq')).toBe(42);
      expect(
        await storage.getMeta<{ token: string; user: string }>('session'),
      ).toEqual({
        token: 'xyz',
        user: 'bob',
      });

      await storage.deleteMeta('seq');
      expect(await storage.getMeta('seq')).toBeUndefined();
      expect(await storage.getMeta('session')).toBeDefined();
    });
  });

  describe('User Attribution & Storage Clearing', () => {
    it('should set and get current user name via setCurrentUser and currentUserName getter', () => {
      expect(storage.currentUserName).toBeUndefined();
      storage.setCurrentUser('alice');
      expect(storage.currentUserName).toBe('alice');
      storage.setCurrentUser(undefined);
      expect(storage.currentUserName).toBeUndefined();
    });

    it('should clear only table stores with clearTables while leaving metadata intact', async () => {
      const todos = storage.table<{ title: string }>('todos');
      await todos.put('t1', { title: 'Test Todo' });
      await storage.setMeta('metaKey', 'metaVal');

      expect(await todos.getAll()).toHaveLength(1);
      expect(await storage.getMeta('metaKey')).toBe('metaVal');

      await storage.clearTables(true);
      expect(await todos.getAll()).toHaveLength(0);
      expect(await storage.getMeta('metaKey')).toBe('metaVal');
    });

    it('should wipe all stores and metadata on clearAllData', async () => {
      const todos = storage.table<{ title: string }>('todos');
      await todos.put('t1', { title: 'Test Todo' });
      await storage.setMeta('metaKey', 'metaVal');

      expect(await todos.getAll()).toHaveLength(1);
      expect(await storage.getMeta('metaKey')).toBe('metaVal');

      await storage.clearAllData();
      expect(await todos.getAll()).toHaveLength(0);
      expect(await storage.getMeta('metaKey')).toBeUndefined();
    });
  });

  describe('Record Queries & CRUD', () => {
    it('should return undefined when getting a non-existent record', async () => {
      const rec = await storage.getRecord('notes', 'n1');
      expect(rec).toBeUndefined();
    });

    it('should get multiple records by id list in a single transaction', async () => {
      expect(await storage.getRecords('items', [])).toEqual(new Map());

      await storage.applyLocalChanges('items', [
        {
          id: 'i1',
          op: OperationType.Put,
          data: { name: 'Item 1' },
          change: {
            table: 'items',
            id: 'i1',
            op: OperationType.Put,
            data: { name: 'Item 1' },
            timestamp: 100,
            clientId: storage.clientId,
          },
        },
        {
          id: 'i2',
          op: OperationType.Put,
          data: { name: 'Item 2' },
          change: {
            table: 'items',
            id: 'i2',
            op: OperationType.Put,
            data: { name: 'Item 2' },
            timestamp: 200,
            clientId: storage.clientId,
          },
        },
      ]);

      const map = await storage.getRecords<{ name: string }>('items', [
        'i1',
        'i3',
        'i2',
      ]);
      expect(map.size).toBe(2);
      expect(map.get('i1')?.data).toEqual({ name: 'Item 1' });
      expect(map.get('i2')?.data).toEqual({ name: 'Item 2' });
      expect(map.get('i3')).toBeUndefined();
    });

    it('should get all records from a table', async () => {
      expect(await storage.getAllRecords('docs')).toEqual([]);

      await storage.applyLocalChanges('docs', [
        {
          id: 'd1',
          op: OperationType.Put,
          data: { title: 'Doc 1' },
          change: {
            table: 'docs',
            id: 'd1',
            op: OperationType.Put,
            data: { title: 'Doc 1' },
            timestamp: 10,
            clientId: storage.clientId,
          },
        },
      ]);

      const all = await storage.getAllRecords<{ title: string }>('docs');
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('d1');
      expect(all[0].data).toEqual({ title: 'Doc 1' });
      expect(all[0].version).toBe(1);
    });
  });

  describe('applyLocalChanges & Outbox Queue', () => {
    it('should return empty array on empty mutations without firing onLocalChange', async () => {
      const changeSpy = vi.fn();
      storage.onLocalChange.register(changeSpy);

      const res = await storage.applyLocalChanges('todos', []);
      expect(res).toEqual([]);
      expect(changeSpy).not.toHaveBeenCalled();
    });

    it('should atomically store records, record outbox entries, and fire onLocalChange', async () => {
      const changeSpy = vi.fn();
      storage.onLocalChange.register(changeSpy);

      const records = await storage.applyLocalChanges('todos', [
        {
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Buy milk' },
          change: {
            table: 'todos',
            id: 't1',
            op: OperationType.Put,
            data: { text: 'Buy milk' },
            timestamp: 1000,
            version: 1,
            clientId: storage.clientId,
          },
        },
        {
          id: 't2',
          op: OperationType.Put,
          data: { text: 'Feed cat' },
          change: {
            table: 'todos',
            id: 't2',
            op: OperationType.Put,
            data: { text: 'Feed cat' },
            timestamp: 1001,
            version: 1,
            clientId: storage.clientId,
          },
        },
      ]);

      expect(records).toHaveLength(2);
      expect(changeSpy).toHaveBeenCalledTimes(1);

      // Verify outbox
      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(2);
      expect(outbox[0].localId).toBeDefined();
      expect(outbox[0].change.id).toBe('t1');
      expect(outbox[0].createdAt).toBeGreaterThan(0);
      expect(outbox[1].change.id).toBe('t2');

      // Test limit parameter on getPendingOutbox
      const limitedOutbox = await storage.getPendingOutbox(1);
      expect(limitedOutbox).toHaveLength(1);
      expect(limitedOutbox[0].change.id).toBe('t1');
    });

    it('should apply local delete operations and remove record from table store while queueing outbox entry', async () => {
      await storage.applyLocalChanges('todos', [
        {
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Buy milk' },
          change: {
            table: 'todos',
            id: 't1',
            op: OperationType.Put,
            data: { text: 'Buy milk' },
            timestamp: 1000,
            clientId: storage.clientId,
          },
        },
      ]);

      await storage.applyLocalChanges('todos', [
        {
          id: 't1',
          op: OperationType.Delete,
          change: {
            table: 'todos',
            id: 't1',
            op: OperationType.Delete,
            timestamp: 1002,
            clientId: storage.clientId,
          },
        },
      ]);

      const rec = await storage.getRecord('todos', 't1');
      expect(rec).toBeUndefined();

      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(2);
      expect(outbox[1].change.op).toBe(OperationType.Delete);
    });

    it('should remove acknowledged outbox entries by localIds', async () => {
      // Empty array should be no-op
      await storage.removeOutboxEntries([]);

      await storage.applyLocalChanges('todos', [
        {
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Task 1' },
          change: {
            table: 'todos',
            id: 't1',
            op: OperationType.Put,
            data: { text: 'Task 1' },
            timestamp: 1,
            clientId: storage.clientId,
          },
        },
        {
          id: 't2',
          op: OperationType.Put,
          data: { text: 'Task 2' },
          change: {
            table: 'todos',
            id: 't2',
            op: OperationType.Put,
            data: { text: 'Task 2' },
            timestamp: 2,
            clientId: storage.clientId,
          },
        },
      ]);

      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(2);

      const localIdToRemove = outbox[0].localId;
      expect(localIdToRemove).toBeDefined();
      if (localIdToRemove !== undefined) {
        await storage.removeOutboxEntries([localIdToRemove]);
      }

      const remaining = await storage.getPendingOutbox();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].change.id).toBe('t2');
    });
  });

  describe('applySnapshotBatch', () => {
    it('should apply snapshot across multiple tables and update sync sequence metadata atomically', async () => {
      await storage.applySnapshotBatch(
        [
          {
            table: 'todos',
            id: 'snap1',
            data: { title: 'Snap Todo' },
            timestamp: 500,
            version: 1,
          },
          {
            table: 'notes',
            id: 'snap2',
            data: { body: 'Snap Note' },
            timestamp: 501,
            version: 2,
          },
          {
            table: 'todos',
            id: 'snap3',
            data: { title: 'To Delete' },
            timestamp: 502,
            version: 1,
            deleted: true,
          },
        ],
        100,
      );

      const todoRec = await storage.getRecord('todos', 'snap1');
      expect(todoRec?.data).toEqual({ title: 'Snap Todo' });
      expect(todoRec?.timestamp).toBe(500);
      expect(todoRec?.version).toBe(1);

      const noteRec = await storage.getRecord('notes', 'snap2');
      expect(noteRec?.data).toEqual({ body: 'Snap Note' });

      const deletedRec = await storage.getRecord('todos', 'snap3');
      expect(deletedRec).toBeUndefined();

      expect(await storage.getMeta('lastSyncSeq')).toBe(100);
      expect(await storage.getMeta('lastSyncTimestamp')).toBeDefined();

      // Ensure no outbox entries were generated!
      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(0);
    });
  });

  describe('applyRemoteChangesBatch', () => {
    it('should update sequence metadata when incoming remote changes batch is empty', async () => {
      await storage.applyRemoteChangesBatch([], 250);
      expect(await storage.getMeta('lastSyncSeq')).toBe(250);
    });

    it('should apply delta changes (put & delete) across tables and update sequence without outbox echo', async () => {
      const changes: ChangeRecord[] = [
        {
          table: 'tasks',
          id: 'k1',
          op: OperationType.Put,
          data: { name: 'Remote Task 1' },
          timestamp: 600,
          version: 1,
          clientId: 'remote-client',
        },
        {
          table: 'tasks',
          id: 'k2',
          op: OperationType.Put,
          data: { name: 'Remote Task 2' },
          timestamp: 601,
          version: 1,
          clientId: 'remote-client',
        },
      ];

      await storage.applyRemoteChangesBatch(changes, 10);

      const k1 = await storage.getRecord('tasks', 'k1');
      expect(k1?.data).toEqual({ name: 'Remote Task 1' });
      expect(await storage.getMeta('lastSyncSeq')).toBe(10);

      // Now apply remote delete
      await storage.applyRemoteChangesBatch(
        [
          {
            table: 'tasks',
            id: 'k1',
            op: OperationType.Delete,
            timestamp: 602,
            version: 2,
            clientId: 'remote-client',
          },
        ],
        11,
      );

      expect(await storage.getRecord('tasks', 'k1')).toBeUndefined();
      expect(await storage.getRecord('tasks', 'k2')).toBeDefined();
      expect(await storage.getMeta('lastSyncSeq')).toBe(11);

      // No outbox entries generated
      const outbox = await storage.getPendingOutbox();
      expect(outbox).toHaveLength(0);
    });
  });

  describe('clearTables & clearAllData', () => {
    beforeEach(async () => {
      await storage.setMeta('user', 'alice');
      await storage.applyLocalChanges('todos', [
        {
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Clear test' },
          change: {
            table: 'todos',
            id: 't1',
            op: OperationType.Put,
            data: { text: 'Clear test' },
            timestamp: 1,
            clientId: storage.clientId,
          },
        },
      ]);
      await storage.applyLocalChanges('notes', [
        {
          id: 'n1',
          op: OperationType.Put,
          data: { text: 'Note test' },
          change: {
            table: 'notes',
            id: 'n1',
            op: OperationType.Put,
            data: { text: 'Note test' },
            timestamp: 1,
            clientId: storage.clientId,
          },
        },
      ]);
    });

    it('should clear user tables and preserve outbox when clearOutbox is false', async () => {
      await storage.clearTables(false);

      expect(await storage.getAllRecords('todos')).toHaveLength(0);
      expect(await storage.getAllRecords('notes')).toHaveLength(0);
      expect(await storage.getPendingOutbox()).toHaveLength(2);
      expect(await storage.getMeta('user')).toBe('alice');
    });

    it('should clear user tables and outbox while preserving metadata when clearOutbox is true', async () => {
      await storage.clearTables(true);

      expect(await storage.getAllRecords('todos')).toHaveLength(0);
      expect(await storage.getAllRecords('notes')).toHaveLength(0);
      expect(await storage.getPendingOutbox()).toHaveLength(0);
      expect(await storage.getMeta('user')).toBe('alice');
    });

    it('should clear all data including metadata and outbox on clearAllData', async () => {
      await storage.clearAllData();

      expect(await storage.getAllRecords('todos')).toHaveLength(0);
      expect(await storage.getAllRecords('notes')).toHaveLength(0);
      expect(await storage.getPendingOutbox()).toHaveLength(0);
      expect(await storage.getMeta('user')).toBeUndefined();
    });
  });

  describe('upgrade & transaction edge cases', () => {
    it('should auto-upgrade database if internal stores are missing', async () => {
      const dbName = 'tetherdb_no_internal_stores';
      // Create a DB manually with version 1 and NO internal stores
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('custom');
        };
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });

      const store = new Storage(dbName);
      const db = await store.getDatabase();
      expect(db.objectStoreNames.contains('__tether_outbox')).toBe(true);
      expect(db.objectStoreNames.contains('__tether_meta')).toBe(true);
      expect(db.objectStoreNames.contains('custom')).toBe(true);
      await store.close();
    });

    it('should update lastSyncSeq when applySnapshotBatch or applyRemoteChangesBatch receives empty array', async () => {
      await storage.applySnapshotBatch([], 42);
      expect(await storage.getMeta('lastSyncSeq')).toBe(42);

      await storage.applyRemoteChangesBatch([], 99);
      expect(await storage.getMeta('lastSyncSeq')).toBe(99);
    });

    it('should reset databasePromise and propagate error when openDatabase fails', async () => {
      const failingStorage = new Storage('failing-db');
      const originalOpen = indexedDB.open;

      // Mock open failure
      indexedDB.open = () => {
        const req = {} as IDBOpenDBRequest;
        setTimeout(() => {
          req.error = new DOMException('Disk quota exceeded');
          req.onerror?.(new Event('error'));
        }, 10);
        return req;
      };

      try {
        await expect(failingStorage.getDatabase()).rejects.toThrow();
      } finally {
        indexedDB.open = originalOpen;
      }

      // Reopening with restored indexedDB succeeds
      const db = await failingStorage.getDatabase();
      expect(db).toBeDefined();
      await failingStorage.close();
    });
  });

  describe('Dynamic Index Schema Migrations', () => {
    it('should create indexes in IndexedDB during ensureTable with indexes', async () => {
      const accounts = storage.table('accounts');
      accounts.index<string>('email', { unique: true });
      accounts.index<number>('age');

      await storage.ensureTable('accounts');

      const db = await storage.getDatabase();
      const tx = db.transaction('accounts', 'readonly');
      const store = tx.objectStore('accounts');

      expect(store.indexNames.contains('email')).toBe(true);
      expect(store.indexNames.contains('age')).toBe(true);

      const emailIdx = store.index('email');
      expect(emailIdx.unique).toBe(true);
      expect(emailIdx.keyPath).toBe('data.email');

      const ageIdx = store.index('age');
      expect(ageIdx.unique).toBe(false);
      expect(ageIdx.keyPath).toBe('data.age');
    });

    it('should dynamically add an index to an existing table with data and index existing records', async () => {
      // 1. Create table without indexes and insert records
      const usersTable = storage.table<{ name: string; score: number }>(
        'players',
      );
      await usersTable.put('p1', { name: 'Player 1', score: 100 });
      await usersTable.put('p2', { name: 'Player 2', score: 200 });

      let db = await storage.getDatabase();
      const v1 = db.version;

      // 2. Declare new index dynamically on the table
      const byScore = usersTable.index<number>('score');

      // 3. Query via index
      const rec = await byScore.get(200);
      expect(rec).toEqual({ name: 'Player 2', score: 200 });

      db = await storage.getDatabase();
      expect(db.version).toBeGreaterThan(v1);
    });

    it('should dynamically update an index definition when properties change', async () => {
      // Create initial index with unique: false
      const members = storage.table('members');
      members.index<string>('role', { unique: false });
      await storage.ensureTable('members');

      let db = await storage.getDatabase();
      let tx = db.transaction('members', 'readonly');
      let store = tx.objectStore('members');
      expect(store.index('role').unique).toBe(false);

      // Now upgrade with unique: true
      members.index<string>('role', { unique: true });
      await storage.ensureTable('members');

      db = await storage.getDatabase();
      tx = db.transaction('members', 'readonly');
      store = tx.objectStore('members');
      expect(store.index('role').unique).toBe(true);
    });

    it('should dynamically drop removed indexes while preserving table data', async () => {
      const table = storage.table<{ propA: string; propB: string }>('dataset');
      table.index<string>('propA');
      const idxB = table.index<string>('propB');

      await storage.ensureTable('dataset');
      await table.put('d1', { propA: 'Alpha', propB: 'Beta' });

      let db = await storage.getDatabase();
      let tx = db.transaction('dataset', 'readonly');
      let store = tx.objectStore('dataset');
      expect(store.indexNames.contains('propA')).toBe(true);
      expect(store.indexNames.contains('propB')).toBe(true);

      // Update schema to keep only idxB
      await storage.ensureTable('dataset', [idxB]);

      db = await storage.getDatabase();
      tx = db.transaction('dataset', 'readonly');
      store = tx.objectStore('dataset');
      expect(store.indexNames.contains('propA')).toBe(false);
      expect(store.indexNames.contains('propB')).toBe(true);

      // Data is intact
      const record = await table.get('d1');
      expect(record).toEqual({ propA: 'Alpha', propB: 'Beta' });
    });

    it('should normalize root and nested key paths correctly', async () => {
      const locations = storage.table('locations');
      locations.index<number>('timestamp');
      locations.index<string>('address.city');

      await storage.ensureTable('locations');

      const db = await storage.getDatabase();
      const tx = db.transaction('locations', 'readonly');
      const store = tx.objectStore('locations');

      // 'timestamp' is a top-level record metadata field so it shouldn't be prefixed with data.
      expect(store.index('timestamp').keyPath).toBe('timestamp');
      // 'address.city' should be prefixed with data.
      expect(store.index('address.city').keyPath).toBe('data.address.city');
    });

    it('should be a no-op if ensureTable is called with matching existing indexes', async () => {
      const coupons = storage.table('coupons');
      coupons.index<string>('code', { unique: true });
      await storage.ensureTable('coupons');

      const db1 = await storage.getDatabase();
      const v1 = db1.version;

      // Re-run ensureTable with same index definition
      await storage.ensureTable('coupons');

      const db2 = await storage.getDatabase();
      expect(db2.version).toBe(v1);
    });
  });
});
