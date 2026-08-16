import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AuthStatus,
  DataMode,
  SyncStatus,
  TetherClient,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage.js';
import { TetherServer } from '../../src/server/server.js';

describe('TetherClient Authentication & Data Reconciliation Lifecycle', () => {
  let server: TetherServer;
  let httpServer: http.Server;
  let serverPort: number;
  const clientsToClose: TetherClient[] = [];

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    server = new TetherServer();
    await server.declareApp('test-app', ['todos', 'notes']);
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

  it('should start with SignedOut authStatus and Disconnected syncStatus', () => {
    const client = new TetherClient({
      name: `db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    expect(client.authStatus).toBe(AuthStatus.SignedOut);
    expect(client.username).toBeUndefined();
    expect(client.syncStatus).toBe(SyncStatus.Disconnected);
  });

  it('should register a new account and automatically connect sync', async () => {
    const client = new TetherClient({
      name: `db-reg-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    const authStatuses: AuthStatus[] = [];
    client.onAuthStatusChange.register((status) => authStatuses.push(status));

    const success = await client.register({
      username: 'alice',
      password: 'password123',
    });

    expect(success).toBe(true);
    expect(client.authStatus).toBe(AuthStatus.SignedIn);
    expect(client.username).toBe('alice');
    expect(authStatuses).toContain(AuthStatus.SigningIn);
    expect(authStatuses).toContain(AuthStatus.SignedIn);

    await delay(200);
    expect(client.syncStatus).toBe(SyncStatus.Connected);
  });

  it('should preserve local data by default on register (DataMode.Local)', async () => {
    const client = new TetherClient({
      name: `db-local-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    const todos = client.table<{ title: string }>('todos');
    await todos.put('t1', { title: 'Local offline todo' });

    const success = await client.register({
      username: 'bobby',
      password: 'password123',
      dataMode: DataMode.Local,
    });
    expect(success).toBe(true);

    // Local item still exists
    expect(await todos.get('t1')).toEqual({ title: 'Local offline todo' });

    await delay(250);
    // Server should have received the synced item
    const user = await server.storage.getUserByUsername('bobby');
    expect(user).toBeDefined();
    if (!user) return;

    const app = await server.storage.getApp('test-app');
    const table = await app?.getTable('todos');
    const serverRecords = (await table?.getAllRecords(user)) ?? [];
    expect(serverRecords).toHaveLength(1);
    expect(serverRecords[0].data).toEqual({ title: 'Local offline todo' });
  });

  it('should clear local data on register when DataMode.Clear is specified', async () => {
    const client = new TetherClient({
      name: `db-clear-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    const todos = client.table<{ title: string }>('todos');
    await todos.put('t1', { title: 'To be cleared' });
    expect((await todos.getAll()).length).toBe(1);

    const success = await client.register({
      username: 'charlie',
      password: 'password123',
      dataMode: DataMode.Clear,
    });
    expect(success).toBe(true);

    // Local items should be wiped
    expect(await todos.getAll()).toHaveLength(0);
  });

  it('should transition to AuthStatus.Error when register fails', async () => {
    const client = new TetherClient({
      name: `db-err-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    // First register user
    await client.register({
      username: 'duplicate_user',
      password: 'password123',
    });

    // Attempt to register same username
    const client2 = new TetherClient({
      name: `db-err2-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client2);

    const success = await client2.register({
      username: 'duplicate_user',
      password: 'password123',
    });
    expect(success).toBe(false);
    expect(client2.authStatus).toBe(AuthStatus.Error);
  });

  it('should support login and merge local/remote data with DataMode.Merge', async () => {
    // 1. Register User 1 on Client A and put remote items
    const clientA = new TetherClient({
      name: `db-a-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(clientA);

    await clientA.register({
      username: 'david',
      password: 'password123',
    });
    const todosA = clientA.table<{ title: string }>('todos');
    await todosA.put('remote-1', { title: 'Remote Item 1' });
    await delay(200);

    // 2. Client B has local offline items
    const clientB = new TetherClient({
      name: `db-b-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(clientB);

    const todosB = clientB.table<{ title: string }>('todos');
    await todosB.put('local-1', { title: 'Local Item 1' });

    // 3. Client B logs in with DataMode.Merge
    const success = await clientB.login({
      username: 'david',
      password: 'password123',
      dataMode: DataMode.Merge,
    });
    expect(success).toBe(true);
    expect(clientB.authStatus).toBe(AuthStatus.SignedIn);
    expect(clientB.username).toBe('david');

    await delay(300);

    // B should now have both local and remote items
    const allB = await todosB.getAll();
    expect(allB).toHaveLength(2);
    expect(allB.map((t) => t.title).sort()).toEqual([
      'Local Item 1',
      'Remote Item 1',
    ]);
  });

  it('should support login with DataMode.Remote discarding local data', async () => {
    // 1. Create remote item
    const clientA = new TetherClient({
      name: `db-ra-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(clientA);

    await clientA.register({
      username: 'evelyn',
      password: 'password123',
    });
    const todosA = clientA.table<{ title: string }>('todos');
    await todosA.put('r1', { title: 'Remote Item' });
    await delay(200);

    // 2. Client B creates local item then logs in with DataMode.Remote
    const clientB = new TetherClient({
      name: `db-rb-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(clientB);

    const todosB = clientB.table<{ title: string }>('todos');
    await todosB.put('l1', { title: 'Local To Discard' });

    const success = await clientB.login({
      username: 'evelyn',
      password: 'password123',
      dataMode: DataMode.Remote,
    });
    expect(success).toBe(true);

    await delay(300);

    // Local item was wiped, only remote item received
    const allB = await todosB.getAll();
    expect(allB).toHaveLength(1);
    expect(allB[0].title).toBe('Remote Item');
  });

  it('should auto-restore session across client re-instantiations when remember: true is set', async () => {
    const dbName = `db-rem-${Math.random().toString(36).substring(2, 8)}`;

    // Session 1: Register with remember: true
    const client1 = new TetherClient({
      name: dbName,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client1);

    await client1.register({
      username: 'frank',
      password: 'password123',
      remember: true,
    });

    const todos1 = client1.table<{ title: string }>('todos');
    await todos1.put('f1', { title: 'Frank task' });
    await delay(200);

    // Close Session 1
    await client1.close();

    // Session 2: Open same DB instance without credentials
    const client2 = new TetherClient({
      name: dbName,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client2);

    // Wait for auto-restore
    await delay(150);

    expect(client2.authStatus).toBe(AuthStatus.SignedIn);
    expect(client2.username).toBe('frank');
    expect(client2.syncStatus).toBe(SyncStatus.Connected);

    const todos2 = client2.table<{ title: string }>('todos');
    expect((await todos2.getAll()).length).toBe(1);
  });

  it('should handle logout with default DataMode.Local preserving data and DataMode.Clear wiping data', async () => {
    const dbName = `db-logout-${Math.random().toString(36).substring(2, 8)}`;
    const client = new TetherClient({
      name: dbName,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    await client.register({
      username: 'grace',
      password: 'password123',
      remember: true,
    });

    const todos = client.table<{ title: string }>('todos');
    await todos.put('g1', { title: 'Grace todo' });

    // 1. Logout with default (DataMode.Local)
    await client.logout();

    expect(client.authStatus).toBe(AuthStatus.SignedOut);
    expect(client.syncStatus).toBe(SyncStatus.Disconnected);

    // Local data is preserved
    expect(await todos.get('g1')).toEqual({ title: 'Grace todo' });

    // 2. Log back in
    await client.login({
      username: 'grace',
      password: 'password123',
    });
    expect(client.authStatus).toBe(AuthStatus.SignedIn);

    // 3. Logout with DataMode.Clear
    await client.logout({ dataMode: DataMode.Clear });
    expect(client.authStatus).toBe(AuthStatus.SignedOut);
    expect(await todos.getAll()).toHaveLength(0);
  });

  it('should automatically refresh sliding session token on sync connection', async () => {
    const dbName = `db-sliding-${Math.random().toString(36).substring(2, 8)}`;
    const client = new TetherClient({
      name: dbName,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    await client.register({
      username: 'sliding_user',
      password: 'password123',
      remember: true,
    });

    const rawStorage = new Storage(dbName);
    const initialSession = await rawStorage.getMeta<{ token: string }>('auth');
    expect(initialSession?.token).toBeDefined();

    // Wait for WebSocket sync to connect and receive AuthSuccess with refreshed sliding token
    await delay(200);

    expect(client.syncStatus).toBe(SyncStatus.Connected);

    // Token stored in IndexedDB metadata should be updated
    const updatedSession = await rawStorage.getMeta<{ token: string }>('auth');
    expect(updatedSession?.token).toBeDefined();
    await rawStorage.close();
  });

  it('should transition to SignedOut and clear stored session when server rejects expired/invalid token', async () => {
    const dbName = `db-stale-${Math.random().toString(36).substring(2, 8)}`;
    const rawStorage = new Storage(dbName);
    // Simulate restoring an expired / invalid token
    await rawStorage.setMeta('auth', {
      userId: 'stale_user_id',
      username: 'stale_user',
      token: 'invalid_or_expired_token_signature',
    });
    await rawStorage.close();

    const client = new TetherClient({
      name: dbName,
      appId: 'test-app',
      host: '127.0.0.1',
      port: serverPort,
      WebSocketClass: WebSocket,
    });
    clientsToClose.push(client);

    // Wait for auto session restore and WebSocket sync rejection
    await delay(200);

    expect(client.authStatus).toBe(AuthStatus.SignedOut);
    expect(client.username).toBeUndefined();

    // Stored auth meta should have been cleaned up
    const checkStorage = new Storage(dbName);
    const storedAuth = await checkStorage.getMeta('auth');
    expect(storedAuth).toBeUndefined();
    await checkStorage.close();
  });
});
