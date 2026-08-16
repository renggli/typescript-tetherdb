import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  Auth,
  AuthStatus,
  Database,
  SyncStatus,
  TetherClient,
} from '../../src/client/index.js';

import { TetherServer } from '../../src/server/server.js';

describe('Developer Experience & Offline-to-Synced Onboarding (src/client/)', () => {
  let server: TetherServer;
  let httpServer: http.Server;
  let serverPort: number;
  const clientsToClose: TetherClient[] = [];

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    server = new TetherServer();
    await server.declareApp('default', ['notes', 'todos', 'items']);
    httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') {
      serverPort = addr.port;
    }
  });

  afterEach(async () => {
    for (const client of clientsToClose) {
      await client.close();
    }
    clientsToClose.length = 0;
    await server.close();
  });

  it('should initialize with options object and dynamic tables with zero store pre-declaration', async () => {
    const db = new TetherClient({
      name: `simple-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'dx-notes-app',
    });
    clientsToClose.push(db);

    const notes = db.table<{ text: string }>('notes');
    await notes.put('n1', { text: 'Zero config note' });

    expect((await notes.getAll()).length).toBe(1);
    expect((await notes.get('n1'))?.text).toBe('Zero config note');
  });

  it('should provide ergonomic table clear helper', async () => {
    const db = new TetherClient({
      name: `dx-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'dx-tasks-app',
    });
    clientsToClose.push(db);

    const tasks = db.table<{ title: string; done: boolean }>('tasks');
    await tasks.putAll([
      { id: '1', data: { title: 'T1', done: false } },
      { id: '2', data: { title: 'T2', done: true } },
      { id: '3', data: { title: 'T3', done: false } },
    ]);

    expect((await tasks.getAll()).length).toBe(3);

    // clear
    const clearedCount = await tasks.clear();
    expect(clearedCount).toBe(3);
    expect((await tasks.getAll()).length).toBe(0);
  });

  it('should support Auth direct authentication requests and state tracking', async () => {
    const tempDb = new Database(
      `temp-auth-db-${Math.random().toString(36).substring(2, 8)}`,
    );
    const auth = new Auth({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      database: tempDb,
    });

    const regSuccess = await auth.register({
      username: 'dxuser',
      password: 'password123',
    });
    expect(regSuccess).toBe(true);
    expect(auth.username).toBe('dxuser');
    expect(auth.token).toBeDefined();
    expect(auth.status).toBe(AuthStatus.SignedIn);

    await auth.logout();
    expect(auth.status).toBe(AuthStatus.SignedOut);

    const loginSuccess = await auth.login({
      username: 'dxuser',
      password: 'password123',
    });
    expect(loginSuccess).toBe(true);
    expect(auth.status).toBe(AuthStatus.SignedIn);
    await tempDb.close();
  });

  it('should seamlessly transition from local-only offline storage to live sync upon registration', async () => {
    // 1. User starts locally offline with zero configuration
    const db = new TetherClient({
      name: `offline-onboard-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'default',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(db);

    expect(db.syncStatus).toBe(SyncStatus.Disconnected);

    const statuses: SyncStatus[] = [];
    db.onSyncStatusChange((s) => statuses.push(s));

    const todos = db.table<{ title: string }>('todos');

    // 2. User creates items locally offline
    await todos.putAll([
      { id: 'todo-1', data: { title: 'Offline Task 1' } },
      { id: 'todo-2', data: { title: 'Offline Task 2' } },
    ]);

    expect((await todos.getAll()).length).toBe(2);
    const pendingOutbox = await db.database.getPendingOutbox();
    expect(pendingOutbox).toHaveLength(2);

    // 3. User registers account -> seamlessly connects sync & uploads local data
    const success = await db.register({
      username: 'onboard_user',
      password: 'secretpassword',
    });

    expect(success).toBe(true);
    expect(db.username).toBe('onboard_user');

    // Wait for sync to establish and outbox to drain
    await delay(300);

    expect(db.syncStatus).toBe(SyncStatus.Connected);
    expect(statuses).toContain(SyncStatus.Connected);

    // Outbox should now be completely drained
    const outboxAfter = await db.database.getPendingOutbox();
    expect(outboxAfter).toHaveLength(0);

    // Server storage should now have the 2 records
    const user = await server.storage.getUserByUsername('onboard_user');
    expect(user).toBeDefined();
    if (!user) return;
    const defaultApp = await server.storage.getApp('default');
    const todosTable = await defaultApp?.getTable('todos');
    const serverRecords = (await todosTable?.getAllRecords(user)) ?? [];
    expect(serverRecords).toHaveLength(2);
  });

  it('should infer host, port, and basePath when configured at TetherClient construction', async () => {
    // Construct client with host, port, and WebSocketClass
    const db = new TetherClient({
      name: `inferred-config-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'default',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(db);

    expect(db.auth.baseUrl).toBe(`http://127.0.0.1:${serverPort}`);
    expect(db.sync.url).toBe(`ws://127.0.0.1:${serverPort}/sync`);

    // Calling register with username and password should just work by default!
    const success = await db.register({
      username: 'auto_inferred_user',
      password: 'password123',
    });
    expect(success).toBe(true);
    expect(db.username).toBe('auto_inferred_user');

    await delay(200);
    expect(db.syncStatus).toBe(SyncStatus.Connected);
  });

  it('should automatically connect and disconnect sync on login and logout', async () => {
    await server.storage.createUser('dynamic_user', 'password123');

    const db = new TetherClient({
      name: `dynamic-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'default',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(db);

    expect(db.syncStatus).toBe(SyncStatus.Disconnected);

    // Login connects sync
    await db.login({ username: 'dynamic_user', password: 'password123' });
    await delay(150);
    expect(db.syncStatus).toBe(SyncStatus.Connected);

    // Logout disconnects sync
    await db.logout();
    expect(db.syncStatus).toBe(SyncStatus.Disconnected);

    // Local operations still work offline
    const notes = db.table<{ text: string }>('notes');
    await notes.put('1', { text: 'Created while sync disconnected' });
    expect((await notes.getAll()).length).toBe(1);

    // Re-login connects sync and flushes outbox
    await db.login({ username: 'dynamic_user', password: 'password123' });
    await delay(200);
    expect(db.syncStatus).toBe(SyncStatus.Connected);

    const outbox = await db.database.getPendingOutbox();
    expect(outbox).toHaveLength(0);
  });

  it('should wipe local data on db.clear()', async () => {
    const db = new TetherClient({
      name: `clear-test-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'clear-app',
    });
    clientsToClose.push(db);

    const notes = db.table<{ text: string }>('notes');
    await notes.put('1', { text: 'Some note' });
    expect((await notes.getAll()).length).toBe(1);

    await db.clear();
    expect((await notes.getAll()).length).toBe(0);
  });
});
