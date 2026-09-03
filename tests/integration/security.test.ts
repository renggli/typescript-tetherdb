import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AuthStatus,
  OperationType,
  SyncStatus,
  TetherClient,
  type TetherClientOptions,
} from '../../src/client/index.js';
import { type RunningServer, startServer } from '../../src/server/index.js';
import { User } from '../../src/server/storage/user.js';
import {
  ClientMessageType,
  Permission,
  PROTOCOL_VERSION,
} from '../../src/shared/types.js';
import { randomDbName, waitForCondition } from '../helpers.js';
import {
  type StorageContext,
  storageDescriptors,
} from '../server/storage/matrix.js';

describe.each(storageDescriptors)(
  'Tether Security Integration Suite ($name)',
  ({ createBackend }) => {
    let storageContext: StorageContext;
    let server: RunningServer;
    let serverPort: number;
    const clientsToClose: TetherClient[] = [];
    const rawSocketsToClose: WebSocket[] = [];

    beforeEach(async () => {
      storageContext = await createBackend();
      server = await startServer({
        port: 0,
        host: '127.0.0.1',
        storage: storageContext.storage,
      });
      serverPort = (server.httpServer.address() as { port: number }).port;
    });

    afterEach(async () => {
      for (const client of clientsToClose) {
        await client.close();
      }
      clientsToClose.length = 0;

      for (const ws of rawSocketsToClose) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
      rawSocketsToClose.length = 0;

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

    function createRawWebSocket(): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tether`);
        rawSocketsToClose.push(ws);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
      });
    }

    it('denies cross-user mutation of private records via live WebSocket stream', async () => {
      await server.server.storage.createTable('secrets', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });

      const clientAlice = createClient();
      const clientBob = createClient();

      const regAlice = await clientAlice.register({
        userName: 'alice_sec',
        password: 'Password123!',
      });
      expect(regAlice).toBe(true);
      const regBob = await clientBob.register({
        userName: 'bob_sec',
        password: 'Password123!',
      });
      expect(regBob).toBe(true);

      await waitForCondition(
        () => clientAlice.authStatus === AuthStatus.SignedIn,
      );
      await waitForCondition(
        () => clientBob.authStatus === AuthStatus.SignedIn,
      );
      await waitForCondition(
        () => clientAlice.syncStatus === SyncStatus.Connected,
      );
      await waitForCondition(
        () => clientBob.syncStatus === SyncStatus.Connected,
      );

      const aliceTable = clientAlice.table<{ text: string }>('secrets');
      await aliceTable.put('sec-1', { text: 'Alice Secret' });

      await waitForCondition(async () => {
        const t = await server.server.storage.getTable('secrets');
        const r = await t?.getRecord(User.Admin, 'sec-1');
        return r?.userName === 'alice_sec';
      });

      // Bob's client attempts to update Alice's record
      const bobTable = clientBob.table<{ text: string }>('secrets');
      await bobTable.put('sec-1', { text: 'Bob Tampering' });

      // Alice's data remains unmodified on server & client
      await new Promise((r) => setTimeout(r, 200));
      const recordOnServer = await (
        await server.server.storage.getTable('secrets')
      )?.getRecord(User.Admin, 'sec-1');
      expect(recordOnServer?.data).toEqual({ text: 'Alice Secret' });
      expect(recordOnServer?.userName).toBe('alice_sec');
    });

    it('enforces tombstone resurrection ownership through live client sync', async () => {
      await server.server.storage.createTable('shared_tasks', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Authenticated,
          update: Permission.Owner,
          delete: Permission.Owner,
        },
      });

      const clientAlice = createClient();
      const clientBob = createClient();

      await clientAlice.register({
        userName: 'alice_res',
        password: 'Password123!',
      });
      await clientBob.register({
        userName: 'bob_res',
        password: 'Password123!',
      });

      await waitForCondition(
        () => clientAlice.authStatus === AuthStatus.SignedIn,
      );
      await waitForCondition(
        () => clientBob.authStatus === AuthStatus.SignedIn,
      );
      await waitForCondition(
        () => clientAlice.syncStatus === SyncStatus.Connected,
      );
      await waitForCondition(
        () => clientBob.syncStatus === SyncStatus.Connected,
      );

      const aliceTable = clientAlice.table<{ title: string }>('shared_tasks');
      const bobTable = clientBob.table<{ title: string }>('shared_tasks');

      // 1. Alice creates task-1
      await aliceTable.put('task-1', { title: 'Original' });
      await waitForCondition(async () => {
        const r = await (
          await server.server.storage.getTable('shared_tasks')
        )?.getRecord(User.Admin, 'task-1');
        return r?.userName === 'alice_res';
      });

      // 2. Alice deletes task-1
      await aliceTable.delete('task-1');
      await waitForCondition(async () => {
        const r = await (
          await server.server.storage.getTable('shared_tasks')
        )?.getRecord(User.Admin, 'task-1');
        return r === undefined;
      });

      // 3. Bob resurrects task-1
      await bobTable.put('task-1', { title: 'Resurrected by Bob' });
      await waitForCondition(async () => {
        const r = await (
          await server.server.storage.getTable('shared_tasks')
        )?.getRecord(User.Admin, 'task-1');
        return r?.userName === 'bob_res';
      });

      // 4. Bob successfully updates task-1
      await bobTable.put('task-1', { title: 'Bob Update 2' });
      await waitForCondition(async () => {
        const r = await (
          await server.server.storage.getTable('shared_tasks')
        )?.getRecord(User.Admin, 'task-1');
        return (r?.data as { title: string })?.title === 'Bob Update 2';
      });
    });

    it('terminates raw malicious WebSocket connections exceeding queue memory buffer', async () => {
      const ws = await createRawWebSocket();
      const closePromise = new Promise<boolean>((resolve) => {
        ws.on('close', () => resolve(true));
      });

      // Flood large payload exceeding 10MB memory threshold
      const oversizedPayload = JSON.stringify({
        type: ClientMessageType.Ping,
        padding: 'A'.repeat(11 * 1024 * 1024),
      });

      ws.send(oversizedPayload);
      const isClosed = await Promise.race([
        closePromise,
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ]);

      expect(isClosed).toBe(true);
    });

    it('rejects raw frames attempting client ID spoofing and preserves connection integrity', async () => {
      await server.server.storage.createTable('spoof_test', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });

      const ws = await createRawWebSocket();

      // Authenticate with genuine clientId
      ws.send(
        JSON.stringify({
          type: ClientMessageType.Auth,
          protocolVersion: PROTOCOL_VERSION,
          clientId: 'genuine_client_connection',
        }),
      );

      // Send ChangeBatch attempting to spoof change.clientId
      ws.send(
        JSON.stringify({
          type: ClientMessageType.ChangeBatch,
          batchId: 'b-spoof',
          changes: [
            {
              table: 'spoof_test',
              id: 'rec-spoof-1',
              op: OperationType.Put,
              clientId: 'spoofed_identity_attempt',
              data: { status: 'tested' },
              timestamp: 1000,
            },
          ],
        }),
      );

      await waitForCondition(async () => {
        const t = await server.server.storage.getTable('spoof_test');
        const r = await t?.getRecord(User.Admin, 'rec-spoof-1');
        return r !== undefined;
      });

      const table = await server.server.storage.getTable('spoof_test');
      const record = await table?.getRecord(User.Admin, 'rec-spoof-1');
      expect(record?.clientId).toBe('genuine_client_connection');
    });
  },
);
