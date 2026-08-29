import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  DataMode,
  SyncStatus,
  TetherClient,
  type TetherClientOptions,
} from '../../src/client/index.js';
import type { Storage } from '../../src/client/storage.js';
import { TetherServer } from '../../src/server/server.js';
import { delay, waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'Stress & High-Load Integration Tests ($name)',
  ({ createBackend }) => {
    let server: TetherServer;
    let storageContext: StorageContext;
    let port: number;
    const clientsToClean: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();

      server = new TetherServer({
        storage: storageContext.storage,
      });

      await server.declareTable('records');
      await server.declareTable('logs');
      await server.declareTable('metrics');
      await server.declareTable('items');
      await server.declareTable('shared_kv');
      await server.declareTable('stream');

      const httpServer = await server.listen(0, '127.0.0.1');
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;

      await server.declareUser('stressuser', 'stresspass123');
    });

    afterEach(async () => {
      for (const client of clientsToClean) {
        await client.close();
      }
      clientsToClean.length = 0;

      await server.close();
      await storageContext.cleanup();
    });

    function createClient(
      name: string,
      overrides: Partial<TetherClientOptions> = {},
    ): TetherClient {
      const client = new TetherClient(
        `${name}-${Math.random().toString(36).substring(2, 8)}`,
        {
          url: `ws://127.0.0.1:${port}/tether`,
          webSocketClass: WebSocket,
          ...overrides,
        },
      );
      clientsToClean.push(client);
      return client;
    }

    it('should handle thousands of records in parallel creation and verify data integrity', async () => {
      const client = createClient('bulk-creator');
      await client.login({ userName: 'stressuser', password: 'stresspass123' });

      const totalRecords = 2000;
      const table = client.table<{ index: number; payload: string }>('records');

      // Batch insert 1000 records using putAll
      const batchData = Array.from({ length: 1000 }, (_, i) => ({
        id: `batch-${i}`,
        data: { index: i, payload: `payload-${i}` },
      }));
      await table.putAll(batchData);

      // Parallel insert 1000 records using concurrent put calls
      const parallelPromises = Array.from({ length: 1000 }, (_, i) => {
        const idx = 1000 + i;
        return table.put(`parallel-${idx}`, {
          index: idx,
          payload: `payload-${idx}`,
        });
      });
      await Promise.all(parallelPromises);

      // Verify local retrieval
      const allLocal = await table.getAll();
      expect(allLocal).toHaveLength(totalRecords);

      // Verify spot checks on records
      const sampleBatch = await table.get('batch-450');
      expect(sampleBatch).toEqual({ index: 450, payload: 'payload-450' });

      const sampleParallel = await table.get('parallel-1750');
      expect(sampleParallel).toEqual({ index: 1750, payload: 'payload-1750' });

      // Wait for outbox to drain across multiple batch chunks (each max 500 items)
      const user = await server.storage.getUserByUserName('stressuser');
      expect(user).toBeDefined();
      if (!user) return;

      const serverTable = await server.storage.getTable('records');

      await waitForCondition(async () => {
        const serverRecords = (await serverTable?.getAllRecords(user)) ?? [];
        return serverRecords.length === totalRecords;
      }, 15000);

      const finalServerRecords = (await serverTable?.getAllRecords(user)) ?? [];
      expect(finalServerRecords).toHaveLength(totalRecords);
    }, 20000);

    it('should sync across multiple concurrent clients writing simultaneously', async () => {
      const clientCount = 5;
      const recordsPerClient = 200;
      const totalExpected = clientCount * recordsPerClient;

      const clients: TetherClient[] = [];
      for (let i = 0; i < clientCount; i++) {
        const client = createClient(`concurrent-client-${i}`);
        await client.login({
          userName: 'stressuser',
          password: 'stresspass123',
        });
        clients.push(client);
      }

      // Wait for all clients to connect
      await waitForCondition(() =>
        clients.every((c) => c.syncStatus === SyncStatus.Connected),
      );

      // All clients write their distinct partition in parallel
      const writePromises = clients.map((client, clientIndex) => {
        const table = client.table<{
          clientId: number;
          seq: number;
          content: string;
        }>('items');
        const clientWrites = Array.from(
          { length: recordsPerClient },
          (_, seq) => {
            const id = `item-${clientIndex}-${seq}`;
            return table.put(id, {
              clientId: clientIndex,
              seq,
              content: `client ${clientIndex} item ${seq}`,
            });
          },
        );
        return Promise.all(clientWrites);
      });

      await Promise.all(writePromises);

      // All clients should eventually converge to have all totalExpected records
      for (const client of clients) {
        const table = client.table<{
          clientId: number;
          seq: number;
          content: string;
        }>('items');
        await waitForCondition(async () => {
          const records = await table.getAll();
          return records.length === totalExpected;
        }, 15000);

        const all = await table.getAll();
        expect(all).toHaveLength(totalExpected);
      }
    }, 25000);

    it('should accumulate offline mutations (>1000 items) and sync on reconnection', async () => {
      const dbName = `offline-stresser-${Math.random().toString(36).substring(2, 8)}`;
      const offlineClient = new TetherClient(dbName, {
        url: `ws://127.0.0.1:${port}/tether`,
        webSocketClass: WebSocket,
      });
      clientsToClean.push(offlineClient);

      const table = offlineClient.table<{ value: number; tag: string }>(
        'records',
      );

      // 1. Create 1200 records offline
      const initialBatch = Array.from({ length: 1200 }, (_, i) => ({
        id: `off-${i}`,
        data: { value: i, tag: 'initial' },
      }));
      await table.putAll(initialBatch);

      // 2. Update 400 records offline
      const updatePromises = Array.from({ length: 400 }, (_, i) =>
        table.put(`off-${i}`, { value: i * 10, tag: 'updated' }),
      );
      await Promise.all(updatePromises);

      // 3. Delete 200 records offline
      const deleteIds = Array.from(
        { length: 200 },
        (_, i) => `off-${1000 + i}`,
      );
      await table.deleteAll(deleteIds);

      // Local count: 1200 created - 200 deleted = 1000 remaining
      const localRecords = await table.getAll();
      expect(localRecords).toHaveLength(1000);

      const updatedSample = await table.get('off-50');
      expect(updatedSample).toEqual({ value: 500, tag: 'updated' });

      const deletedSample = await table.get('off-1050');
      expect(deletedSample).toBeUndefined();

      // Verify outbox has accumulated changes
      const clientStorage = (offlineClient as unknown as { storage: Storage })
        .storage;
      const pendingBefore = await clientStorage.getPendingOutbox();
      expect(pendingBefore.length).toBeGreaterThan(0);

      // Now log in to connect and drain outbox across multiple batches
      await offlineClient.login({
        userName: 'stressuser',
        password: 'stresspass123',
        dataMode: DataMode.Local,
      });

      // Wait for offline client outbox to completely drain across chunks
      await waitForCondition(async () => {
        const pending = await clientStorage.getPendingOutbox();
        return pending.length === 0;
      }, 20000);

      // Wait for server to receive all mutations through multiple outbox chunks
      const user = await server.storage.getUserByUserName('stressuser');
      expect(user).toBeDefined();
      if (!user) return;

      const serverTable = await server.storage.getTable('records');

      await waitForCondition(async () => {
        const serverRecords = (await serverTable?.getAllRecords(user)) ?? [];
        const nonDeleted = serverRecords.filter((r) => !r.deleted);
        return nonDeleted.length === 1000;
      }, 20000);

      // Connect a second client to receive the full snapshot
      const clientB = createClient('snapshot-receiver');
      await clientB.login({
        userName: 'stressuser',
        password: 'stresspass123',
      });

      const tableB = clientB.table<{ value: number; tag: string }>('records');
      await waitForCondition(async () => {
        const allB = await tableB.getAll();
        return allB.length === 1000;
      }, 20000);

      const allB = await tableB.getAll();
      expect(allB).toHaveLength(1000);

      const bUpdated = await tableB.get('off-50');
      expect(bUpdated).toEqual({ value: 500, tag: 'updated' });

      const bDeleted = await tableB.get('off-1050');
      expect(bDeleted).toBeUndefined();
    }, 30000);

    it('should deterministically converge under heavy concurrent conflict writes on shared keys', async () => {
      const clientCount = 4;
      const sharedKeyCount = 30;
      const iterationsPerClient = 15;

      const clients: TetherClient[] = [];
      for (let i = 0; i < clientCount; i++) {
        const client = createClient(`conflict-client-${i}`);
        await client.login({
          userName: 'stressuser',
          password: 'stresspass123',
        });
        clients.push(client);
      }

      await waitForCondition(() =>
        clients.every((c) => c.syncStatus === SyncStatus.Connected),
      );

      // Concurrently write to the same shared keys with varying iterations
      const racePromises = clients.map((client, clientIndex) => {
        const table = client.table<{
          key: string;
          writtenBy: number;
          iteration: number;
          timestamp: number;
        }>('shared_kv');

        return (async () => {
          for (let iter = 0; iter < iterationsPerClient; iter++) {
            const keyIndex = (clientIndex * 7 + iter * 3) % sharedKeyCount;
            const key = `key-${keyIndex}`;
            await table.put(key, {
              key,
              writtenBy: clientIndex,
              iteration: iter,
            });
            await delay(2);
          }
        })();
      });

      await Promise.all(racePromises);

      // Wait for server to receive all outboxes and for all clients to settle
      const user = await server.storage.getUserByUserName('stressuser');
      expect(user).toBeDefined();
      if (!user) return;

      // Wait until all clients have pushed outboxes and reached complete data convergence
      await waitForCondition(async () => {
        const outboxes = await Promise.all(
          clients.map((c) =>
            (c as unknown as { storage: Storage }).storage.getPendingOutbox(),
          ),
        );
        if (outboxes.some((pending) => pending.length > 0)) {
          return false;
        }

        const maps = await Promise.all(
          clients.map(async (c) => {
            const all = await c.table<{ key: string }>('shared_kv').getAll();
            const m = new Map<string, string>();
            for (const item of all) {
              m.set(item.key, JSON.stringify(item));
            }
            return m;
          }),
        );

        if (!maps.every((m) => m.size === sharedKeyCount)) {
          return false;
        }

        const firstMap = maps[0];
        for (const [k, v] of firstMap.entries()) {
          for (let i = 1; i < maps.length; i++) {
            if (maps[i].get(k) !== v) {
              return false;
            }
          }
        }
        return true;
      }, 20000);

      // Retrieve final values from all clients
      const resultsPerClient = await Promise.all(
        clients.map(async (client) => {
          const table = client.table<{
            key: string;
            writtenBy: number;
            iteration: number;
            timestamp: number;
          }>('shared_kv');
          const all = await table.getAll();
          const map = new Map<string, unknown>();
          for (const item of all) {
            map.set(item.key, item);
          }
          return map;
        }),
      );

      // All clients must have identical data for all keys
      const firstClientMap = resultsPerClient[0];
      for (let c = 1; c < resultsPerClient.length; c++) {
        const currentMap = resultsPerClient[c];
        expect(currentMap.size).toBe(firstClientMap.size);
        for (const [k, v] of firstClientMap.entries()) {
          expect(currentMap.get(k)).toEqual(v);
        }
      }
    }, 30000);

    it('should handle multi-table parallel stress operations concurrently', async () => {
      const client = createClient('multi-table-stresser');
      await client.login({ userName: 'stressuser', password: 'stresspass123' });

      const logsTable = client.table<{ message: string; level: string }>(
        'logs',
      );
      const metricsTable = client.table<{ name: string; value: number }>(
        'metrics',
      );
      const itemsTable = client.table<{ name: string; count: number }>('items');

      const count = 300;

      // Concurrently write to 3 tables in parallel
      await Promise.all([
        (async () => {
          const logs = Array.from({ length: count }, (_, i) => ({
            id: `log-${i}`,
            data: {
              message: `Event log ${i}`,
              level: i % 2 === 0 ? 'info' : 'warn',
            },
          }));
          await logsTable.putAll(logs);
        })(),
        (async () => {
          const metrics = Array.from({ length: count }, (_, i) => ({
            id: `metric-${i}`,
            data: { name: `cpu_usage_${i}`, value: Math.random() * 100 },
          }));
          await metricsTable.putAll(metrics);
        })(),
        (async () => {
          const items = Array.from({ length: count }, (_, i) => ({
            id: `item-${i}`,
            data: { name: `Item ${i}`, count: i * 5 },
          }));
          await itemsTable.putAll(items);
        })(),
      ]);

      expect((await logsTable.getAll()).length).toBe(count);
      expect((await metricsTable.getAll()).length).toBe(count);
      expect((await itemsTable.getAll()).length).toBe(count);

      // Verify sync to server for all 3 tables
      const user = await server.storage.getUserByUserName('stressuser');
      expect(user).toBeDefined();
      if (!user) return;

      const serverLogs = await server.storage.getTable('logs');
      const serverMetrics = await server.storage.getTable('metrics');
      const serverItems = await server.storage.getTable('items');

      await waitForCondition(async () => {
        const l = (await serverLogs?.getAllRecords(user)) ?? [];
        const m = (await serverMetrics?.getAllRecords(user)) ?? [];
        const it = (await serverItems?.getAllRecords(user)) ?? [];
        return l.length === count && m.length === count && it.length === count;
      }, 15000);
    }, 20000);

    it('should preserve consistency during rapid session disconnect/reconnect flapping under write load', async () => {
      const client = createClient('flapping-client');
      await client.login({ userName: 'stressuser', password: 'stresspass123' });

      const streamTable = client.table<{ step: number; text: string }>(
        'stream',
      );
      const totalWrites = 60;

      // Run background writes while toggling logout/login
      let writesDone = 0;
      const writePromise = (async () => {
        for (let i = 0; i < totalWrites; i++) {
          await streamTable.put(`s-${i}`, {
            step: i,
            text: `Message chunk ${i}`,
          });
          writesDone++;
          await delay(1);
        }
      })();

      // Flap connection 3 times
      for (let cycle = 0; cycle < 3; cycle++) {
        await delay(10);
        await client.logout({ dataMode: DataMode.Local });
        await delay(10);
        await client.login({
          userName: 'stressuser',
          password: 'stresspass123',
          dataMode: DataMode.Local,
        });
      }

      await writePromise;
      expect(writesDone).toBe(totalWrites);

      // Ensure client ends in connected state
      if (client.syncStatus !== SyncStatus.Connected) {
        await client.login({
          userName: 'stressuser',
          password: 'stresspass123',
          dataMode: DataMode.Local,
        });
      }

      // Wait for all writes to be synced to the server
      const user = await server.storage.getUserByUserName('stressuser');
      expect(user).toBeDefined();
      if (!user) return;

      const serverStream = await server.storage.getTable('stream');

      await waitForCondition(async () => {
        const serverRecords = (await serverStream?.getAllRecords(user)) ?? [];
        return serverRecords.length === totalWrites;
      }, 20000);

      const finalRecords = (await serverStream?.getAllRecords(user)) ?? [];
      expect(finalRecords).toHaveLength(totalWrites);
    }, 30000);

    it('should handle many concurrent users registering, logging in, and performing table operations simultaneously', async () => {
      const userCount = 10;
      const recordsPerUser = 15;
      const userCredentials = Array.from({ length: userCount }, (_, i) => ({
        userName: `stress_u_${i}_${Math.random().toString(36).substring(2, 6)}`,
        password: `stress_pass_${i}`,
      }));

      // 1. Concurrent Account Creation
      const userClients: TetherClient[] = [];
      const registerPromises = userCredentials.map(async (cred, idx) => {
        const client = createClient(`user-client-${idx}`);
        userClients.push(client);
        const registered = await client.register({
          userName: cred.userName,
          password: cred.password,
          dataMode: DataMode.Local,
        });
        expect(registered).toBe(true);
        expect(client.authStatus).toBe(client.authStatus);
        return client;
      });

      await Promise.all(registerPromises);

      // 2. Concurrent Table Writes across all users
      const writePromises = userClients.map(async (client, userIdx) => {
        const table = client.table<{
          userIdx: number;
          itemIdx: number;
          note: string;
        }>('records');
        const entries = Array.from(
          { length: recordsPerUser },
          (_, itemIdx) => ({
            id: `item-${itemIdx}`,
            data: {
              userIdx,
              itemIdx,
              note: `Secret note for user ${userIdx} item ${itemIdx}`,
            },
          }),
        );
        await table.putAll(entries);
      });

      await Promise.all(writePromises);

      // 3. Verify Local Data Isolation and Immediate Reads
      for (const [userIdx, client] of userClients.entries()) {
        const table = client.table<{
          userIdx: number;
          itemIdx: number;
          note: string;
        }>('records');
        const records = await table.getAll();
        expect(records).toHaveLength(recordsPerUser);
        for (const record of records) {
          expect(record.userIdx).toBe(userIdx);
        }
      }

      // 4. Verify Server-Side Sync Convergence for All Concurrent Users
      const serverTable = await server.storage.getTable('records');

      await waitForCondition(async () => {
        for (const cred of userCredentials) {
          const serverUser = await server.storage.getUserByUserName(
            cred.userName,
          );
          if (!serverUser) return false;
          const serverRecords =
            (await serverTable?.getAllRecords(serverUser)) ?? [];
          if (serverRecords.length !== recordsPerUser) return false;
        }
        return true;
      }, 25000);

      // 5. Concurrent Logout and Re-Login
      const loginPromises = userClients.map(async (client, idx) => {
        const cred = userCredentials[idx];
        await client.logout({ dataMode: DataMode.Clear });
        expect(client.authStatus).toBe(0 /* SignedOut */);

        const loggedIn = await client.login({
          userName: cred.userName,
          password: cred.password,
          dataMode: DataMode.Remote,
        });
        expect(loggedIn).toBe(true);
      });

      await Promise.all(loginPromises);

      // 6. Verify Remote Snapshot Restoration after Re-login
      await waitForCondition(async () => {
        for (const client of userClients) {
          const table = client.table<{
            userIdx: number;
            itemIdx: number;
            note: string;
          }>('records');
          const records = await table.getAll();
          if (records.length !== recordsPerUser) return false;
        }
        return true;
      }, 25000);
    }, 45000);
  },
);
