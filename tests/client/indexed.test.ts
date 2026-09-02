import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Index,
  IndexDirection,
  IndexRange,
  type Table,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage/storage.js';

interface UserProfile {
  username: string;
  email: string;
  age: number;
  tags?: string[];
  department?: string;
  role?: string;
  salary?: number;
  metadata?: {
    country: string;
    city: string;
  };
}

describe('Index', () => {
  let storage: Storage;
  let table: Table<UserProfile>;

  let byUsername: Index<UserProfile, string>;
  let byEmail: Index<UserProfile, string>;
  let byAge: Index<UserProfile, number>;
  let byTags: Index<UserProfile, string>;
  let byDeptAndRole: Index<UserProfile, [string, string]>;
  let byCountry: Index<UserProfile, string>;
  let byCity: Index<UserProfile, string>;

  beforeEach(async () => {
    storage = new Storage(
      `test-idx-${Math.random().toString(36).substring(2, 8)}`,
    );
    table = storage.table<UserProfile>('users');
    byUsername = table.index<string>('username', { unique: true });
    byEmail = table.index<string>('email', { unique: true });
    byAge = table.index<number>('age');
    byTags = table.index<string>('tags', { multiEntry: true });
    byDeptAndRole = table.index<[string, string]>(['department', 'role']);
    byCountry = table.index<string>('metadata.country');
    byCity = table.index<string>('metadata.city');
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('Index Definition & Properties', () => {
    it('should initialize with keyPath and infer default name', () => {
      const idxSimple = table.index('title');
      expect(idxSimple.name).toBe('title');
      expect(idxSimple.keyPath).toBe('title');
      expect(idxSimple.unique).toBe(false);
      expect(idxSimple.multiEntry).toBe(false);
      expect(idxSimple.table).toBe(table);

      const idxComplex = table.index(['a', 'b'], {
        unique: true,
        multiEntry: false,
      });
      expect(idxComplex.name).toBe('a,b');
      expect(idxComplex.keyPath).toEqual(['a', 'b']);
      expect(idxComplex.unique).toBe(true);
      expect(idxComplex.multiEntry).toBe(false);

      const idxCustomName = table.index('email_field', {
        name: 'customEmail',
        unique: true,
      });
      expect(idxCustomName.name).toBe('customEmail');
      expect(idxCustomName.keyPath).toBe('email_field');
      expect(idxCustomName.unique).toBe(true);
    });

    it('should expose properties on Index', () => {
      expect(byUsername).toBeInstanceOf(Index);
      expect(byUsername.table).toBe(table);
      expect(byUsername.name).toBe('username');
      expect(byUsername.keyPath).toBe('username');
      expect(byUsername.unique).toBe(true);
      expect(byUsername.multiEntry).toBe(false);
    });

    it('should register and return bound Index by keyPath and options', async () => {
      const emailIndex = table.index<string>('email', { unique: true });
      expect(emailIndex).toBeInstanceOf(Index);
      expect(emailIndex.name).toBe('email');
      expect(emailIndex.unique).toBe(true);
      expect(emailIndex.table).toBe(table);

      // Subsequent call retrieves existing index
      const sameIndex = table.index<string>('email');
      expect(sameIndex.unique).toBe(true);
    });

    it('should support fluent user pattern: table -> index -> query/subscribe', async () => {
      const freshTable = storage.table<UserProfile>('fluent_users');
      const email = freshTable.index<string>('email', { unique: true });
      const age = freshTable.index<number>('age');

      await freshTable.put('u1', {
        username: 'alice',
        email: 'alice@example.com',
        age: 21,
      });

      const adult = await age.get(21);
      expect(adult?.username).toBe('alice');

      const allAdults = await age.getAll(IndexRange.greaterThan(18));
      expect(allAdults).toHaveLength(1);

      const count = await age.count();
      expect(count).toBe(1);

      const listener = vi.fn();
      const unsubscribe = email.subscribe('alice@example.com', listener);
      await new Promise((r) => setTimeout(r, 5));
      expect(listener).toHaveBeenCalledWith([
        expect.objectContaining({ username: 'alice' }),
      ]);
      unsubscribe();
    });
  });

  describe('Single Record Lookups: get & getWithMetadata', () => {
    beforeEach(async () => {
      await table.putAll([
        {
          id: 'u1',
          data: {
            username: 'alice',
            email: 'alice@example.com',
            age: 28,
            tags: ['dev', 'lead'],
            department: 'eng',
            role: 'engineer',
            metadata: { country: 'CH', city: 'Zurich' },
          },
        },
        {
          id: 'u2',
          data: {
            username: 'bob',
            email: 'bob@example.com',
            age: 35,
            tags: ['ops'],
            department: 'ops',
            role: 'manager',
            metadata: { country: 'US', city: 'New York' },
          },
        },
      ]);
    });

    it('should retrieve record payload by exact key', async () => {
      const alice = await byUsername.get('alice');
      expect(alice).toBeDefined();
      expect(alice?.email).toBe('alice@example.com');
      expect(alice?.age).toBe(28);

      const bob = await byEmail.get('bob@example.com');
      expect(bob).toBeDefined();
      expect(bob?.username).toBe('bob');
    });

    it('should return undefined when key is not found', async () => {
      const result = await byUsername.get('charlie');
      expect(result).toBeUndefined();
    });

    it('should retrieve stored record with metadata', async () => {
      const record = await byEmail.getWithMetadata('alice@example.com');
      expect(record).toBeDefined();
      expect(record?.id).toBe('u1');
      expect(record?.version).toBe(1);
      expect(record?.deleted).toBeFalsy();
      expect(record?.timestamp).toBeGreaterThan(0);
      expect(record?.data.username).toBe('alice');
    });

    it('should query nested properties', async () => {
      const swissUser = await byCountry.get('CH');
      expect(swissUser).toBeDefined();
      expect(swissUser?.username).toBe('alice');

      const zurichUser = await byCity.get('Zurich');
      expect(zurichUser).toBeDefined();
      expect(zurichUser?.username).toBe('alice');
    });
  });

  describe('Multiple Records Lookups: getAll & getAllWithMetadata', () => {
    beforeEach(async () => {
      await table.putAll([
        {
          id: '1',
          data: {
            username: 'a',
            email: 'a@x.com',
            age: 20,
            department: 'eng',
            role: 'junior',
            tags: ['js', 'ts'],
          },
        },
        {
          id: '2',
          data: {
            username: 'b',
            email: 'b@x.com',
            age: 25,
            department: 'eng',
            role: 'senior',
            tags: ['ts', 'go'],
          },
        },
        {
          id: '3',
          data: {
            username: 'c',
            email: 'c@x.com',
            age: 30,
            department: 'sales',
            role: 'lead',
            tags: ['crm'],
          },
        },
        {
          id: '4',
          data: {
            username: 'd',
            email: 'd@x.com',
            age: 35,
            department: 'eng',
            role: 'senior',
            tags: ['ts', 'rust'],
          },
        },
        {
          id: '5',
          data: {
            username: 'e',
            email: 'e@x.com',
            age: 40,
            department: 'sales',
            role: 'rep',
            tags: ['crm', 'lead'],
          },
        },
      ]);
    });

    it('should return all records when query is omitted', async () => {
      const all = await byAge.getAll();
      expect(all).toHaveLength(5);
      expect(all.map((u) => u.age)).toEqual([20, 25, 30, 35, 40]);
    });

    it('should return empty array when query does not match any record', async () => {
      const matched = await byAge.getAll(99);
      expect(matched).toEqual([]);
    });

    it('should retrieve records matching compound index key', async () => {
      const seniors = await byDeptAndRole.getAll(['eng', 'senior']);
      expect(seniors).toHaveLength(2);
      expect(seniors.map((u) => u.username).sort()).toEqual(['b', 'd']);
    });

    it('should retrieve records matching multi-entry array index', async () => {
      const tsDevs = await byTags.getAll('ts');
      expect(tsDevs).toHaveLength(3);
      expect(tsDevs.map((u) => u.username).sort()).toEqual(['a', 'b', 'd']);

      const crmUsers = await byTags.getAll('crm');
      expect(crmUsers).toHaveLength(2);
      expect(crmUsers.map((u) => u.username).sort()).toEqual(['c', 'e']);
    });

    it('should retrieve records with storage metadata', async () => {
      const records = await byDeptAndRole.getAllWithMetadata(['eng', 'senior']);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.id).sort()).toEqual(['2', '4']);
      expect(records.every((r) => r.version === 1)).toBe(true);
    });
  });

  describe('IndexRange & Range Queries', () => {
    beforeEach(async () => {
      await table.putAll([
        { id: '1', data: { username: 'alice', email: 'alice@x.com', age: 20 } },
        {
          id: '2',
          data: { username: 'albert', email: 'albert@x.com', age: 25 },
        },
        { id: '3', data: { username: 'bob', email: 'bob@x.com', age: 30 } },
        {
          id: '4',
          data: { username: 'charlie', email: 'charlie@x.com', age: 35 },
        },
        { id: '5', data: { username: 'david', email: 'david@x.com', age: 40 } },
      ]);
    });

    it('should construct and query IndexRange.only', async () => {
      const range = IndexRange.only(25);
      const results = await byAge.getAll(range);
      expect(results).toHaveLength(1);
      expect(results[0].username).toBe('albert');
    });

    it('should query bounded ranges inclusive and exclusive', async () => {
      // Inclusive [25, 35]
      const inclusive = await byAge.getAll(
        IndexRange.bound(25, 35, false, false),
      );
      expect(inclusive.map((u) => u.age)).toEqual([25, 30, 35]);

      // Exclusive (25, 35)
      const exclusive = await byAge.getAll(
        IndexRange.bound(25, 35, true, true),
      );
      expect(exclusive.map((u) => u.age)).toEqual([30]);
    });

    it('should query lower and upper bounds', async () => {
      const lower = await byAge.getAll(IndexRange.lowerBound(35, false));
      expect(lower.map((u) => u.age)).toEqual([35, 40]);

      const lowerOpen = await byAge.getAll(IndexRange.lowerBound(35, true));
      expect(lowerOpen.map((u) => u.age)).toEqual([40]);

      const upper = await byAge.getAll(IndexRange.upperBound(25, false));
      expect(upper.map((u) => u.age)).toEqual([20, 25]);
    });

    it('should query string prefixes with IndexRange.startsWith', async () => {
      const alPrefix = await byUsername.getAll(IndexRange.startsWith('al'));
      expect(alPrefix.map((u) => u.username).sort()).toEqual([
        'albert',
        'alice',
      ]);

      const dPrefix = await byUsername.getAll(IndexRange.startsWith('d'));
      expect(dPrefix.map((u) => u.username)).toEqual(['david']);

      const zPrefix = await byUsername.getAll(IndexRange.startsWith('z'));
      expect(zPrefix).toEqual([]);
    });

    it('should query ranges using between, greaterThan, and lessThan helper methods', async () => {
      // between inclusive
      const betweenInc = await byAge.getAll(IndexRange.between(25, 35, true));
      expect(betweenInc.map((u) => u.age)).toEqual([25, 30, 35]);

      // between exclusive
      const betweenExc = await byAge.getAll(IndexRange.between(25, 35, false));
      expect(betweenExc.map((u) => u.age)).toEqual([30]);

      // greaterThan inclusive vs exclusive
      const gtInc = await byAge.getAll(IndexRange.greaterThan(35, true));
      expect(gtInc.map((u) => u.age)).toEqual([35, 40]);

      const gtExc = await byAge.getAll(IndexRange.greaterThan(35, false));
      expect(gtExc.map((u) => u.age)).toEqual([40]);

      // lessThan inclusive vs exclusive
      const ltInc = await byAge.getAll(IndexRange.lessThan(25, true));
      expect(ltInc.map((u) => u.age)).toEqual([20, 25]);

      const ltExc = await byAge.getAll(IndexRange.lessThan(25, false));
      expect(ltExc.map((u) => u.age)).toEqual([20]);
    });
  });

  describe('Pagination, Limit, Offset, and Direction', () => {
    beforeEach(async () => {
      const entries = [];
      for (let i = 1; i <= 10; i++) {
        entries.push({
          id: `id-${i}`,
          data: {
            username: `user_${String(i).padStart(2, '0')}`,
            email: `u${i}@x.com`,
            age: i * 10,
          },
        });
      }
      await table.putAll(entries);
    });

    it('should limit result count', async () => {
      const results = await byAge.getAll(undefined, { limit: 3 });
      expect(results.map((u) => u.age)).toEqual([10, 20, 30]);
    });

    it('should apply offset and limit together for pagination', async () => {
      const page1 = await byAge.getAll(undefined, { offset: 0, limit: 3 });
      expect(page1.map((u) => u.age)).toEqual([10, 20, 30]);

      const page2 = await byAge.getAll(undefined, { offset: 3, limit: 3 });
      expect(page2.map((u) => u.age)).toEqual([40, 50, 60]);

      const page4 = await byAge.getAll(undefined, { offset: 9, limit: 3 });
      expect(page4.map((u) => u.age)).toEqual([100]);

      const outOfBounds = await byAge.getAll(undefined, {
        offset: 20,
        limit: 5,
      });
      expect(outOfBounds).toEqual([]);
    });

    it('should expose IndexDirection enum values properly', () => {
      expect(IndexDirection.Next).toBe('next');
      expect(IndexDirection.NextUnique).toBe('nextunique');
      expect(IndexDirection.Prev).toBe('prev');
      expect(IndexDirection.PrevUnique).toBe('prevunique');
    });

    it('should iterate in reverse with IndexDirection.Prev', async () => {
      const reversed = await byAge.getAll(undefined, {
        direction: IndexDirection.Prev,
        limit: 4,
      });
      expect(reversed.map((u) => u.age)).toEqual([100, 90, 80, 70]);

      const reversedPaged = await byAge.getAll(undefined, {
        direction: IndexDirection.Prev,
        offset: 2,
        limit: 3,
      });
      expect(reversedPaged.map((u) => u.age)).toEqual([80, 70, 60]);
    });

    it('should retrieve index keys with pagination and direction', async () => {
      const keys = await byAge.getKeys(undefined, { offset: 1, limit: 3 });
      expect(keys).toEqual([20, 30, 40]);

      const reversedKeys = await byAge.getKeys(undefined, {
        direction: IndexDirection.Prev,
        limit: 3,
      });
      expect(reversedKeys).toEqual([100, 90, 80]);
    });

    it('should retrieve primary record IDs with pagination and direction', async () => {
      const pkeys = await byAge.getPrimaryKeys(undefined, { limit: 3 });
      expect(pkeys).toEqual(['id-1', 'id-2', 'id-3']);

      const reversedPKeys = await byAge.getPrimaryKeys(undefined, {
        direction: IndexDirection.Prev,
        limit: 3,
      });
      expect(reversedPKeys).toEqual(['id-10', 'id-9', 'id-8']);
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      await table.putAll([
        {
          id: '1',
          data: { username: 'a', email: 'a@x.com', age: 20, department: 'eng' },
        },
        {
          id: '2',
          data: { username: 'b', email: 'b@x.com', age: 25, department: 'eng' },
        },
        {
          id: '3',
          data: {
            username: 'c',
            email: 'c@x.com',
            age: 30,
            department: 'sales',
          },
        },
      ]);
    });

    it('should return total count when query is omitted', async () => {
      const total = await byAge.count();
      expect(total).toBe(3);
    });

    it('should count exact matches', async () => {
      const count = await byAge.count(25);
      expect(count).toBe(1);
    });

    it('should count range matches', async () => {
      const count = await byAge.count(IndexRange.lowerBound(25));
      expect(count).toBe(2);
    });
  });

  describe('Reactive Subscriptions: index.subscribe', () => {
    it('should notify subscriber on initial load and whenever table records mutate', async () => {
      await table.put('1', {
        username: 'alice',
        email: 'alice@x.com',
        age: 25,
        tags: ['eng'],
      });

      const snapshots: UserProfile[][] = [];
      const unsubscribe = byTags.subscribe('eng', (items) => {
        snapshots.push(items);
      });

      // Wait for initial async fetch
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual([
        expect.objectContaining({ username: 'alice' }),
      ]);

      // Add another matching item
      await table.put('2', {
        username: 'bob',
        email: 'bob@x.com',
        age: 30,
        tags: ['eng'],
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]).toHaveLength(2);

      // Add a non-matching item
      await table.put('3', {
        username: 'charlie',
        email: 'charlie@x.com',
        age: 35,
        tags: ['marketing'],
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(3);
      expect(snapshots[2]).toHaveLength(2); // Same filtered list

      // Delete a matching item
      await table.delete('1');
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(4);
      expect(snapshots[3]).toHaveLength(1);
      expect(snapshots[3][0].username).toBe('bob');

      // Unsubscribe halts notifications
      unsubscribe();
      await table.put('4', {
        username: 'david',
        email: 'david@x.com',
        age: 40,
        tags: ['eng'],
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots).toHaveLength(4);
    });

    it('should support multiple concurrent subscriptions with different query filters', async () => {
      const devSnapshots: UserProfile[][] = [];
      const opsSnapshots: UserProfile[][] = [];

      const unsubDev = byTags.subscribe('dev', (items) => {
        devSnapshots.push(items);
      });
      const unsubOps = byTags.subscribe('ops', (items) => {
        opsSnapshots.push(items);
      });

      await table.put('u1', {
        username: 'dev_user',
        email: 'd@x.com',
        age: 22,
        tags: ['dev'],
      });
      await table.put('u2', {
        username: 'ops_user',
        email: 'o@x.com',
        age: 33,
        tags: ['ops'],
      });

      await new Promise((r) => setTimeout(r, 5));

      expect(devSnapshots[devSnapshots.length - 1]).toEqual([
        expect.objectContaining({ username: 'dev_user' }),
      ]);
      expect(opsSnapshots[opsSnapshots.length - 1]).toEqual([
        expect.objectContaining({ username: 'ops_user' }),
      ]);

      unsubDev();
      unsubOps();
    });

    it('should update subscribers when table is cleared via table.clear()', async () => {
      await table.putAll([
        {
          id: '1',
          data: { username: 'u1', email: 'u1@x.com', age: 20, tags: ['ts'] },
        },
        {
          id: '2',
          data: { username: 'u2', email: 'u2@x.com', age: 25, tags: ['ts'] },
        },
      ]);

      const snapshots: UserProfile[][] = [];
      const unsubscribe = byTags.subscribe('ts', (items) => {
        snapshots.push(items);
      });

      await new Promise((r) => setTimeout(r, 2));
      expect(snapshots[snapshots.length - 1]).toHaveLength(2);

      await table.clear();
      await new Promise((r) => setTimeout(r, 2));

      expect(snapshots[snapshots.length - 1]).toHaveLength(0);
      unsubscribe();
    });

    it('should not invoke listener if unsubscribed before initial async fetch completes', async () => {
      await table.put('1', { username: 'alice', email: 'a@x.com', age: 20 });

      const listener = vi.fn();
      const unsubscribe = byUsername.subscribe('alice', listener);
      unsubscribe();

      await new Promise((r) => setTimeout(r, 5));
      expect(listener).not.toHaveBeenCalled();
    });

    it('should silently handle error if getAll fails inside subscribe without calling listener', async () => {
      const getAllSpy = vi
        .spyOn(byUsername, 'getAll')
        .mockRejectedValue(new Error('Index storage failure'));

      const listener = vi.fn();
      const unsub = byUsername.subscribe('alice', listener);

      await new Promise((r) => setTimeout(r, 5));
      expect(listener).not.toHaveBeenCalled();
      unsub();
      getAllSpy.mockRestore();
    });
  });

  describe('Edge Cases & Metadata Retrieval Options', () => {
    it('should retrieve records with metadata using pagination and reverse direction', async () => {
      await table.putAll([
        { id: '1', data: { username: 'a', email: 'a@x.com', age: 10 } },
        { id: '2', data: { username: 'b', email: 'b@x.com', age: 20 } },
        { id: '3', data: { username: 'c', email: 'c@x.com', age: 30 } },
        { id: '4', data: { username: 'd', email: 'd@x.com', age: 40 } },
      ]);

      const pagedMeta = await byAge.getAllWithMetadata(undefined, {
        direction: IndexDirection.Prev,
        offset: 1,
        limit: 2,
      });
      expect(pagedMeta).toHaveLength(2);
      expect(pagedMeta[0].id).toBe('3');
      expect(pagedMeta[0].data.age).toBe(30);
      expect(pagedMeta[1].id).toBe('2');
      expect(pagedMeta[1].data.age).toBe(20);
    });

    it('should handle lookups on completely empty tables', async () => {
      const single = await byUsername.get('missing');
      expect(single).toBeUndefined();

      const meta = await byUsername.getWithMetadata('missing');
      expect(meta).toBeUndefined();

      const all = await byUsername.getAll();
      expect(all).toEqual([]);

      const allMeta = await byUsername.getAllWithMetadata();
      expect(allMeta).toEqual([]);

      const keys = await byUsername.getKeys();
      expect(keys).toEqual([]);

      const pkeys = await byUsername.getPrimaryKeys();
      expect(pkeys).toEqual([]);

      const count = await byUsername.count();
      expect(count).toBe(0);
    });
  });
});
