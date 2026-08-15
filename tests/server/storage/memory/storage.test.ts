import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../../../src/server/storage/memory/index.js';
import {
  type ChangeRecord,
  OperationType,
} from '../../../../src/shared/types.js';

describe('src/server/storage/memory/ (MemoryStorage)', () => {
  it('should enforce maxRecordsPerTable quota in memory', async () => {
    const storage = new MemoryStorage({
      limits: { maxRecordsPerTable: 2 },
    });
    const app = await storage.createApp('quota-app');
    await app.createTable('items');
    const user = await storage.createUser('u1', 'pass');

    const c1: ChangeRecord = {
      table: 'items',
      id: '1',
      op: OperationType.Put,
      data: 'v1',
      timestamp: 10,
      clientId: 'c1',
    };
    const c2: ChangeRecord = {
      table: 'items',
      id: '2',
      op: OperationType.Put,
      data: 'v2',
      timestamp: 20,
      clientId: 'c1',
    };
    const c3: ChangeRecord = {
      table: 'items',
      id: '3',
      op: OperationType.Put,
      data: 'v3',
      timestamp: 30,
      clientId: 'c1',
    };

    await app.applyChanges(user, [c1, c2]);

    await expect(app.applyChanges(user, [c3])).rejects.toThrow(
      'maximum capacity of 2 records',
    );
  });

  it('should enforce maxRecordSizeBytes limit in memory', async () => {
    const storage = new MemoryStorage({
      limits: { maxRecordSizeBytes: 50 },
    });
    const app = await storage.createApp('size-app');
    await app.createTable('items');
    const user = await storage.createUser('u1', 'pass');

    const bigPayload = 'x'.repeat(100);
    await expect(
      app.applyChanges(user, [
        {
          table: 'items',
          id: 'big',
          op: OperationType.Put,
          data: bigPayload,
          timestamp: 10,
          clientId: 'c1',
        },
      ]),
    ).rejects.toThrow('exceeds maximum allowed size');
  });

  it('should delete tables and cascade state cleanup in memory', async () => {
    const storage = new MemoryStorage();
    const app = await storage.createApp('test-app');
    const table = await app.createTable('temp_table');
    const user = await storage.createUser('u1', 'pass');

    await table.applyChanges(user, [
      {
        table: 'temp_table',
        id: '1',
        op: OperationType.Put,
        data: 'val',
        timestamp: 10,
        clientId: 'c1',
      },
    ]);

    expect(await table.getRecord(user, '1')).toBeDefined();
    await table.delete();

    expect(await app.getTable('temp_table')).toBeUndefined();
  });
});
