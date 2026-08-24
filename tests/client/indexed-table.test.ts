import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Index,
  IndexedTable,
  IndexRange,
  type Table,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage.js';

interface UserProfile {
  username: string;
  email: string;
  age: number;
  tags?: string[];
  department?: string;
  role?: string;
  salary?: number;
  metadata?: {
    country?: string;
    city?: string;
  };
}

describe('Index & IndexedTable', () => {
  let storage: Storage;
  let table: Table<UserProfile>;

  const byUsername = new Index<string>('byUsername', 'username', {
    unique: true,
  });
  const byEmail = new Index<string>('byEmail', 'email', { unique: true });
  const byAge = new Index<number>('byAge', 'age');
  const byTags = new Index<string>('byTags', 'tags', { multiEntry: true });
  const byDeptAndRole = new Index<[string, string]>('byDeptRole', [
    'department',
    'role',
  ]);
  const byCountry = new Index<string>('byCountry', 'metadata.country');

  beforeEach(async () => {
    storage = new Storage(
      `test-idx-${Math.random().toString(36).substring(2, 8)}`,
    );
    table = storage.table<UserProfile>('users', [
      byUsername,
      byEmail,
      byAge,
      byTags,
      byDeptAndRole,
      byCountry,
    ]);
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('Index Definition & Properties', () => {
    it('should initialize with provided and default values', () => {
      const idxSimple = new Index('simple', 'title');
      expect(idxSimple.name).toBe('simple');
      expect(idxSimple.keyPath).toBe('title');
      expect(idxSimple.unique).toBe(false);
      expect(idxSimple.multiEntry).toBe(false);

      const idxComplex = new Index('complex', ['a', 'b'], {
        unique: true,
        multiEntry: false,
      });
      expect(idxComplex.name).toBe('complex');
      expect(idxComplex.keyPath).toEqual(['a', 'b']);
      expect(idxComplex.unique).toBe(true);
      expect(idxComplex.multiEntry).toBe(false);
    });

    it('should expose properties on IndexedTable', () => {
      const view = table.index(byUsername);
      expect(view).toBeInstanceOf(IndexedTable);
      expect(view.table).toBe(table);
      expect(view.index).toBe(byUsername);
      expect(view.name).toBe('byUsername');
      expect(view.keyPath).toBe('username');
      expect(view.unique).toBe(true);
      expect(view.multiEntry).toBe(false);
    });

    it('should fall back to constructing an Index instance if string is passed to table.index()', () => {
      const view = table.index('unknownIndex');
      expect(view.name).toBe('unknownIndex');
      expect(view.keyPath).toBe('unknownIndex');
      expect(view.unique).toBe(false);
      expect(view.multiEntry).toBe(false);
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
      const alice = await table.index(byUsername).get('alice');
      expect(alice).toBeDefined();
      expect(alice?.email).toBe('alice@example.com');
      expect(alice?.age).toBe(28);

      const bob = await table.index(byEmail).get('bob@example.com');
      expect(bob).toBeDefined();
      expect(bob?.username).toBe('bob');
    });

    it('should return undefined when key is not found', async () => {
      const result = await table.index(byUsername).get('charlie');
      expect(result).toBeUndefined();
    });

    it('should retrieve stored record with metadata', async () => {
      const record = await table
        .index(byEmail)
        .getWithMetadata('alice@example.com');
      expect(record).toBeDefined();
      expect(record?.id).toBe('u1');
      expect(record?.version).toBe(1);
      expect(record?.deleted).toBeFalsy();
      expect(record?.timestamp).toBeGreaterThan(0);
      expect(record?.data.username).toBe('alice');
    });

    it('should query nested properties', async () => {
      const swissUser = await table.index(byCountry).get('CH');
      expect(swissUser).toBeDefined();
      expect(swissUser?.username).toBe('alice');
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
      const all = await table.index(byAge).getAll();
      expect(all).toHaveLength(5);
      expect(all.map((u) => u.age)).toEqual([20, 25, 30, 35, 40]);
    });

    it('should return empty array when query does not match any record', async () => {
      const matched = await table.index(byAge).getAll(99);
      expect(matched).toEqual([]);
    });

    it('should retrieve records matching compound index key', async () => {
      const seniors = await table
        .index(byDeptAndRole)
        .getAll(['eng', 'senior']);
      expect(seniors).toHaveLength(2);
      expect(seniors.map((u) => u.username).sort()).toEqual(['b', 'd']);
    });

    it('should retrieve records matching multi-entry array index', async () => {
      const tsDevs = await table.index(byTags).getAll('ts');
      expect(tsDevs).toHaveLength(3);
      expect(tsDevs.map((u) => u.username).sort()).toEqual(['a', 'b', 'd']);

      const crmUsers = await table.index(byTags).getAll('crm');
      expect(crmUsers).toHaveLength(2);
      expect(crmUsers.map((u) => u.username).sort()).toEqual(['c', 'e']);
    });

    it('should retrieve records with storage metadata', async () => {
      const records = await table
        .index(byDeptAndRole)
        .getAllWithMetadata(['eng', 'senior']);
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
      const results = await table.index(byAge).getAll(range);
      expect(results).toHaveLength(1);
      expect(results[0].username).toBe('albert');
    });

    it('should query bounded ranges inclusive and exclusive', async () => {
      // Inclusive [25, 35]
      const inclusive = await table
        .index(byAge)
        .getAll(IndexRange.bound(25, 35, false, false));
      expect(inclusive.map((u) => u.age)).toEqual([25, 30, 35]);

      // Exclusive (25, 35)
      const exclusive = await table
        .index(byAge)
        .getAll(IndexRange.bound(25, 35, true, true));
      expect(exclusive.map((u) => u.age)).toEqual([30]);
    });

    it('should query lower and upper bounds', async () => {
      const lower = await table
        .index(byAge)
        .getAll(IndexRange.lowerBound(35, false));
      expect(lower.map((u) => u.age)).toEqual([35, 40]);

      const lowerOpen = await table
        .index(byAge)
        .getAll(IndexRange.lowerBound(35, true));
      expect(lowerOpen.map((u) => u.age)).toEqual([40]);

      const upper = await table
        .index(byAge)
        .getAll(IndexRange.upperBound(25, false));
      expect(upper.map((u) => u.age)).toEqual([20, 25]);
    });

    it('should query string prefixes with IndexRange.startsWith', async () => {
      const alPrefix = await table
        .index(byUsername)
        .getAll(IndexRange.startsWith('al'));
      expect(alPrefix.map((u) => u.username).sort()).toEqual([
        'albert',
        'alice',
      ]);

      const dPrefix = await table
        .index(byUsername)
        .getAll(IndexRange.startsWith('d'));
      expect(dPrefix.map((u) => u.username)).toEqual(['david']);

      const zPrefix = await table
        .index(byUsername)
        .getAll(IndexRange.startsWith('z'));
      expect(zPrefix).toEqual([]);
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
      const results = await table.index(byAge).getAll(undefined, { limit: 3 });
      expect(results.map((u) => u.age)).toEqual([10, 20, 30]);
    });

    it('should apply offset and limit together for pagination', async () => {
      const page1 = await table
        .index(byAge)
        .getAll(undefined, { offset: 0, limit: 3 });
      expect(page1.map((u) => u.age)).toEqual([10, 20, 30]);

      const page2 = await table
        .index(byAge)
        .getAll(undefined, { offset: 3, limit: 3 });
      expect(page2.map((u) => u.age)).toEqual([40, 50, 60]);

      const page4 = await table
        .index(byAge)
        .getAll(undefined, { offset: 9, limit: 3 });
      expect(page4.map((u) => u.age)).toEqual([100]);

      const outOfBounds = await table
        .index(byAge)
        .getAll(undefined, { offset: 20, limit: 5 });
      expect(outOfBounds).toEqual([]);
    });

    it('should iterate in reverse with direction: "prev"', async () => {
      const reversed = await table
        .index(byAge)
        .getAll(undefined, { direction: 'prev', limit: 4 });
      expect(reversed.map((u) => u.age)).toEqual([100, 90, 80, 70]);

      const reversedPaged = await table
        .index(byAge)
        .getAll(undefined, { direction: 'prev', offset: 2, limit: 3 });
      expect(reversedPaged.map((u) => u.age)).toEqual([80, 70, 60]);
    });

    it('should retrieve index keys with pagination and direction', async () => {
      const keys = await table
        .index(byAge)
        .getKeys(undefined, { offset: 1, limit: 3 });
      expect(keys).toEqual([20, 30, 40]);

      const reversedKeys = await table
        .index(byAge)
        .getKeys(undefined, { direction: 'prev', limit: 3 });
      expect(reversedKeys).toEqual([100, 90, 80]);
    });

    it('should retrieve primary record IDs with pagination and direction', async () => {
      const pkeys = await table
        .index(byAge)
        .getPrimaryKeys(undefined, { limit: 3 });
      expect(pkeys).toEqual(['id-1', 'id-2', 'id-3']);

      const reversedPKeys = await table
        .index(byAge)
        .getPrimaryKeys(undefined, { direction: 'prev', limit: 3 });
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
      const total = await table.index(byAge).count();
      expect(total).toBe(3);
    });

    it('should count exact matches', async () => {
      const count = await table.index(byAge).count(25);
      expect(count).toBe(1);
    });

    it('should count range matches', async () => {
      const count = await table.index(byAge).count(IndexRange.lowerBound(25));
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
      const unsubscribe = table.index(byTags).subscribe('eng', (items) => {
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

      const unsubDev = table.index(byTags).subscribe('dev', (items) => {
        devSnapshots.push(items);
      });
      const unsubOps = table.index(byTags).subscribe('ops', (items) => {
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
  });
});
