import { describe, expect, it } from 'vitest';
import {
  MemoryStorage,
  TetherServerError,
  type UserStorage,
} from '../../../../src/server/index.js';
import {
  applyChangeToRecord,
  assertCanMutate,
  canRead,
  canReadRecord,
  filterActiveRecords,
  isPermissionAllowed,
  isPrivateTable,
} from '../../../../src/server/storage/base/table.js';
import {
  type ChangeRecord,
  OperationType,
  Permission,
  type StoredRecord,
} from '../../../../src/shared/types.js';

describe('TableBaseStorage helpers & permissions', () => {
  const mockUser: UserStorage = {
    id: 'usr-123',
    username: 'alice',
    createdAt: Date.now(),
    verifyPassword: async () => true,
    changePassword: async () => {},
    delete: async () => true,
  };

  const otherUser: UserStorage = {
    id: 'usr-456',
    username: 'bob',
    createdAt: Date.now(),
    verifyPassword: async () => true,
    changePassword: async () => {},
    delete: async () => true,
  };

  describe('isPermissionAllowed', () => {
    it('should evaluate Permission.Everybody', () => {
      expect(
        isPermissionAllowed(Permission.Everybody, undefined, undefined),
      ).toBe(true);
      expect(
        isPermissionAllowed(Permission.Everybody, mockUser, 'someone'),
      ).toBe(true);
    });

    it('should evaluate Permission.Authenticated', () => {
      expect(isPermissionAllowed(Permission.Authenticated, undefined)).toBe(
        false,
      );
      expect(isPermissionAllowed(Permission.Authenticated, mockUser)).toBe(
        true,
      );
    });

    it('should evaluate Permission.Owner', () => {
      expect(isPermissionAllowed(Permission.Owner, undefined)).toBe(false);
      expect(isPermissionAllowed(Permission.Owner, mockUser, 'usr-123')).toBe(
        true,
      );
      expect(isPermissionAllowed(Permission.Owner, mockUser, 'usr-other')).toBe(
        false,
      );
      expect(isPermissionAllowed(Permission.Owner, mockUser, undefined)).toBe(
        true,
      );
    });

    it('should evaluate Permission.Nobody', () => {
      expect(isPermissionAllowed(Permission.Nobody, undefined)).toBe(false);
      expect(isPermissionAllowed(Permission.Nobody, mockUser)).toBe(false);
    });
  });

  describe('isPrivateTable', () => {
    it('should identify private and public tables', async () => {
      const storage = new MemoryStorage();
      const privateTable = await storage.createTable('priv');
      const publicTable = await storage.createTable('pub', {
        permissions: { read: Permission.Everybody },
      });

      expect(isPrivateTable(privateTable)).toBe(true);
      expect(isPrivateTable(publicTable)).toBe(false);
    });
  });

  describe('filterActiveRecords', () => {
    it('should filter out deleted records and attach table name', () => {
      const records: StoredRecord[] = [
        {
          id: '1',
          version: 1,
          timestamp: 100,
          clientId: 'c1',
          deleted: false,
          data: { a: 1 },
        },
        {
          id: '2',
          version: 2,
          timestamp: 200,
          clientId: 'c1',
          deleted: true,
          data: null,
        },
      ];

      const active = filterActiveRecords('items', records);
      expect(active).toHaveLength(1);
      expect(active[0]).toEqual({
        table: 'items',
        id: '1',
        version: 1,
        timestamp: 100,
        clientId: 'c1',
        deleted: false,
        data: { a: 1 },
      });
    });
  });

  describe('applyChangeToRecord', () => {
    it('should calculate updated record and applied change for put and delete', () => {
      const putChange: ChangeRecord = {
        table: 'items',
        id: 'rec-1',
        op: OperationType.Put,
        timestamp: 1000,
        clientId: 'c1',
        data: { name: 'Item' },
      };

      const result1 = applyChangeToRecord(putChange, undefined, 1, mockUser);
      expect(result1.updatedRecord.version).toBe(1);
      expect(result1.updatedRecord.ownerId).toBe('usr-123');
      expect(result1.appliedChange.seq).toBe(1);
      expect(result1.appliedChange.data).toEqual({ name: 'Item' });

      const delChange: ChangeRecord = {
        table: 'items',
        id: 'rec-1',
        op: OperationType.Delete,
        timestamp: 2000,
        clientId: 'c1',
      };

      const result2 = applyChangeToRecord(
        delChange,
        result1.updatedRecord,
        2,
        mockUser,
      );
      expect(result2.updatedRecord.version).toBe(2);
      expect(result2.updatedRecord.deleted).toBe(true);
      expect(result2.updatedRecord.data).toBeNull();
      expect(result2.appliedChange.data).toBeUndefined();
    });
  });

  describe('assertCanMutate, canRead, and canReadRecord', () => {
    it('should throw Forbidden on unauthorized delete', async () => {
      const storage = new MemoryStorage();
      const table = await storage.createTable('tasks');

      const existingRecord: StoredRecord = {
        id: 't1',
        version: 1,
        timestamp: 100,
        clientId: 'c1',
        ownerId: mockUser.id,
      };

      const delChange: ChangeRecord = {
        table: 'tasks',
        id: 't1',
        op: OperationType.Delete,
        timestamp: 200,
        clientId: 'c2',
      };

      // Other user cannot delete owner record
      expect(() =>
        assertCanMutate(table, otherUser, delChange, existingRecord),
      ).toThrow(TetherServerError);

      // Owner can delete
      expect(() =>
        assertCanMutate(table, mockUser, delChange, existingRecord),
      ).not.toThrow();
    });

    it('should throw Forbidden on unauthorized create or update', async () => {
      const storage = new MemoryStorage();
      const table = await storage.createTable('tasks');

      const putChange: ChangeRecord = {
        table: 'tasks',
        id: 't1',
        op: OperationType.Put,
        timestamp: 200,
        clientId: 'c1',
        data: { text: 'New' },
      };

      // Unauthenticated user cannot create
      expect(() => assertCanMutate(table, undefined, putChange)).toThrow(
        TetherServerError,
      );

      const existingRecord: StoredRecord = {
        id: 't1',
        version: 1,
        timestamp: 100,
        clientId: 'c1',
        ownerId: mockUser.id,
      };

      // Other user cannot update existing owner record
      expect(() =>
        assertCanMutate(table, otherUser, putChange, existingRecord),
      ).toThrow(TetherServerError);
    });

    it('should check read permissions on table and record', async () => {
      const storage = new MemoryStorage();
      const table = await storage.createTable('notes');

      expect(canRead(table, undefined)).toBe(false);
      expect(canRead(table, mockUser)).toBe(true);

      const record: StoredRecord = {
        id: 'n1',
        version: 1,
        timestamp: 100,
        clientId: 'c1',
        ownerId: mockUser.id,
      };

      expect(canReadRecord(table, undefined, record)).toBe(false);
      expect(canReadRecord(table, otherUser, record)).toBe(false);
      expect(canReadRecord(table, mockUser, record)).toBe(true);

      const deletedRecord: StoredRecord = {
        ...record,
        deleted: true,
      };
      expect(canReadRecord(table, mockUser, deletedRecord)).toBe(false);
    });
  });
});
