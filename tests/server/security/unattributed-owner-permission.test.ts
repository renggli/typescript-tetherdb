import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filterAndSanitizeChanges,
  filterAndSanitizeSnapshot,
} from '../../../src/server/security/filter.js';
import { UserResolver } from '../../../src/server/security/resolver.js';
import type {
  InternalChangeRecord,
  InternalStoredRecord,
} from '../../../src/server/security/types.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { OperationType, Permission } from '../../../src/shared/types.js';

describe('Owner Permission on Unattributed Records', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('denies authenticated user from reading unattributed records under Permission.Owner', async () => {
    const user = await storage.createUser('alice', 'Password123!');
    const table = await storage.createTable('vault', {
      permissions: {
        read: Permission.Owner,
        create: Permission.Authenticated,
        update: Permission.Owner,
        delete: Permission.Owner,
      },
    });

    const unattributedRecord: InternalStoredRecord = {
      id: 'rec-1',
      version: 1,
      timestamp: 1000,
      deleted: false,
      data: { secret: 'supersecret' },
      userId: undefined,
    };

    expect(table.canRead(user, unattributedRecord)).toBe(false);
    expect(table.canUpdate(user, unattributedRecord)).toBe(false);
    expect(table.canDelete(user, unattributedRecord)).toBe(false);

    const resolver = new UserResolver(storage);
    const snapshot = await filterAndSanitizeSnapshot([table], user, resolver);
    expect(snapshot).toHaveLength(0);

    const rawChanges: InternalChangeRecord[] = [
      {
        seq: 1,
        table: 'vault',
        id: 'rec-1',
        op: OperationType.Put,
        version: 1,
        timestamp: 1000,
        data: { secret: 'supersecret' },
        userId: undefined,
      },
    ];
    const sanitized = await filterAndSanitizeChanges(
      rawChanges,
      user,
      () => table,
      resolver,
    );
    expect(sanitized).toHaveLength(0);
  });
});
