import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { SyncStatus, TetherClient } from '../../src/client/index.js';
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
          host: '127.0.0.1',
          port,
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
              userName: 'starter_user',
              password: 'password123',
            }),
          },
        );
        expect(regRes.ok).toBe(true);
        const body = (await regRes.json()) as {
          userId: string;
          userName: string;
        };
        expect(body.userName).toBe('starter_user');

        await runner.close();
      } finally {
        await startStorageContext.cleanup();
      }
    });
  },
);
