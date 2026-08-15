import { describe, expect, it } from 'vitest';
import { TetherServer } from '../../../src/server/server.js';
import {
  type AppStorage,
  FileStorage,
  MemoryStorage,
  SqliteStorage,
  type Storage,
  type TableStorage,
  type UserStorage,
} from '../../../src/server/storage/index.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('src/server/storage/index.ts (Barrel Exports & Custom Storage Integration)', () => {
  it('should export all concrete storages and interfaces', () => {
    expect(MemoryStorage).toBeDefined();
    expect(FileStorage).toBeDefined();
    expect(SqliteStorage).toBeDefined();
  });

  it('should allow plugging a custom Storage into TetherServer', async () => {
    const customRecords = new Map<string, unknown>();

    const customTable: TableStorage = {
      name: 'custom_table',
      get app() {
        return customApp;
      },
      async getRecord(user, id) {
        const key = `${user.id}:${id}`;
        const data = customRecords.get(key);
        if (data === undefined) return undefined;
        return {
          id,
          data,
          timestamp: 1000,
          version: 1,
        };
      },
      async getAllRecords(user) {
        const items = [];
        for (const [key, data] of customRecords.entries()) {
          const [u, id] = key.split(':');
          if (u === user.id) {
            items.push({
              table: 'custom_table',
              id,
              data,
              timestamp: 1000,
              version: 1,
            });
          }
        }
        return items;
      },
      async applyChanges(user, changes) {
        const applied: ChangeRecord[] = [];
        for (const c of changes) {
          const key = `${user.id}:${c.id}`;
          customRecords.set(key, c.data);
          applied.push({ ...c, seq: 1, version: 1, table: 'custom_table' });
        }
        return { applied, newSeq: 1 };
      },
      async delete() {
        return true;
      },
    };

    const customApp: AppStorage = {
      id: 'default',
      async createTable() {
        return customTable;
      },
      async getTable() {
        return customTable;
      },
      async getTables() {
        return [customTable];
      },
      async applyChanges(user, changes) {
        return customTable.applyChanges(user, changes);
      },
      async getChangesSince() {
        return { changes: [], currentSeq: 1, requiresSnapshot: false };
      },
      async getCurrentSeq() {
        return 1;
      },
      async delete() {
        return true;
      },
    };

    const customUser: UserStorage = {
      id: 'u1',
      username: 'custom_user',
      createdAt: 1000,
      async verifyPassword() {
        return true;
      },
      async changePassword() {},
      async createToken() {
        return 'custom_token_123';
      },
      async verifyToken() {
        return true;
      },
      async delete() {
        return true;
      },
    };

    const customStorage: Storage = {
      async createApp() {
        return customApp;
      },
      async getApp() {
        return customApp;
      },
      async getApps() {
        return [customApp];
      },
      async createUser(_username: string, _password: string) {
        return customUser;
      },
      async getUser() {
        return customUser;
      },
      async getUserByUsername() {
        return customUser;
      },
      async getUserByToken() {
        return customUser;
      },
      async getUsers() {
        return [customUser];
      },
    };

    const server = new TetherServer({ storage: customStorage });
    expect(server.storage).toBe(customStorage);

    const app = await server.storage.getApp('default');
    expect(app).toBeDefined();
    const table = await app?.getTable('custom_table');
    expect(table).toBeDefined();

    await table?.applyChanges(customUser, [
      {
        table: 'custom_table',
        id: '1',
        op: OperationType.Put,
        data: 'custom_value',
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const rec = await table?.getRecord(customUser, '1');
    expect(rec?.data).toBe('custom_value');

    await server.close();
  });
});
