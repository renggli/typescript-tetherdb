import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SyncStatus, TetherClient } from '../../src/client/index.js';
import { type RunningServer, startServer } from '../../src/server/server.js';
import type { Storage } from '../../src/server/storage/index.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

interface TodoItem {
  text: string;
  completed?: boolean;
}

interface NoteItem {
  content: string;
}

import { waitForCondition } from '../helpers.js';

describe.each(storageDescriptors)(
  'Integration: Table Lifecycle and Client Data Reset ($name)',
  ({ createBackend }) => {
    let runningServer: RunningServer;
    let serverPort: number;
    let storageContext: StorageContext;
    let serverStorage: Storage;
    const activeClients: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();
      serverStorage = storageContext.storage;

      runningServer = await startServer({
        port: 0,
        host: '127.0.0.1',
        storage: serverStorage,
      });
      serverPort = runningServer.port;

      await runningServer.server.declareApp('lifecycle-app', ['todos']);
      await runningServer.server.declareUser('alice', 'password123');
      await runningServer.server.declareUser('bobby', 'password123');
    });

    afterEach(async () => {
      for (const client of activeClients) {
        await client.close();
      }
      activeClients.length = 0;

      await runningServer.close();
      await storageContext.cleanup();
    });

    function createClient(name = 'client', dbName?: string): TetherClient {
      const client = new TetherClient(
        dbName ?? `${name}-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: '127.0.0.1',
          port: serverPort,
          appId: 'lifecycle-app',
          webSocketClass: WebSocket,
          reconnectIntervalMs: 200,
        },
      );
      activeClients.push(client);
      return client;
    }

    it('should support dynamic table creation, syncing, and recreation across multiple clients', async () => {
      const app = await serverStorage.getApp('lifecycle-app');
      expect(app).toBeDefined();

      // Setup two concurrent clients
      const client1 = createClient('c1');
      const client2 = createClient('c2');

      await client1.login({ username: 'alice', password: 'password123' });
      await client2.login({ username: 'alice', password: 'password123' });

      await waitForCondition(
        () =>
          client1.syncStatus === SyncStatus.Connected &&
          client2.syncStatus === SyncStatus.Connected,
      );

      const todos1 = client1.table<TodoItem>('todos');
      const todos2 = client2.table<TodoItem>('todos');

      // Client 1 adds todos
      await todos1.put('td-1', { text: 'First task', completed: false });
      await todos1.put('td-2', { text: 'Second task', completed: false });

      await waitForCondition(async () => (await todos2.getAll()).length === 2);
      expect(await todos2.getAll()).toHaveLength(2);

      // Server dynamically adds a new table "notes"
      const notesTable = await app?.createTable('notes');
      expect(notesTable).toBeDefined();

      const notes1 = client1.table<NoteItem>('notes');
      const notes2 = client2.table<NoteItem>('notes');

      await notes1.put('note-1', { content: 'Secret project notes' });

      await waitForCondition(
        async () =>
          (await notes2.get('note-1'))?.content === 'Secret project notes',
      );

      expect((await notes2.get('note-1'))?.content).toBe(
        'Secret project notes',
      );

      // Server deletes the "notes" table
      const deleted = await app?.deleteTable('notes');
      expect(deleted).toBe(true);
      expect(await app?.getTable('notes')).toBeUndefined();

      // Server recreates table "notes" - should start clean on server
      const recreatedNotes = await app?.createTable('notes');
      expect(recreatedNotes).toBeDefined();
      const userAlice = await serverStorage.getUserByUsername('alice');
      expect(userAlice).toBeDefined();
      if (userAlice) {
        expect(await recreatedNotes?.getAllRecords(userAlice)).toHaveLength(0);
      }
    });

    it('should support client-side db.clear() and cleanly recover fresh state on resync', async () => {
      const dbName = `bobby-local-db-${Date.now()}`;
      const client1 = createClient('bobby-client-1', dbName);

      await client1.login({ username: 'bobby', password: 'password123' });
      await waitForCondition(() => client1.syncStatus === SyncStatus.Connected);

      const todos = client1.table<TodoItem>('todos');
      await todos.put('t-1', { text: 'Item 1' });
      await todos.put('t-2', { text: 'Item 2' });

      // Wait for server to receive the pushed items
      const userBobby = await serverStorage.getUserByUsername('bobby');
      const app = await serverStorage.getApp('lifecycle-app');
      const todosTable = await app?.getTable('todos');
      await waitForCondition(async () => {
        if (!userBobby || !todosTable) return false;
        const recs = await todosTable.getAllRecords(userBobby);
        return recs.length === 2;
      });

      // Close client 1
      await client1.close();

      // Create fresh client with empty new local DB, login, and verify full snapshot restore
      const client2 = createClient('bobby-client-2');
      await client2.login({ username: 'bobby', password: 'password123' });
      await waitForCondition(
        async () =>
          (await client2.table<TodoItem>('todos').getAll()).length === 2,
      );

      const todos2 = client2.table<TodoItem>('todos');
      const records = await todos2.getAll();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.text).sort()).toEqual(['Item 1', 'Item 2']);
    });
  },
);
