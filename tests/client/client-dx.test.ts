import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  type AuthResult,
  SyncStatus,
  TetherAuthClient,
  TetherDB,
} from '../../src/client/index.js';
import { TetherServer } from '../../src/server/server.js';

describe('Developer Experience & Offline-to-Synced Onboarding (src/client/)', () => {
  let server: TetherServer;
  let httpServer: http.Server;
  let serverUrl: string;
  let wsUrl: string;
  const clientsToClose: TetherDB[] = [];

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    server = new TetherServer({
      apps: { default: ['notes', 'todos', 'items'] },
    });
    httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') {
      serverUrl = `http://127.0.0.1:${addr.port}`;
      wsUrl = `ws://127.0.0.1:${addr.port}/sync`;
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
    const db = new TetherDB({
      name: `simple-db-${Math.random().toString(36).substring(2, 8)}`,
    });
    clientsToClose.push(db);

    const notes = db.table<{ text: string }>('notes');
    await notes.put('n1', { text: 'Zero config note' });

    expect((await notes.getAll()).length).toBe(1);
    expect((await notes.get('n1'))?.text).toBe('Zero config note');
  });

  it('should provide ergonomic table clear helper', async () => {
    const db = new TetherDB({
      name: `dx-db-${Math.random().toString(36).substring(2, 8)}`,
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

  it('should support TetherAuthClient direct authentication requests', async () => {
    const authClient = new TetherAuthClient({ serverUrl });
    expect(await authClient.checkHealth()).toBe(true);

    const regResult = await authClient.register({
      username: 'dxuser',
      password: 'password123',
    });
    expect(regResult.username).toBe('dxuser');
    expect(regResult.token).toBeDefined();

    const loginResult = await authClient.login({
      username: 'dxuser',
      password: 'password123',
    });
    expect(loginResult.userId).toBe(regResult.userId);
  });

  it('should seamlessly transition from local-only offline storage to live sync upon registration', async () => {
    // 1. User starts locally offline with zero configuration
    const db = new TetherDB({
      name: `offline-onboard-${Math.random().toString(36).substring(2, 8)}`,
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
    const pendingOutbox = await db.idbManager.getPendingOutbox();
    expect(pendingOutbox).toHaveLength(2);

    // 3. User registers account -> seamlessly connects sync & uploads local data
    const authResult: AuthResult = await db.register({
      serverUrl,
      username: 'onboard_user',
      password: 'secretpassword',
      appId: 'default',
      WebSocketClass: WebSocket,
    });

    expect(authResult.username).toBe('onboard_user');

    // Wait for sync to establish and outbox to drain
    await delay(300);

    expect(db.syncStatus).toBe(SyncStatus.Connected);
    expect(statuses).toContain(SyncStatus.Connected);

    // Outbox should now be completely drained
    const outboxAfter = await db.idbManager.getPendingOutbox();
    expect(outboxAfter).toHaveLength(0);

    // Server storage should now have the 2 records
    const user = await server.storage.getUser(authResult.userId);
    expect(user).toBeDefined();
    if (!user) return;
    const defaultApp = await server.storage.getApp('default');
    const todosTable = await defaultApp?.getTable('todos');
    const serverRecords = (await todosTable?.getAllRecords(user)) ?? [];
    expect(serverRecords).toHaveLength(2);
  });

  it('should allow disconnecting and reconnecting sync dynamically', async () => {
    const authClient = new TetherAuthClient({ serverUrl });
    const auth = await authClient.register({
      username: 'dynamic_user',
      password: 'password123',
    });

    const db = new TetherDB({
      name: `dynamic-db-${Math.random().toString(36).substring(2, 8)}`,
    });
    clientsToClose.push(db);

    // Connect sync dynamically
    db.enableSync({
      url: wsUrl,
      token: auth.token,
      appId: 'default',
      WebSocketClass: WebSocket,
    });

    await delay(150);
    expect(db.syncStatus).toBe(SyncStatus.Connected);

    // Disconnect sync
    db.disableSync();
    expect(db.syncStatus).toBe(SyncStatus.Disconnected);

    // Local operations still work offline
    const notes = db.table<{ text: string }>('notes');
    await notes.put('1', { text: 'Created while sync disabled' });
    expect((await notes.getAll()).length).toBe(1);

    // Re-enable sync
    db.enableSync({
      url: wsUrl,
      token: auth.token,
      appId: 'default',
      WebSocketClass: WebSocket,
    });

    await delay(200);
    expect(db.syncStatus).toBe(SyncStatus.Connected);

    const outbox = await db.idbManager.getPendingOutbox();
    expect(outbox).toHaveLength(0);
  });

  it('should wipe local data on db.clear()', async () => {
    const db = new TetherDB({
      name: `clear-test-db-${Math.random().toString(36).substring(2, 8)}`,
    });
    clientsToClose.push(db);

    const notes = db.table<{ text: string }>('notes');
    await notes.put('1', { text: 'Some note' });
    expect((await notes.getAll()).length).toBe(1);

    await db.clear();
    expect((await notes.getAll()).length).toBe(0);
  });
});
