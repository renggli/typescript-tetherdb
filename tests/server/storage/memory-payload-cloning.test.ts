import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { OperationType, Permission } from '../../../src/shared/types.js';

describe('MemoryStorage Payload Cloning', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('deep-clones data payload to prevent external in-memory object mutation from corrupting state', async () => {
    const table = await storage.createTable('configs', {
      permissions: {
        read: Permission.Everybody,
        create: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });

    const payload = { settings: { theme: 'dark', count: 1 } };
    await storage.applyChanges(undefined, [
      {
        table: table.name,
        id: 'c1',
        op: OperationType.Put,
        data: payload,
        timestamp: 1000,
      },
    ]);

    // Mutate the local payload object after applyChanges
    payload.settings.theme = 'light';
    payload.settings.count = 999;

    const record = await table.getRecord(undefined, 'c1');
    expect(record?.data).toEqual({
      settings: { theme: 'dark', count: 1 },
    });
  });
});
