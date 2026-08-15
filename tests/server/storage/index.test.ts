import { describe, expect, it } from 'vitest';
import { TetherServer } from '../../../src/server/server.js';
import {
  FileStorageAdapter,
  MemoryStorageAdapter,
  SqliteStorageAdapter,
  type StorageAdapter,
} from '../../../src/server/storage/index.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('src/server/storage/index.ts (Barrel Exports & Pluggable Integration)', () => {
  it('should export all storage adapters and interfaces', () => {
    expect(MemoryStorageAdapter).toBeDefined();
    expect(FileStorageAdapter).toBeDefined();
    expect(SqliteStorageAdapter).toBeDefined();
  });

  it('should allow plugging a custom StorageAdapter into TetherServer', async () => {
    const customRecords = new Map<string, unknown>();

    const customStorage: StorageAdapter = {
      async getRecord(userId, store, id) {
        const key = `${userId}:${store}:${id}`;
        const data = customRecords.get(key);
        if (data === undefined) return undefined;
        return {
          id,
          data,
          timestamp: 1000,
          version: 1,
        };
      },
      async getAllRecords(userId, store) {
        const items = [];
        for (const [key, data] of customRecords.entries()) {
          const [u, s, id] = key.split(':');
          if (u === userId && (!store || s === store)) {
            items.push({
              store: s,
              id,
              data,
              timestamp: 1000,
              version: 1,
            });
          }
        }
        return items;
      },
      async applyChanges(userId, changes) {
        const applied: ChangeRecord[] = [];
        for (const c of changes) {
          const key = `${userId}:${c.store}:${c.id}`;
          customRecords.set(key, c.data);
          applied.push({ ...c, seq: 1, version: 1 });
        }
        return { applied, newSeq: 1 };
      },
      async getChangesSince() {
        return { changes: [], currentSeq: 1, requiresSnapshot: false };
      },
      async getCurrentSeq() {
        return 1;
      },
      async listApps() {
        return ['default'];
      },
      async listStores() {
        return ['custom_store'];
      },
    };

    const server = new TetherServer({ storage: customStorage });
    expect(server.storageAdapter).toBe(customStorage);

    await server.storageAdapter.applyChanges('u1', [
      {
        store: 'custom_store',
        id: '1',
        op: OperationType.Put,
        data: 'custom_value',
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const rec = await server.storageAdapter.getRecord(
      'u1',
      'custom_store',
      '1',
    );
    expect(rec?.data).toBe('custom_value');

    await server.close();
  });
});
