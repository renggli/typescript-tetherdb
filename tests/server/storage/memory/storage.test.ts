import { describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../../src/server/errors.js';
import {
  type ChangeRecord,
  OperationType,
} from '../../../../src/shared/types.js';
import { memoryStorage } from '../matrix.js';

describe('MemoryStorage', () => {
  it('should enforce maxRecordsPerTable quota in memory', async () => {
    const { backend, cleanup } = await memoryStorage.createBackend({
      maxRecordsPerTable: 2,
    });
    try {
      const app = await backend.createApp('quota-app');
      await app.createTable('items');
      const user = await backend.createUser('user1', 'pass');

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
        TetherServerError,
      );
      await expect(app.applyChanges(user, [c3])).rejects.toMatchObject({
        code: TetherServerErrorCode.LimitExceeded,
      });
    } finally {
      await cleanup();
    }
  });

  it('should enforce maxRecordSizeBytes limit in memory', async () => {
    const { backend, cleanup } = await memoryStorage.createBackend({
      maxRecordSizeBytes: 50,
    });
    try {
      const app = await backend.createApp('size-app');
      await app.createTable('items');
      const user = await backend.createUser('user1', 'pass');

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
      ).rejects.toMatchObject({
        code: TetherServerErrorCode.LimitExceeded,
      });
    } finally {
      await cleanup();
    }
  });

  it('should delete tables and cascade state cleanup in memory', async () => {
    const { backend, cleanup } = await memoryStorage.createBackend();
    try {
      const app = await backend.createApp('test-app');
      const table = await app.createTable('temp_table');
      const user = await backend.createUser('user1', 'pass');

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

      expect(await table.getAllRecords(user)).toHaveLength(1);
      app.deleteTable('temp_table');
      expect(await app.getTable('temp_table')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('should support getStatus, prune and reject checkpoint/vacuum with NotSupported in memory', async () => {
    const { backend, cleanup } = await memoryStorage.createBackend();
    try {
      const app = await backend.createApp('mem_app');
      await app.createTable('records');
      const user = await backend.createUser('mem_user', 'pass');

      for (let i = 1; i <= 6; i++) {
        const table = await app.getTable('records');
        await table?.applyChanges(user, [
          {
            table: 'records',
            id: `k_${i}`,
            op: OperationType.Put,
            data: { val: i },
            timestamp: 100 + i,
            clientId: 'c1',
          },
        ]);
      }

      const status = await backend.getStatus('mem_app');
      expect(status.backend).toBe('memory');
      expect(status.appsCount).toBe(1);
      expect(status.apps?.[0].tables).toEqual(['records']);

      const pruneRes = await backend.prune('mem_app', 2);
      expect(pruneRes.action).toBe('prune');
      expect(pruneRes.affectedCount).toBe(4);

      await expect(backend.checkpoint()).rejects.toMatchObject({
        code: TetherServerErrorCode.NotSupported,
      });
      await expect(backend.vacuum()).rejects.toMatchObject({
        code: TetherServerErrorCode.NotSupported,
      });
    } finally {
      await cleanup();
    }
  });
});
