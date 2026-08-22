import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { TetherClient } from '../../src/client/client.js';
import { startServer, TetherServer } from '../../src/server/server.js';
import { OperationType } from '../../src/shared/types.js';
import { waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'Multi-Application Support & Server Discovery ($name)',
  ({ createBackend }) => {
    let storageContext: StorageContext;
    let server: TetherServer;
    let port: number;
    let closeServer: (() => Promise<void>) | null = null;
    const activeClients: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();

      server = new TetherServer({
        storage: storageContext.storage,
      });
      await server.declareApp('todo-app', ['items']);
      await server.declareApp('notes-app', ['items']);
      await server.declareApp('chat-app', ['channels', 'messages']);
      await server.declareApp('docs-app', ['pages']);
      await server.declareApp('app-alpha', ['feed']);
      await server.declareApp('app-beta', ['feed']);

      const httpServer = await server.listen(0, '127.0.0.1');
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      closeServer = () => server.close();
    });

    afterEach(async () => {
      for (const client of activeClients) {
        await client.close();
      }
      activeClients.length = 0;

      if (closeServer) {
        await closeServer();
        closeServer = null;
      }

      await storageContext.cleanup();
    });

    it('should isolate data across different applications for the same user', async () => {
      // 1. Register user
      const db1 = new TetherClient(`test_todo_app_${Date.now()}`, {
        appId: 'todo-app',
        host: '127.0.0.1',
        port,
        webSocketClass: NodeWebSocket,
      });
      activeClients.push(db1);

      const success1 = await db1.register({
        username: 'multi_user',
        password: 'password123',
      });
      expect(success1).toBe(true);

      const todoTable = db1.table<{ title: string }>('items');
      await todoTable.put('todo_1', { title: 'First Todo Item' });

      // Wait for sync flush
      await waitForCondition(async () => {
        const user = await server.storage.getUserByUsername('multi_user');
        if (!user) return false;
        const todoApp = await server.storage.getApp('todo-app');
        const todosTable = await todoApp?.getTable('items');
        return ((await todosTable?.getAllRecords(user)) ?? []).length === 1;
      });

      // 2. Open a separate application database for the same user
      const db2 = new TetherClient(`test_notes_app_${Date.now()}`, {
        appId: 'notes-app',
        host: '127.0.0.1',
        port,
        webSocketClass: NodeWebSocket,
      });
      activeClients.push(db2);

      const success2 = await db2.login({
        username: 'multi_user',
        password: 'password123',
      });
      expect(success2).toBe(true);

      const notesTable = db2.table<{ title: string }>('items');
      await notesTable.put('note_1', { title: 'First Note Item' });

      // Wait for sync flush
      await waitForCondition(async () => {
        const user = await server.storage.getUserByUsername('multi_user');
        if (!user) return false;
        const noteApp = await server.storage.getApp('notes-app');
        const notesTableServer = await noteApp?.getTable('items');
        return (
          ((await notesTableServer?.getAllRecords(user)) ?? []).length === 1
        );
      });

      // 3. Verify data isolation
      const todoRecords = await todoTable.getAll();
      expect(todoRecords).toHaveLength(1);
      expect(todoRecords[0]?.title).toBe('First Todo Item');

      const noteRecords = await notesTable.getAll();
      expect(noteRecords).toHaveLength(1);
      expect(noteRecords[0]?.title).toBe('First Note Item');

      // 4. Verify server storage isolation
      const apps = await server.storage.getApps();
      expect(apps.map((a) => a.id)).toContain('notes-app');
      expect(apps.map((a) => a.id)).toContain('todo-app');

      // Check todo-app data
      const user = await server.storage.getUserByUsername('multi_user');
      expect(user).toBeDefined();
      if (!user) return;
      const todoApp = await server.storage.getApp('todo-app');
      const todosTable = await todoApp?.getTable('items');
      const todoRecordsList = (await todosTable?.getAllRecords(user)) ?? [];
      expect(todoRecordsList).toHaveLength(1);

      // Check notes-app data
      const noteApp = await server.storage.getApp('notes-app');
      expect(noteApp).toBeDefined();
      const noteTables = (await noteApp?.getTables()) ?? [];
      expect(noteTables.map((t) => t.name)).toEqual(['items']);
    });

    it('should isolate real-time broadcasts so mutations in appA do not trigger subscribers in appB', async () => {
      // App A client 1
      const clientA1 = new TetherClient(`appA_c1_${Date.now()}`, {
        appId: 'app-alpha',
        host: '127.0.0.1',
        port,
        webSocketClass: NodeWebSocket,
      });
      activeClients.push(clientA1);

      await clientA1.register({
        username: 'broadcast_user',
        password: 'password123',
      });

      // App A client 2 (same app, same user)
      const clientA2 = new TetherClient(`appA_c2_${Date.now()}`, {
        appId: 'app-alpha',
        host: '127.0.0.1',
        port,
        webSocketClass: NodeWebSocket,
      });
      activeClients.push(clientA2);
      await clientA2.login({
        username: 'broadcast_user',
        password: 'password123',
      });

      // App B client 1 (different app, same user)
      const clientB1 = new TetherClient(`appB_c1_${Date.now()}`, {
        appId: 'app-beta',
        host: '127.0.0.1',
        port,
        webSocketClass: NodeWebSocket,
      });
      activeClients.push(clientB1);
      await clientB1.login({
        username: 'broadcast_user',
        password: 'password123',
      });

      const receivedA2: string[] = [];
      clientA2.table<{ text: string }>('feed').onChange.register((events) => {
        for (const e of events) {
          if (e.data?.text) receivedA2.push(e.data.text);
        }
      });

      const receivedB1: string[] = [];
      clientB1.table<{ text: string }>('feed').onChange.register((events) => {
        for (const e of events) {
          if (e.data?.text) receivedB1.push(e.data.text);
        }
      });

      // Mutate in App A
      await clientA1
        .table<{ text: string }>('feed')
        .put('f1', { text: 'Alpha Feed 1' });

      // Wait for WebSocket broadcast
      await waitForCondition(() => receivedA2.length > 0);

      expect(receivedA2).toContain('Alpha Feed 1');
      expect(receivedB1).toHaveLength(0); // Beta received zero events from Alpha!
    });

    it('should support multi-app isolation across distinct apps and tables', async () => {
      const { storage: storageInstance, cleanup } = await createBackend();
      try {
        const appOne = await storageInstance.createApp('app-one');
        const tableOne = await appOne.createTable('settings');
        const appTwo = await storageInstance.createApp('app-two');
        const tableTwo = await appTwo.createTable('settings');
        const user = await storageInstance.createUser('user_mem_123', 'pass');

        await tableOne.applyChanges(user, [
          {
            table: 'settings',
            id: 's1',
            op: OperationType.Put,
            data: { theme: 'dark' },
            timestamp: 100,
            clientId: 'c1',
          },
        ]);

        await tableTwo.applyChanges(user, [
          {
            table: 'settings',
            id: 's1',
            op: OperationType.Put,
            data: { theme: 'light' },
            timestamp: 200,
            clientId: 'c2',
          },
        ]);

        const appOneRecord = await tableOne.getRecord(user, 's1');
        expect(appOneRecord?.data).toEqual({ theme: 'dark' });

        const appTwoRecord = await tableTwo.getRecord(user, 's1');
        expect(appTwoRecord?.data).toEqual({ theme: 'light' });

        const apps = await storageInstance.getApps();
        expect(apps.map((a) => a.id)).toEqual(['app-one', 'app-two']);

        const appOneTables = await appOne.getTables();
        expect(appOneTables.map((t) => t.name)).toEqual(['settings']);
      } finally {
        await cleanup();
      }
    });

    it('should start and shut down cleanly via startServer helper', async () => {
      const startStorageContext = await createBackend();
      try {
        const runner = await startServer({
          port: 0,
          host: '127.0.0.1',
          storage: startStorageContext.storage,
        });

        expect(runner.port).toBeGreaterThan(0);
        const regRes = await fetch(
          `http://${runner.host}:${runner.port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'starter_user',
              password: 'password123',
            }),
          },
        );
        expect(regRes.ok).toBe(true);
        const body = (await regRes.json()) as {
          userId: string;
          username: string;
        };
        expect(body.username).toBe('starter_user');

        await runner.close();
      } finally {
        await startStorageContext.cleanup();
      }
    });
  },
);
