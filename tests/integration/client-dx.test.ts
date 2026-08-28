import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Auth } from '../../src/client/auth.js';
import {
  AuthStatus,
  SyncStatus,
  TetherClient,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage.js';
import { TetherServer } from '../../src/server/server.js';
import { waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'Developer Experience & Offline-to-Synced Onboarding ($name)',
  ({ createBackend }) => {
    let storageContext: StorageContext;
    let server: TetherServer;
    let httpServer: http.Server;
    let serverPort: number;
    const clientsToClose: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();
      server = new TetherServer({
        storage: storageContext.storage,
      });
      await server.storage.createTable('notes');
      await server.storage.createTable('todos');
      await server.storage.createTable('items');
      httpServer = await server.listen(0, '127.0.0.1');
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr !== null) {
        serverPort = addr.port;
      }
    });

    afterEach(async () => {
      for (const client of clientsToClose) {
        await client.close();
      }
      clientsToClose.length = 0;
      await server.close();
      await storageContext.cleanup();
    });

    it('should allow simple CRUD operations with Table instance', async () => {
      const db = new TetherClient(
        `simple-crud-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(db);

      const tasks = db.table<{ title: string; done?: boolean }>('tasks');

      // put
      await tasks.put('t1', { title: 'First Task', done: false });
      await tasks.put('t2', { title: 'Second Task', done: true });

      // get
      const t1 = await tasks.get('t1');
      expect(t1).toEqual({ title: 'First Task', done: false });

      // getAll
      const all = await tasks.getAll();
      expect(all).toHaveLength(2);

      // putAll
      await tasks.putAll([
        { id: 't3', data: { title: 'Third Task', done: false } },
        { id: 't4', data: { title: 'Fourth Task', done: true } },
      ]);
      expect((await tasks.getAll()).length).toBe(4);

      // delete
      await tasks.delete('t1');
      expect(await tasks.get('t1')).toBeUndefined();

      // deleteAll
      await tasks.deleteAll(['t2', 't3']);
      expect((await tasks.getAll()).length).toBe(1);

      // clear
      const clearedCount = await tasks.clear();
      expect(clearedCount).toBe(1);
      expect((await tasks.getAll()).length).toBe(0);
    });

    it('should support Auth direct authentication requests and state tracking', async () => {
      const tempStorage = new Storage(
        `temp-auth-db-${Math.random().toString(36).substring(2, 8)}`,
      );
      const auth = new Auth({
        baseUrl: `http://127.0.0.1:${serverPort}`,
        storage: tempStorage,
      });

      const regSuccess = await auth.register({
        userName: 'dxuser',
        password: 'password123',
      });
      expect(regSuccess).toBe(true);
      expect(auth.userName).toBe('dxuser');
      expect(auth.token).toBeDefined();
      expect(auth.status).toBe(AuthStatus.SignedIn);

      await auth.logout();
      expect(auth.status).toBe(AuthStatus.SignedOut);

      const loginSuccess = await auth.login({
        userName: 'dxuser',
        password: 'password123',
      });
      expect(loginSuccess).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedIn);
      await tempStorage.close();
    });

    it('should seamlessly transition from local-only offline storage to live sync upon registration', async () => {
      // 1. User starts locally offline with zero configuration
      const dbName = `offline-onboard-${Math.random().toString(36).substring(2, 8)}`;
      const db = new TetherClient({
        name: dbName,
        host: '127.0.0.1',
        port: serverPort,
        webSocketClass: WebSocket,
      });
      clientsToClose.push(db);

      const statuses: SyncStatus[] = [];
      db.onSyncStatusChange.register((s) => statuses.push(s));

      const todos = db.table<{ title: string }>('todos');

      // 2. User creates items locally offline
      await todos.putAll([
        { id: 'todo-1', data: { title: 'Offline Task 1' } },
        { id: 'todo-2', data: { title: 'Offline Task 2' } },
      ]);

      expect((await todos.getAll()).length).toBe(2);
      const rawStorage = new Storage(dbName);
      const pendingOutbox = await rawStorage.getPendingOutbox();
      expect(pendingOutbox).toHaveLength(2);
      await rawStorage.close();

      // 3. User registers account -> seamlessly connects sync & uploads local data
      const success = await db.register({
        userName: 'onboard_user',
        password: 'secretpassword',
      });

      expect(success).toBe(true);
      expect(db.userName).toBe('onboard_user');

      // Wait for sync to establish and outbox to drain
      await waitForCondition(() => db.syncStatus === SyncStatus.Connected);

      expect(db.syncStatus).toBe(SyncStatus.Connected);
      expect(statuses).toContain(SyncStatus.Connected);

      // Outbox should now be completely drained
      const checkStorage = new Storage(dbName);
      await waitForCondition(async () => {
        const outboxAfter = await checkStorage.getPendingOutbox();
        return outboxAfter.length === 0;
      });
      await checkStorage.close();

      // Server storage should now have the 2 records
      const user = await server.storage.getUserByUserName('onboard_user');
      expect(user).toBeDefined();
      if (!user) return;
      const todosTable = await server.storage.getTable('todos');
      const serverRecords = (await todosTable?.getAllRecords(user)) ?? [];
      expect(serverRecords).toHaveLength(2);
    });

    it('should infer host, port, and basePath when configured at TetherClient construction', async () => {
      // Construct client with host, port, and WebSocketClass
      const db = new TetherClient(
        `inferred-config-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: '127.0.0.1',
          port: serverPort,
          webSocketClass: WebSocket,
        },
      );
      clientsToClose.push(db);

      // Calling register with username and password should just work by default!
      const success = await db.register({
        userName: 'auto_inferred_user',
        password: 'password123',
      });
      expect(success).toBe(true);
      expect(db.userName).toBe('auto_inferred_user');

      await waitForCondition(() => db.syncStatus === SyncStatus.Connected);
      expect(db.syncStatus).toBe(SyncStatus.Connected);
    });

    it('should automatically connect and disconnect sync on login and logout', async () => {
      await server.storage.createUser('dynamic_user', 'password123');

      const dbName = `dynamic-db-${Math.random().toString(36).substring(2, 8)}`;
      const db = new TetherClient({
        name: dbName,
        host: '127.0.0.1',
        port: serverPort,
        webSocketClass: WebSocket,
      });
      clientsToClose.push(db);

      expect([SyncStatus.Connecting, SyncStatus.Connected]).toContain(
        db.syncStatus,
      );

      // Login connects sync
      await db.login({ userName: 'dynamic_user', password: 'password123' });
      await waitForCondition(() => db.syncStatus === SyncStatus.Connected);
      expect(db.syncStatus).toBe(SyncStatus.Connected);

      // Logout reconnects sync as guest
      await db.logout();
      expect(db.authStatus).toBe(AuthStatus.SignedOut);

      // Local operations still work offline
      const notes = db.table<{ text: string }>('notes');
      await notes.put('1', { text: 'Created while signed out' });
      expect((await notes.getAll()).length).toBe(1);

      // Re-login connects sync and flushes outbox
      await db.login({ userName: 'dynamic_user', password: 'password123' });
      await waitForCondition(() => db.syncStatus === SyncStatus.Connected);
      expect(db.syncStatus).toBe(SyncStatus.Connected);

      const checkStorage = new Storage(dbName);
      await waitForCondition(async () => {
        const outbox = await checkStorage.getPendingOutbox();
        return outbox.length === 0;
      });
      await checkStorage.close();
    });

    it('should wipe local data on db.clear()', async () => {
      const db = new TetherClient(
        `clear-test-db-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(db);

      const notes = db.table<{ text: string }>('notes');
      await notes.put('1', { text: 'Some note' });
      expect((await notes.getAll()).length).toBe(1);

      await db.clear();
      expect((await notes.getAll()).length).toBe(0);
    });
  },
);
