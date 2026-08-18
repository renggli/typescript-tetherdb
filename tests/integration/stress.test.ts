import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  DataMode,
  TetherClient,
  type TetherClientOptions,
} from '../../src/client/client.js';
import { Storage } from '../../src/client/storage.js';
import { SyncStatus } from '../../src/client/sync.js';
import { TetherServer } from '../../src/server/server.js';
import { FileStorage } from '../../src/server/storage/file/index.js';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

describe('Stress & High-Load Integration Tests', () => {
  let server: TetherServer;
  let tmpDir: string;
  let port: number;
  const clientsToClean: TetherClient[] = [];

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-stress-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    server = new TetherServer({
      storage: new FileStorage({ baseDir: tmpDir }),
    });

    await server.declareApp('stress-app', [
      'records',
      'logs',
      'metrics',
      'items',
      'shared_kv',
      'stream',
    ]);

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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createClient(
    name: string,
    overrides: Partial<TetherClientOptions> = {},
  ): TetherClient {
    const client = new TetherClient(
      `${name}-${Math.random().toString(36).substring(2, 8)}`,
      {
        appId: 'stress-app',
        host: '127.0.0.1',
        port,
        webSocketClass: WebSocket,
        ...overrides,
      },
    );
    clientsToClean.push(client);
    return client;
  }

  it('should handle thousands of records in parallel creation and verify data integrity', async () => {
    const client = createClient('bulk-creator');
    await client.login({ username: 'stressuser', password: 'stresspass123' });

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
    const user = await server.storage.getUserByUsername('stressuser');
    expect(user).toBeDefined();
    if (!user) return;

    const stressApp = await server.storage.getApp('stress-app');
    const serverTable = await stressApp?.getTable('records');

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
      await client.login({ username: 'stressuser', password: 'stresspass123' });
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
      appId: 'stress-app',
      host: '127.0.0.1',
      port,
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
    const deleteIds = Array.from({ length: 200 }, (_, i) => `off-${1000 + i}`);
    await table.deleteAll(deleteIds);

    // Local count: 1200 created - 200 deleted = 1000 remaining
    const localRecords = await table.getAll();
    expect(localRecords).toHaveLength(1000);

    const updatedSample = await table.get('off-50');
    expect(updatedSample).toEqual({ value: 500, tag: 'updated' });

    const deletedSample = await table.get('off-1050');
    expect(deletedSample).toBeUndefined();

    // Verify outbox has accumulated changes
    const rawStorage = new Storage(dbName);
    const pendingBefore = await rawStorage.getPendingOutbox();
    expect(pendingBefore.length).toBeGreaterThan(0);
    await rawStorage.close();

    // Now log in to connect and drain outbox across multiple batches
    await offlineClient.login({
      username: 'stressuser',
      password: 'stresspass123',
      dataMode: DataMode.Local,
    });

    // Wait for server to receive all mutations through multiple outbox chunks
    const user = await server.storage.getUserByUsername('stressuser');
    expect(user).toBeDefined();
    if (!user) return;

    const stressApp = await server.storage.getApp('stress-app');
    const serverTable = await stressApp?.getTable('records');

    await waitForCondition(async () => {
      const serverRecords = (await serverTable?.getAllRecords(user)) ?? [];
      const nonDeleted = serverRecords.filter((r) => !r.deleted);
      return nonDeleted.length === 1000;
    }, 15000);

    // Connect a second client to receive the full snapshot
    const clientB = createClient('snapshot-receiver');
    await clientB.login({ username: 'stressuser', password: 'stresspass123' });

    const tableB = clientB.table<{ value: number; tag: string }>('records');
    await waitForCondition(async () => {
      const allB = await tableB.getAll();
      return allB.length === 1000;
    }, 15000);

    const allB = await tableB.getAll();
    expect(allB).toHaveLength(1000);

    const bUpdated = await tableB.get('off-50');
    expect(bUpdated).toEqual({ value: 500, tag: 'updated' });

    const bDeleted = await tableB.get('off-1050');
    expect(bDeleted).toBeUndefined();
  }, 25000);

  it('should deterministically converge under heavy concurrent conflict writes on shared keys', async () => {
    const clientCount = 4;
    const sharedKeyCount = 30;
    const iterationsPerClient = 15;

    const clients: TetherClient[] = [];
    for (let i = 0; i < clientCount; i++) {
      const client = createClient(`conflict-client-${i}`);
      await client.login({ username: 'stressuser', password: 'stresspass123' });
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
            timestamp: Date.now() + iter,
          });
        }
      })();
    });

    await Promise.all(racePromises);

    // Wait for server to receive all outboxes and for all clients to settle
    const user = await server.storage.getUserByUsername('stressuser');
    expect(user).toBeDefined();
    if (!user) return;

    const stressApp = await server.storage.getApp('stress-app');
    const serverTable = await stressApp?.getTable('shared_kv');

    // Wait until all clients have received all broadcasts
    await waitForCondition(async () => {
      const serverRecords = (await serverTable?.getAllRecords(user)) ?? [];
      const clientRecordCounts = await Promise.all(
        clients.map(async (c) => (await c.table('shared_kv').getAll()).length),
      );
      return (
        serverRecords.length > 0 &&
        clientRecordCounts.every((count) => count === serverRecords.length)
      );
    }, 15000);

    // Allow broadcast queues to flush to local IndexedDB stores
    await delay(500);

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
  }, 25000);

  it('should handle multi-table parallel stress operations concurrently', async () => {
    const client = createClient('multi-table-stresser');
    await client.login({ username: 'stressuser', password: 'stresspass123' });

    const logsTable = client.table<{ message: string; level: string }>('logs');
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
    const user = await server.storage.getUserByUsername('stressuser');
    expect(user).toBeDefined();
    if (!user) return;

    const stressApp = await server.storage.getApp('stress-app');
    const serverLogs = await stressApp?.getTable('logs');
    const serverMetrics = await stressApp?.getTable('metrics');
    const serverItems = await stressApp?.getTable('items');

    await waitForCondition(async () => {
      const l = (await serverLogs?.getAllRecords(user)) ?? [];
      const m = (await serverMetrics?.getAllRecords(user)) ?? [];
      const it = (await serverItems?.getAllRecords(user)) ?? [];
      return l.length === count && m.length === count && it.length === count;
    }, 15000);
  }, 20000);

  it('should preserve consistency during rapid session disconnect/reconnect flapping under write load', async () => {
    const client = createClient('flapping-client');
    await client.login({ username: 'stressuser', password: 'stresspass123' });

    const streamTable = client.table<{ step: number; text: string }>('stream');
    const totalWrites = 300;

    // Run background writes while toggling logout/login
    let writesDone = 0;
    const writePromise = (async () => {
      for (let i = 0; i < totalWrites; i++) {
        await streamTable.put(`s-${i}`, {
          step: i,
          text: `Message chunk ${i}`,
        });
        writesDone++;
        await delay(5);
      }
    })();

    // Flap connection 3 times
    for (let cycle = 0; cycle < 3; cycle++) {
      await delay(40);
      await client.logout({ dataMode: DataMode.Local });
      await delay(40);
      await client.login({
        username: 'stressuser',
        password: 'stresspass123',
        dataMode: DataMode.Local,
      });
    }

    await writePromise;
    expect(writesDone).toBe(totalWrites);

    // Ensure client ends in connected state
    if (client.syncStatus !== SyncStatus.Connected) {
      await client.login({
        username: 'stressuser',
        password: 'stresspass123',
        dataMode: DataMode.Local,
      });
    }

    // Wait for all writes to be synced to the server
    const user = await server.storage.getUserByUsername('stressuser');
    expect(user).toBeDefined();
    if (!user) return;

    const stressApp = await server.storage.getApp('stress-app');
    const serverStream = await stressApp?.getTable('stream');

    await waitForCondition(async () => {
      const serverRecords = (await serverStream?.getAllRecords(user)) ?? [];
      return serverRecords.length === totalWrites;
    }, 20000);

    const finalRecords = (await serverStream?.getAllRecords(user)) ?? [];
    expect(finalRecords).toHaveLength(totalWrites);
  }, 30000);
});
