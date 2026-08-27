import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  TetherClient,
  type TetherClientOptions,
} from '../../src/client/client.js';
import { SyncStatus } from '../../src/client/sync.js';

import { TetherServer } from '../../src/server/server.js';
import { OperationType } from '../../src/shared/types.js';
import { waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'End-to-End WebSocket Sync ($name)',
  ({ createBackend }) => {
    let server: TetherServer;
    let storageContext: StorageContext;
    let port: number;
    const clientsToClose: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();

      server = new TetherServer({
        storage: storageContext.storage,
      });
      await server.declareTable('todos');
      await server.declareTable('notes');
      await server.declareTable('items');
      await server.declareTable('tasks');
      await server.declareTable('messages');
      await server.declareTable('docs');

      const httpServer = await server.listen(0, '127.0.0.1');
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;

      // Register test user
      await server.declareUser('testuser', 'password123');
    });

    afterEach(async () => {
      for (const client of clientsToClose) {
        await client.close();
      }
      clientsToClose.length = 0;
      await server.close();
      await storageContext.cleanup();
    });

    function createClient(
      name: string,
      overrides: Partial<TetherClientOptions> = {},
    ) {
      const client = new TetherClient(
        `${name}-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: '127.0.0.1',
          port,
          webSocketClass: WebSocket,
          ...overrides,
        },
      );
      clientsToClose.push(client);
      return client;
    }

    it('should sync local changes from Client A to server', async () => {
      const clientA = createClient('client-a');
      await clientA.login({ username: 'testuser', password: 'password123' });
      await waitForCondition(() => clientA.syncStatus === SyncStatus.Connected);

      const todosA = clientA.table<{ title: string; done: boolean }>('todos');
      await todosA.put('t1', { title: 'Buy groceries', done: false });

      const user = await server.storage.getUserByUsername('testuser');
      expect(user).toBeDefined();
      if (!user) return;
      const todosTable = await server.storage.getTable('todos');

      await waitForCondition(async () => {
        const records = (await todosTable?.getAllRecords(user)) ?? [];
        return records.length === 1;
      });

      const serverRecords = (await todosTable?.getAllRecords(user)) ?? [];
      expect(serverRecords).toHaveLength(1);
      expect(serverRecords[0].data).toEqual({
        title: 'Buy groceries',
        done: false,
      });

      await clientA.close();
    });

    it('should perform initial snapshot sync on new client connection', async () => {
      const user = await server.storage.getUserByUsername('testuser');
      const todosTable = await server.storage.getTable('todos');

      // Client A creates data
      const clientA = createClient('client-a');
      await clientA.login({ username: 'testuser', password: 'password123' });
      await waitForCondition(() => clientA.syncStatus === SyncStatus.Connected);

      const todosA = clientA.table<{ title: string; done: boolean }>('todos');
      await todosA.put('t1', { title: 'Write code', done: false });
      await todosA.put('t2', { title: 'Run tests', done: true });

      if (user) {
        await waitForCondition(async () => {
          const records = (await todosTable?.getAllRecords(user)) ?? [];
          return records.length === 2;
        });
      }
      await clientA.close();

      // Client B connects from clean state
      const clientB = createClient('client-b');
      await clientB.login({ username: 'testuser', password: 'password123' });

      const todosB = clientB.table<{ title: string; done: boolean }>('todos');
      await waitForCondition(async () => (await todosB.getAll()).length === 2);

      const allB = await todosB.getAll();
      expect(allB).toHaveLength(2);
      expect(allB.map((t) => t.title).sort()).toEqual([
        'Run tests',
        'Write code',
      ]);

      await clientB.close();
    });

    it('should broadcast real-time changes between concurrent clients', async () => {
      const clientA = createClient('client-a');
      const clientB = createClient('client-b');

      await clientA.login({ username: 'testuser', password: 'password123' });
      await clientB.login({ username: 'testuser', password: 'password123' });

      await waitForCondition(
        () =>
          clientA.syncStatus === SyncStatus.Connected &&
          clientB.syncStatus === SyncStatus.Connected,
      );

      const messagesB = clientB.table<{ text: string }>('messages');
      const receivedEvents: Array<{
        op: OperationType;
        id: string;
        data?: { text: string };
        isRemote?: boolean;
      }> = [];
      messagesB.onChange.register((events) => {
        receivedEvents.push(...events);
      });

      const messagesA = clientA.table<{ text: string }>('messages');
      await messagesA.put('msg-1', { text: 'Hello from Client A!' });

      await waitForCondition(() => receivedEvents.length === 1);

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].op).toBe(OperationType.Put);
      expect(receivedEvents[0].isRemote).toBe(true);
      expect(receivedEvents[0].data).toEqual({ text: 'Hello from Client A!' });

      const fetchedFromB = await messagesB.get('msg-1');
      expect(fetchedFromB).toEqual({ text: 'Hello from Client A!' });

      await clientA.close();
      await clientB.close();
    });

    it('should catch up with diff sync after being offline', async () => {
      const user = await server.storage.getUserByUsername('testuser');
      const itemsTable = await server.storage.getTable('items');

      const clientA = createClient('client-a');
      await clientA.login({ username: 'testuser', password: 'password123' });
      await waitForCondition(() => clientA.syncStatus === SyncStatus.Connected);

      const itemsA = clientA.table<{ name: string }>('items');
      await itemsA.put('item-1', { name: 'First' });

      if (user) {
        await waitForCondition(async () => {
          const recs = (await itemsTable?.getAllRecords(user)) ?? [];
          return recs.length === 1;
        });
      }

      // Client B connects and gets initial sync
      const clientBName = `client-b-${Math.random().toString(36).substring(2, 8)}`;
      let clientB = new TetherClient(clientBName, {
        host: '127.0.0.1',
        port,
        webSocketClass: WebSocket,
      });
      await clientB.login({ username: 'testuser', password: 'password123' });

      const itemsB1 = clientB.table<{ name: string }>('items');
      await waitForCondition(async () => (await itemsB1.getAll()).length === 1);
      expect(await itemsB1.getAll()).toHaveLength(1);

      // Client B disconnects (simulating going offline)
      await clientB.close();

      // Client A makes more changes while B is offline
      await itemsA.put('item-2', { name: 'Second' });
      await itemsA.put('item-3', { name: 'Third' });

      if (user) {
        await waitForCondition(async () => {
          const recs = (await itemsTable?.getAllRecords(user)) ?? [];
          return recs.length === 3;
        });
      }

      // Client B comes back online with the same IndexedDB database
      clientB = new TetherClient(clientBName, {
        host: '127.0.0.1',
        port,
        webSocketClass: WebSocket,
      });
      await clientB.login({ username: 'testuser', password: 'password123' });

      const itemsB2 = clientB.table<{ name: string }>('items');
      await waitForCondition(async () => (await itemsB2.getAll()).length === 3);

      const all = await itemsB2.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((i) => i.name).sort()).toEqual([
        'First',
        'Second',
        'Third',
      ]);

      await clientA.close();
      await clientB.close();
    });

    it('should enforce multi-tenant isolation across users', async () => {
      await server.declareUser('otheruser', 'password123');

      const clientUser1 = createClient('client-u1');
      const clientUser2 = createClient('client-u2');

      await clientUser1.login({
        username: 'testuser',
        password: 'password123',
      });
      await clientUser2.login({
        username: 'otheruser',
        password: 'password123',
      });

      await waitForCondition(
        () =>
          clientUser1.syncStatus === SyncStatus.Connected &&
          clientUser2.syncStatus === SyncStatus.Connected,
      );

      const docs1 = clientUser1.table<{ secret: string }>('docs');
      await docs1.put('doc1', { secret: 'top secret 1' });

      const user1 = await server.storage.getUserByUsername('testuser');
      const docsTable = await server.storage.getTable('docs');
      if (user1) {
        await waitForCondition(async () => {
          const recs = (await docsTable?.getAllRecords(user1)) ?? [];
          return recs.length === 1;
        });
      }

      const docs2 = clientUser2.table<{ secret: string }>('docs');
      const all2 = await docs2.getAll();
      expect(all2).toHaveLength(0);

      await clientUser1.close();
      await clientUser2.close();
    });

    it('should deliver snapshot and update local database in batch when diff is large', async () => {
      // Populate 60 changes in server storage for user
      const user = await server.storage.getUserByUsername('testuser');
      expect(user).toBeDefined();

      const changes = [];
      for (let i = 1; i <= 60; i++) {
        changes.push({
          table: 'tasks',
          id: `task-${i}`,
          op: OperationType.Put,
          data: { title: `Task ${i}` },
          timestamp: Date.now() + i,
          clientId: 'prepop',
        });
      }
      if (!user) return;
      await server.storage.applyChanges(user, changes);

      // New client connects with lastSyncSeq: 1 (so 59 changes diff > 50 threshold)
      const client = createClient('client-bulk');
      await client.login({ username: 'testuser', password: 'password123' });

      const tasksTable = client.table<{ title: string }>('tasks');
      await waitForCondition(
        async () => (await tasksTable.getAll()).length === 60,
      );

      const allTasks = await tasksTable.getAll();
      expect(allTasks).toHaveLength(60);

      await client.close();
    });

    it('should batch rapid local mutations and beam them to remote clients cohesively', async () => {
      const clientA = createClient('client-a-bulk');
      const clientB = createClient('client-b-bulk');

      await clientA.login({ username: 'testuser', password: 'password123' });
      await clientB.login({ username: 'testuser', password: 'password123' });

      await waitForCondition(
        () =>
          clientA.syncStatus === SyncStatus.Connected &&
          clientB.syncStatus === SyncStatus.Connected,
      );

      const itemsB = clientB.table<{ title: string }>('items');
      const receivedBatches: Array<Array<{ op: OperationType; id: string }>> =
        [];
      itemsB.onChange.register((events) => {
        receivedBatches.push(events.map((e) => ({ op: e.op, id: e.id })));
      });

      const itemsA = clientA.table<{ title: string }>('items');
      // Bulk put from Client A
      await itemsA.putAll([
        { id: 'item-1', data: { title: 'Batch Item 1' } },
        { id: 'item-2', data: { title: 'Batch Item 2' } },
        { id: 'item-3', data: { title: 'Batch Item 3' } },
      ]);

      await waitForCondition(async () => (await itemsB.getAll()).length === 3);

      const allOnB = await itemsB.getAll();
      expect(allOnB).toHaveLength(3);
      expect(receivedBatches.length).toBeGreaterThanOrEqual(1);

      await clientA.close();
      await clientB.close();
    });

    it('should handle keepalive ping and respond with pong without error', async () => {
      const client = createClient('client-ping', {
        pingIntervalMs: 50, // Rapid ping for test
      });
      await client.login({ username: 'testuser', password: 'password123' });

      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);
      expect(client.syncStatus).toBe(SyncStatus.Connected);

      await client.close();
    });
  },
);
