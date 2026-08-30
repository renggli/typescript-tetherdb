import { describe, expect, it } from 'vitest';
import {
  filterAndSanitizeChanges,
  filterAndSanitizeSnapshot,
  isPermissionAllowed,
  sanitizeStoredRecord,
} from '../../../src/server/security/filter.js';
import { UserResolver } from '../../../src/server/security/resolver.js';
import type {
  InternalChangeRecord,
  InternalStoredRecord,
} from '../../../src/server/security/types.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { OperationType, Permission } from '../../../src/shared/types.js';

describe('Security Filter & Fattening Pipeline', () => {
  describe('isPermissionAllowed', () => {
    it('evaluates Everybody permission', async () => {
      const storage = new MemoryStorage();
      const user = await storage.createUser('alice', 'pass123');

      expect(isPermissionAllowed(Permission.Everybody, undefined)).toBe(true);
      expect(isPermissionAllowed(Permission.Everybody, user, 'other')).toBe(
        true,
      );
    });

    it('evaluates Authenticated permission', async () => {
      const storage = new MemoryStorage();
      const user = await storage.createUser('alice', 'pass123');

      expect(isPermissionAllowed(Permission.Authenticated, undefined)).toBe(
        false,
      );
      expect(isPermissionAllowed(Permission.Authenticated, user)).toBe(true);
    });

    it('evaluates Owner permission', async () => {
      const storage = new MemoryStorage();
      const alice = await storage.createUser('alice', 'pass123');

      expect(isPermissionAllowed(Permission.Owner, undefined)).toBe(false);
      expect(isPermissionAllowed(Permission.Owner, alice, alice.userId)).toBe(
        true,
      );
      expect(isPermissionAllowed(Permission.Owner, alice, 'other-id')).toBe(
        false,
      );
      expect(isPermissionAllowed(Permission.Owner, alice, undefined)).toBe(
        true,
      );
    });

    it('evaluates Nobody permission', async () => {
      const storage = new MemoryStorage();
      const alice = await storage.createUser('alice', 'pass123');

      expect(isPermissionAllowed(Permission.Nobody, undefined)).toBe(false);
      expect(isPermissionAllowed(Permission.Nobody, alice)).toBe(false);
    });
  });

  describe('sanitizeStoredRecord', () => {
    it('strips internal userId and fattens userName', async () => {
      const storage = new MemoryStorage();
      const user = await storage.createUser('alice', 'pass123');
      const resolver = new UserResolver(storage);

      const raw: InternalStoredRecord = {
        id: 'rec-1',
        data: { hello: 'world' },
        version: 1,
        timestamp: 1000,
        clientId: 'c1',
        userId: user.userId,
      };

      const sanitized = await sanitizeStoredRecord(raw, resolver);
      expect(sanitized).toEqual({
        id: 'rec-1',
        data: { hello: 'world' },
        version: 1,
        timestamp: 1000,
        clientId: 'c1',
        userName: 'alice',
      });
      expect((sanitized as Record<string, unknown>).userId).toBeUndefined();
    });
  });

  describe('filterAndSanitizeSnapshot', () => {
    it('filters private tables and enriches records without leaking userId', async () => {
      const storage = new MemoryStorage();
      const alice = await storage.createUser('alice', 'pass123');
      const bob = await storage.createUser('bob', 'pass123');
      const resolver = new UserResolver(storage);

      const pubTable = await storage.createTable('public_notes', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });
      const privTable = await storage.createTable('private_secrets', {
        permissions: {
          read: Permission.Owner,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });

      await pubTable.applyChanges(alice, [
        {
          table: 'public_notes',
          id: 'p1',
          op: OperationType.Put,
          data: { text: 'public note' },
          timestamp: 1000,
        },
      ]);

      await privTable.applyChanges(alice, [
        {
          table: 'private_secrets',
          id: 's1',
          op: OperationType.Put,
          data: { secret: 'alice private' },
          timestamp: 1000,
        },
      ]);

      const tables = await storage.getTables();

      // Alice's snapshot
      const aliceSnapshot = await filterAndSanitizeSnapshot(
        tables,
        alice,
        resolver,
      );
      expect(aliceSnapshot).toHaveLength(2);
      expect(aliceSnapshot.map((r) => r.id)).toContain('p1');
      expect(aliceSnapshot.map((r) => r.id)).toContain('s1');
      for (const item of aliceSnapshot) {
        expect((item as Record<string, unknown>).userId).toBeUndefined();
      }

      // Bob's snapshot: should only see public note
      const bobSnapshot = await filterAndSanitizeSnapshot(
        tables,
        bob,
        resolver,
      );
      expect(bobSnapshot).toHaveLength(1);
      expect(bobSnapshot[0].id).toBe('p1');

      // Guest snapshot
      const guestSnapshot = await filterAndSanitizeSnapshot(
        tables,
        undefined,
        resolver,
      );
      expect(guestSnapshot).toHaveLength(1);
      expect(guestSnapshot[0].id).toBe('p1');
    });
  });

  describe('filterAndSanitizeChanges', () => {
    it('filters private changelog records and attaches author userName', async () => {
      const storage = new MemoryStorage();
      const alice = await storage.createUser('alice', 'pass123');
      const bob = await storage.createUser('bob', 'pass123');
      const resolver = new UserResolver(storage);

      await storage.createTable('shared', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });
      await storage.createTable('private', {
        permissions: {
          read: Permission.Owner,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });

      const rawChanges: InternalChangeRecord[] = [
        {
          seq: 1,
          table: 'shared',
          id: 'r1',
          op: OperationType.Put,
          data: { x: 1 },
          version: 1,
          timestamp: 1000,
          clientId: 'c1',
          userId: alice.userId,
        },
        {
          seq: 2,
          table: 'private',
          id: 'p1',
          op: OperationType.Put,
          data: { secret: 'secret' },
          version: 1,
          timestamp: 2000,
          clientId: 'c1',
          userId: alice.userId,
        },
      ];

      const tableLookup = (name: string) => storage.getTable(name);

      // Alice receives both
      const aliceChanges = await filterAndSanitizeChanges(
        rawChanges,
        alice,
        tableLookup,
        resolver,
      );
      expect(aliceChanges).toHaveLength(2);
      expect(aliceChanges[0].userName).toBe('alice');
      expect(aliceChanges[1].userName).toBe('alice');
      expect(
        (aliceChanges[0] as Record<string, unknown>).userId,
      ).toBeUndefined();

      // Bob only receives shared
      const bobChanges = await filterAndSanitizeChanges(
        rawChanges,
        bob,
        tableLookup,
        resolver,
      );
      expect(bobChanges).toHaveLength(1);
      expect(bobChanges[0].id).toBe('r1');
      expect(bobChanges[0].userName).toBe('alice');

      // Table filter works
      const filtered = await filterAndSanitizeChanges(
        rawChanges,
        alice,
        tableLookup,
        resolver,
        ['private'],
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].table).toBe('private');
    });
  });
});
