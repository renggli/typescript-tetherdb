import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { DataMode, SyncStatus, TetherClient } from '../../src/client/index.js';
import { startServer, TetherServer } from '../../src/server/server.js';
import { Permission } from '../../src/shared/types.js';
import { waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'Table Permissions ($name)',
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

      // Declare tables with different permission policies
      await server.declareTable('private_notes', {
        permissions: {
          read: Permission.Owner,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });
      await server.declareTable('public_announcements', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });
      await server.declareTable('public_chat', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });
      await server.declareTable('append_only_log', {
        permissions: {
          read: Permission.Authenticated,
          create: Permission.Authenticated,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });
      await server.declareTable(
        'public_readonly_rules',
        {
          permissions: {
            read: Permission.Everybody,
            create: Permission.Nobody,
            update: Permission.Nobody,
            delete: Permission.Nobody,
          },
        },
        [{ id: 'rule1', data: { text: 'Be kind' } }],
      );
      await server.declareTable(
        'auth_readonly_config',
        {
          permissions: {
            read: Permission.Authenticated,
            create: Permission.Nobody,
            update: Permission.Nobody,
            delete: Permission.Nobody,
          },
        },
        [{ id: 'cfg1', data: { setting: 'v1' } }],
      );
      await server.declareTable('system_internal', {
        permissions: {
          read: Permission.Nobody,
          create: Permission.Nobody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });

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

    function createClient(dbName?: string): TetherClient {
      const client = new TetherClient(
        dbName ?? `test_db_${Math.random().toString(36).substring(2, 8)}`,
        {
          url: `ws://127.0.0.1:${port}/tether`,
          webSocketClass: NodeWebSocket,
        },
      );
      activeClients.push(client);
      return client;
    }

    it('should isolate private table data between different users', async () => {
      await server.declareUser('alice_user', 'password123');
      await server.declareUser('bob_user', 'password123');

      const client1 = createClient();
      const client2 = createClient();

      await client1.login({ userName: 'alice_user', password: 'password123' });
      await client2.login({ userName: 'bob_user', password: 'password123' });

      await waitForCondition(
        () =>
          client1.syncStatus === SyncStatus.Connected &&
          client2.syncStatus === SyncStatus.Connected,
      );

      const table1 = client1.table<{ title: string }>('private_notes');
      const table2 = client2.table<{ title: string }>('private_notes');

      await table1.put('n1', { title: "Alice's Secret" });
      await table2.put('n2', { title: "Bob's Secret" });

      // Wait for server sync
      const userAlice = await server.storage.getUserByUserName('alice_user');
      const userBob = await server.storage.getUserByUserName('bob_user');
      const serverTable = await server.storage.getTable('private_notes');

      await waitForCondition(async () => {
        const aliceRecs = (await serverTable?.getAllRecords(userAlice)) ?? [];
        const bobRecs = (await serverTable?.getAllRecords(userBob)) ?? [];
        return aliceRecs.length === 1 && bobRecs.length === 1;
      });

      // Verify each client only sees their own private notes
      expect(await table1.getAll()).toEqual([{ title: "Alice's Secret" }]);
      expect(await table2.getAll()).toEqual([{ title: "Bob's Secret" }]);
      expect(await table1.get('n2')).toBeUndefined();
      expect(await table2.get('n1')).toBeUndefined();
    });

    it('should keep private table mutations local for unauthenticated guests without server errors and sync upon login', async () => {
      const guest = createClient();
      await waitForCondition(() => guest.syncStatus === SyncStatus.Connected);

      const clientErrors: Error[] = [];
      guest.onError.register((err) => clientErrors.push(err));

      const privateNotes = guest.table<{ title: string }>('private_notes');
      await privateNotes.put('p1', { title: 'Local Guest Secret' });

      // Local write is immediately available
      expect(await privateNotes.get('p1')).toEqual({
        title: 'Local Guest Secret',
      });

      // Allow background debounce/push cycles
      await new Promise((r) => setTimeout(r, 100));

      // No client errors or disconnected status
      expect(clientErrors).toHaveLength(0);
      expect(guest.syncStatus).toBe(SyncStatus.Connected);

      // Register and login with the guest data
      await server.declareUser('secret_keeper', 'password123');
      await guest.login({
        userName: 'secret_keeper',
        password: 'password123',
        dataMode: DataMode.Merge,
      });
      await waitForCondition(() => guest.syncStatus === SyncStatus.Connected);

      // Server should now receive the private note in secret_keeper's partition
      const user = await server.storage.getUserByUserName('secret_keeper');
      const serverTbl = await server.storage.getTable('private_notes');
      await waitForCondition(async () => {
        const records = await serverTbl?.getAllRecords(user);
        return (records ?? []).length === 1;
      });

      const records = await serverTbl?.getAllRecords(user);
      expect(records?.[0].data).toEqual({ title: 'Local Guest Secret' });
    });

    it('should allow guest clients to read and subscribe to public-read tables', async () => {
      // Client 1: authenticated publisher
      await server.declareUser('admin_user', 'password123');
      const publisher = createClient();
      await publisher.login({
        userName: 'admin_user',
        password: 'password123',
      });
      await waitForCondition(
        () => publisher.syncStatus === SyncStatus.Connected,
      );

      // Client 2: unauthenticated guest
      const guest = createClient();
      await waitForCondition(() => guest.syncStatus === SyncStatus.Connected);

      const guestAnnouncements: string[] = [];
      const guestTable = guest.table<{ text: string }>('public_announcements');
      guestTable.onChange.register((events) => {
        for (const e of events) {
          if (e.data?.text) guestAnnouncements.push(e.data.text);
        }
      });

      // Publisher creates an announcement
      const pubTable = publisher.table<{ text: string }>(
        'public_announcements',
      );
      await pubTable.put('a1', { text: 'Welcome to the platform!' });

      // Guest receives real-time broadcast
      await waitForCondition(() => guestAnnouncements.length > 0);
      expect(guestAnnouncements).toContain('Welcome to the platform!');

      // Fresh guest connects and gets snapshot
      const newGuest = createClient();
      await waitForCondition(
        () => newGuest.syncStatus === SyncStatus.Connected,
      );
      const newGuestTable = newGuest.table<{ text: string }>(
        'public_announcements',
      );
      await waitForCondition(
        async () => (await newGuestTable.getAll()).length === 1,
      );

      const all = await newGuestTable.getAll();
      expect(all).toEqual([{ text: 'Welcome to the platform!' }]);
    });

    it('should allow guest and authenticated clients to collaborate on public-read-write tables', async () => {
      await server.declareUser('charlie', 'password123');
      const guest = createClient();
      const user = createClient();

      await user.login({ userName: 'charlie', password: 'password123' });
      await waitForCondition(
        () =>
          guest.syncStatus === SyncStatus.Connected &&
          user.syncStatus === SyncStatus.Connected,
      );

      const guestChat = guest.table<{ sender: string; message: string }>(
        'public_chat',
      );
      const userChat = user.table<{ sender: string; message: string }>(
        'public_chat',
      );

      const userMessages: string[] = [];
      userChat.onChange.register((events) => {
        for (const e of events) {
          if (e.data?.message) userMessages.push(e.data.message);
        }
      });

      // Guest posts a message
      await guestChat.put('m1', {
        sender: 'anonymous',
        message: 'Hello from guest!',
      });

      await waitForCondition(() => userMessages.length > 0);
      expect(userMessages).toContain('Hello from guest!');

      // User replies
      await userChat.put('m2', { sender: 'charlie', message: 'Hello guest!' });

      await waitForCondition(
        async () => (await guestChat.getAll()).length === 2,
      );
      expect((await guestChat.getAll()).length).toBe(2);
    });

    it('should enforce append-only permissions on tables', async () => {
      await server.declareUser('logger_a', 'password123');
      await server.declareUser('logger_b', 'password123');

      const clientA = createClient();
      const clientB = createClient();

      await clientA.login({ userName: 'logger_a', password: 'password123' });
      await clientB.login({ userName: 'logger_b', password: 'password123' });

      await waitForCondition(
        () =>
          clientA.syncStatus === SyncStatus.Connected &&
          clientB.syncStatus === SyncStatus.Connected,
      );

      const logsA = clientA.table<{ msg: string }>('append_only_log');
      const logsB = clientB.table<{ msg: string }>('append_only_log');

      // Client A creates log entry
      await logsA.put('log1', { msg: 'Server started' });

      // Client B receives log entry
      await waitForCondition(async () => (await logsB.getAll()).length === 1);
      expect(await logsB.get('log1')).toEqual({ msg: 'Server started' });

      // Client B creates second log entry
      await logsB.put('log2', { msg: 'Worker registered' });

      // Client A receives second log entry
      await waitForCondition(async () => (await logsA.getAll()).length === 2);
      expect(await logsA.getAll()).toHaveLength(2);
    });

    it('should allow guest and authenticated clients to read public readonly tables and reject writes gracefully', async () => {
      const guest = createClient();
      await waitForCondition(() => guest.syncStatus === SyncStatus.Connected);

      const guestRules = guest.table<{ text: string }>('public_readonly_rules');
      await waitForCondition(
        async () => (await guestRules.getAll()).length === 1,
      );
      expect(await guestRules.get('rule1')).toEqual({ text: 'Be kind' });

      // Guest attempts to write
      const guestErrors: Error[] = [];
      guest.onError.register((e) => guestErrors.push(e));
      await guestRules.put('rule2', { text: 'Forbidden write' });

      await waitForCondition(() => guestErrors.length > 0);
      expect(guestErrors[0].message).toBe('Access denied');
      expect(guest.syncStatus).toBe(SyncStatus.Connected);

      // Authenticated user
      await server.declareUser('auditor', 'password123');
      const authClient = createClient();
      await authClient.login({ userName: 'auditor', password: 'password123' });
      await waitForCondition(
        () => authClient.syncStatus === SyncStatus.Connected,
      );

      const authRules = authClient.table<{ text: string }>(
        'public_readonly_rules',
      );
      expect(await authRules.get('rule1')).toEqual({ text: 'Be kind' });

      const authErrors: Error[] = [];
      authClient.onError.register((e) => authErrors.push(e));
      await authRules.put('rule3', { text: 'Auth write rejected' });

      await waitForCondition(() => authErrors.length > 0);
      expect(authClient.syncStatus).toBe(SyncStatus.Connected);

      // Server table still contains only initial record
      const serverTbl = await server.storage.getTable('public_readonly_rules');
      expect(await serverTbl?.getAllRecords()).toHaveLength(1);
    });

    it('should isolate authenticated readonly tables from guests while allowing authenticated users to read', async () => {
      const guest = createClient();
      await waitForCondition(() => guest.syncStatus === SyncStatus.Connected);

      const guestConfig = guest.table<{ setting: string }>(
        'auth_readonly_config',
      );
      expect(await guestConfig.getAll()).toHaveLength(0);

      // Guest writes locally — stays local and does not error on server
      await guestConfig.put('cfg_guest', { setting: 'local_only' });
      expect(await guestConfig.get('cfg_guest')).toEqual({
        setting: 'local_only',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(guest.syncStatus).toBe(SyncStatus.Connected);

      // Authenticated user connects
      await server.declareUser('config_reader', 'password123');
      const authClient = createClient();
      await authClient.login({
        userName: 'config_reader',
        password: 'password123',
      });
      await waitForCondition(
        () => authClient.syncStatus === SyncStatus.Connected,
      );

      const authConfig = authClient.table<{ setting: string }>(
        'auth_readonly_config',
      );
      await waitForCondition(
        async () => (await authConfig.getAll()).length === 1,
      );
      expect(await authConfig.get('cfg1')).toEqual({ setting: 'v1' });
    });

    it('should isolate system internal tables from all clients', async () => {
      const guest = createClient();
      await server.declareUser('sys_user', 'password123');
      const authClient = createClient();
      await authClient.login({ userName: 'sys_user', password: 'password123' });

      await waitForCondition(
        () =>
          guest.syncStatus === SyncStatus.Connected &&
          authClient.syncStatus === SyncStatus.Connected,
      );

      const guestSys = guest.table('system_internal');
      const authSys = authClient.table('system_internal');

      expect(await guestSys.getAll()).toHaveLength(0);
      expect(await authSys.getAll()).toHaveLength(0);

      // Local writes stay local for guest
      await guestSys.put('s1', { internal: true });
      expect(await guestSys.get('s1')).toEqual({ internal: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(guest.syncStatus).toBe(SyncStatus.Connected);
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
        const healthRes = await fetch(
          `http://${runner.host}:${runner.port}/health`,
        );
        expect(healthRes.ok).toBe(true);
        const body = (await healthRes.json()) as {
          status: string;
        };
        expect(body.status).toBe('ok');

        await runner.close();
      } finally {
        await startStorageContext.cleanup();
      }
    });
  },
);
