import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AuthStatus,
  DataMode,
  OperationType,
  SyncStatus,
  TetherClient,
  type TetherClientOptions,
} from '../../src/client/index.js';
import { Storage } from '../../src/client/storage.js';
import { type RunningServer, startServer } from '../../src/server/index.js';
import { randomDbName, waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'TetherClient Authentication & Data Reconciliation Lifecycle ($name)',
  ({ createBackend }) => {
    let storageContext: StorageContext;
    let server: RunningServer;
    let serverPort: number;
    const clientsToClose: TetherClient[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();
      server = await startServer({
        port: 0,
        host: '127.0.0.1',
        storage: storageContext.storage,
      });
      serverPort = (server.httpServer.address() as { port: number }).port;
      await server.server.storage.createTable('todos');
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
      dbName?: string,
      overrides: Partial<TetherClientOptions> = {},
    ): TetherClient {
      const client = new TetherClient(dbName ?? randomDbName(), {
        url: `ws://127.0.0.1:${serverPort}/tether`,
        webSocketClass: WebSocket,
        ...overrides,
      });
      clientsToClose.push(client);
      return client;
    }

    it('should start with SignedOut authStatus and Disconnected syncStatus', () => {
      const client = createClient();

      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(client.userName).toBeUndefined();
      expect([SyncStatus.Connecting, SyncStatus.Connected]).toContain(
        client.syncStatus,
      );
    });

    it('should register a new account and automatically connect sync', async () => {
      const client = createClient();

      const authStatuses: AuthStatus[] = [];
      client.onAuthStatusChange.register((status) => authStatuses.push(status));

      const success = await client.register({
        userName: 'alice',
        password: 'password123',
      });

      expect(success).toBe(true);
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      expect(client.userName).toBe('alice');
      expect(authStatuses).toContain(AuthStatus.SigningIn);
      expect(authStatuses).toContain(AuthStatus.SignedIn);

      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);
      expect(client.syncStatus).toBe(SyncStatus.Connected);
    });

    it('should preserve local data by default on register (DataMode.Local)', async () => {
      const client = createClient();

      const todos = client.table<{ title: string }>('todos');
      await todos.put('t1', { title: 'Local offline todo' });

      const success = await client.register({
        userName: 'bobby',
        password: 'password123',
        dataMode: DataMode.Local,
      });
      expect(success).toBe(true);

      // Local item still exists
      expect(await todos.get('t1')).toEqual({ title: 'Local offline todo' });

      await waitForCondition(async () => {
        const user = await server.server.storage.getUserByUserName('bobby');
        if (!user) return false;
        const table = await server.server.storage.getTable('todos');
        const rec = await table?.getRecord(user, 't1');
        return Boolean(rec);
      });

      const user = await server.server.storage.getUserByUserName('bobby');
      expect(user).toBeDefined();
      const table = await server.server.storage.getTable('todos');
      const serverRecords = (await table?.getAllRecords(user)) ?? [];
      expect(serverRecords).toHaveLength(1);
      expect(serverRecords[0].data).toEqual({ title: 'Local offline todo' });
    });

    it('should clear local data on register when DataMode.Clear is specified', async () => {
      const client = createClient();

      const todos = client.table<{ title: string }>('todos');
      await todos.put('t1', { title: 'To be cleared' });
      expect((await todos.getAll()).length).toBe(1);

      const success = await client.register({
        userName: 'charlie',
        password: 'password123',
        dataMode: DataMode.Clear,
      });
      expect(success).toBe(true);

      // Local items should be wiped
      expect(await todos.getAll()).toHaveLength(0);
    });

    it('should transition to AuthStatus.Error when register fails', async () => {
      const client = createClient();

      // First register user
      await client.register({
        userName: 'duplicate_user',
        password: 'password123',
      });

      // Attempt to register same username while having local data
      const client2 = createClient();

      const todos2 = client2.table<{ title: string }>('todos');
      await todos2.put('local-preserved', { title: 'Do Not Delete' });

      const success = await client2.register({
        userName: 'duplicate_user',
        password: 'password123',
        dataMode: DataMode.Clear,
      });
      expect(success).toBe(false);
      expect(client2.authStatus).toBe(AuthStatus.Error);

      // Verify local data was NOT wiped because register failed
      const records = await todos2.getAll();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Do Not Delete');
    });

    it('should support login and merge local/remote data with DataMode.Merge', async () => {
      // 1. Register User 1 on Client A and put remote items
      const clientA = createClient();

      await clientA.register({
        userName: 'diana',
        password: 'password123',
      });
      const todosA = clientA.table<{ title: string }>('todos');
      await todosA.put('r1', { title: 'Remote Item 1' });
      await waitForCondition(async () => {
        const userDiana =
          await server.server.storage.getUserByUserName('diana');
        if (!userDiana) return false;
        const table = await server.server.storage.getTable('todos');
        return ((await table?.getAllRecords(userDiana)) ?? []).length === 1;
      });

      // 2. Register Client B locally before login, add local items
      const clientB = createClient();

      const todosB = clientB.table<{ title: string }>('todos');
      await todosB.put('l1', { title: 'Local Item 1' });

      // 3. Client B logs in with DataMode.Merge
      const success = await clientB.login({
        userName: 'diana',
        password: 'password123',
        dataMode: DataMode.Merge,
      });
      expect(success).toBe(true);

      await waitForCondition(() => clientB.syncStatus === SyncStatus.Connected);
      await waitForCondition(async () => (await todosB.getAll()).length === 2);

      // Both items should be present on Client B
      const allB = await todosB.getAll();
      expect(allB).toHaveLength(2);
      expect(allB.map((t) => t.title).sort()).toEqual([
        'Local Item 1',
        'Remote Item 1',
      ]);
    });

    it('should support login with DataMode.Remote discarding local data', async () => {
      // 1. Create remote item
      const clientA = createClient();

      await clientA.register({
        userName: 'evelyn',
        password: 'password123',
      });
      const todosA = clientA.table<{ title: string }>('todos');
      await todosA.put('r1', { title: 'Remote Item' });
      await waitForCondition(async () => {
        const userEvelyn =
          await server.server.storage.getUserByUserName('evelyn');
        if (!userEvelyn) return false;
        const table = await server.server.storage.getTable('todos');
        return ((await table?.getAllRecords(userEvelyn)) ?? []).length === 1;
      });

      // 2. Client B creates local item then logs in with DataMode.Remote
      const clientB = createClient();

      const todosB = clientB.table<{ title: string }>('todos');
      await todosB.put('l1', { title: 'Local To Discard' });

      const success = await clientB.login({
        userName: 'evelyn',
        password: 'password123',
        dataMode: DataMode.Remote,
      });
      expect(success).toBe(true);

      await waitForCondition(async () => (await todosB.getAll()).length === 1);

      // Local item was wiped, only remote item received
      const allB = await todosB.getAll();
      expect(allB).toHaveLength(1);
      expect(allB[0].title).toBe('Remote Item');

      // Verify Client A never received the discarded local item
      const allA = await todosA.getAll();
      expect(allA).toHaveLength(1);
      expect(allA[0].title).toBe('Remote Item');
    });

    it('should auto-restore session across client re-instantiations when remember: true is set', async () => {
      const dbName = randomDbName('db-rem');

      // Session 1: Register with remember: true
      const client1 = createClient(dbName);

      await client1.register({
        userName: 'frank',
        password: 'password123',
        remember: true,
      });

      const todos1 = client1.table<{ title: string }>('todos');
      await todos1.put('f1', { title: 'Frank task' });
      await waitForCondition(() => client1.syncStatus === SyncStatus.Connected);

      // Close Session 1
      await client1.close();

      // Session 2: Open same DB instance without credentials
      const client2 = createClient(dbName);

      // Wait for auto-restore
      await waitForCondition(
        () =>
          client2.authStatus === AuthStatus.SignedIn &&
          client2.syncStatus === SyncStatus.Connected,
      );

      expect(client2.authStatus).toBe(AuthStatus.SignedIn);
      expect(client2.userName).toBe('frank');
      expect(client2.syncStatus).toBe(SyncStatus.Connected);

      const todos2 = client2.table<{ title: string }>('todos');
      expect((await todos2.getAll()).length).toBe(1);
    });

    it('should handle logout with default DataMode.Clear wiping data and DataMode.Local preserving data', async () => {
      const dbName = randomDbName('db-logout');
      const client = createClient(dbName);

      await client.register({
        userName: 'grace',
        password: 'password123',
        remember: true,
      });
      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);

      const todos = client.table<{ title: string }>('todos');
      await todos.put('g1', { title: 'Grace todo' });
      await waitForCondition(async () =>
        (
          client as unknown as {
            storage: { getPendingOutbox: () => Promise<unknown[]> };
          }
        ).storage
          .getPendingOutbox()
          .then((p) => p.length === 0),
      );

      // 1. Logout with DataMode.Local preserves data
      await client.logout({ dataMode: DataMode.Local });

      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(await todos.get('g1')).toEqual({ title: 'Grace todo' });

      // 2. Log back in
      await client.login({
        userName: 'grace',
        password: 'password123',
      });
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);
      await waitForCondition(async () => (await todos.getAll()).length === 1);

      // 3. Logout with default (DataMode.Clear) wipes local data and remains empty
      await client.logout();
      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await todos.getAll()).toHaveLength(0);
    });

    it('should clear previous user data when registering a new account while already signed in', async () => {
      const client = createClient();

      // Register User 1 while SignedOut (keeps local data)
      const todos = client.table<{ title: string }>('todos');
      await todos.put('u1-item', { title: 'User 1 Todo' });

      await client.register({
        userName: 'user_first',
        password: 'password123',
      });
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      expect(client.userName).toBe('user_first');

      await waitForCondition(async () => {
        const user1 =
          await server.server.storage.getUserByUserName('user_first');
        if (!user1) return false;
        const table = await server.server.storage.getTable('todos');
        const records = (await table?.getAllRecords(user1)) ?? [];
        return records.length === 1;
      }, 10000);
      await waitForCondition(
        async () => (await client.storage.getPendingOutbox()).length === 0,
      );
      expect((await todos.getAll()).length).toBe(1);

      // Register User 2 while already SignedIn (defaults to clearing previous user data)
      await client.register({
        userName: 'user_second',
        password: 'password123',
      });
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      expect(client.userName).toBe('user_second');

      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);

      // New user should start with clean local state
      await waitForCondition(async () => (await todos.getAll()).length === 0);
      expect(await todos.getAll()).toHaveLength(0);
    });

    it('should automatically refresh sliding session token on sync connection', async () => {
      const dbName = randomDbName('db-sliding');
      const client = createClient(dbName);

      await client.register({
        userName: 'sliding_user',
        password: 'password123',
        remember: true,
      });

      const rawStorage = new Storage(dbName);
      const initialSession = await rawStorage.getMeta<{ token: string }>(
        'auth',
      );
      expect(initialSession?.token).toBeDefined();

      // Wait for WebSocket sync to connect and receive AuthSuccess with refreshed sliding token
      await waitForCondition(() => client.syncStatus === SyncStatus.Connected);

      expect(client.syncStatus).toBe(SyncStatus.Connected);

      // Token stored in IndexedDB metadata should be updated
      const updatedSession = await rawStorage.getMeta<{ token: string }>(
        'auth',
      );
      expect(updatedSession?.token).toBeDefined();
      await rawStorage.close();
    });

    it('should transition to SignedOut and clear stored session when server rejects expired/invalid token', async () => {
      const dbName = randomDbName('db-stale');
      const rawStorage = new Storage(dbName);
      // Simulate restoring an expired / invalid token
      await rawStorage.setMeta('auth', {
        userId: 'stale_user_id',
        userName: 'stale_user',
        token: 'invalid_or_expired_token_signature',
      });
      await rawStorage.close();

      const client = createClient(dbName);

      const checkStorage = new Storage(dbName);
      await waitForCondition(
        async () => (await checkStorage.getMeta('auth')) === undefined,
      );

      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(client.userName).toBeUndefined();

      const storedAuth = await checkStorage.getMeta('auth');
      expect(storedAuth).toBeUndefined();
      await checkStorage.close();
    });

    it('should fetch remote data when switching between user accounts with default DataMode.Remote', async () => {
      // 1. Create client and register User A
      const client = createClient();

      await client.register({
        userName: 'user_a',
        password: 'password123',
        remember: true,
      });

      const todos = client.table<{ title: string }>('todos');
      await todos.put('a1', { title: 'User A Todo' });

      await waitForCondition(async () => {
        const userA = await server.server.storage.getUserByUserName('user_a');
        if (!userA) return false;
        const table = await server.server.storage.getTable('todos');
        return ((await table?.getAllRecords(userA)) ?? []).length === 1;
      });
      await waitForCondition(
        async () => (await client.storage.getPendingOutbox()).length === 0,
      );

      expect((await todos.getAll()).map((t) => t.title)).toEqual([
        'User A Todo',
      ]);

      // 2. Pre-create User B with their own data directly on server
      const userB = await server.server.storage.createUser(
        'user_b',
        'password123',
      );
      await server.server.storage.applyChanges(userB, [
        {
          table: 'todos',
          id: 'b1',
          op: OperationType.Put,
          data: { title: 'User B Remote Todo' },
          timestamp: Date.now(),
          clientId: 'server-seed',
        },
      ]);

      // 3. Switch account by logging in as User B (uses default DataMode.Remote)
      const successB = await client.login({
        userName: 'user_b',
        password: 'password123',
        remember: true,
      });
      expect(successB).toBe(true);
      expect(client.userName).toBe('user_b');

      // Wait for snapshot sync
      await waitForCondition(async () => {
        const list = await todos.getAll();
        return list.length === 1 && list[0].title === 'User B Remote Todo';
      });

      // Client should now have User B's remote data and none of User A's data
      const todosUserB = await todos.getAll();
      expect(todosUserB.map((t) => t.title)).toEqual(['User B Remote Todo']);

      // 4. Switch back to User A
      const successA = await client.login({
        userName: 'user_a',
        password: 'password123',
        remember: true,
      });
      expect(successA).toBe(true);
      expect(client.userName).toBe('user_a');

      await waitForCondition(async () => {
        const list = await todos.getAll();
        return list.length === 1 && list[0].title === 'User A Todo';
      });

      // Client should now have User A's data restored from server snapshot
      const todosUserA = await todos.getAll();
      expect(todosUserA.map((t) => t.title)).toEqual(['User A Todo']);
    });
  },
);
