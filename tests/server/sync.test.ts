import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RateLimiter } from '../../src/server/shared/rate-limiter.js';
import type { Storage } from '../../src/server/storage/storage.js';
import { Sync } from '../../src/server/sync.js';
import {
  ClientMessageType,
  OperationType,
  Permission,
  PROTOCOL_VERSION,
  PUBLIC_READ_PERMISSIONS,
  PUBLIC_READ_WRITE_PERMISSIONS,
  type ServerMessage,
  ServerMessageType,
  USER_PRIVATE_PERMISSIONS,
} from '../../src/shared/types.js';
import { type StorageContext, storageDescriptors } from './storage/matrix.js';

class MockServerWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  sentMessages: string[] = [];
  isClosed = false;

  send(data: string): void {
    this.sentMessages.push(data);
    this.emit('sent', data);
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.isClosed = true;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  async waitForMessages(count = 1, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (this.sentMessages.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout waiting for ${count} messages (got ${this.sentMessages.length})`,
        );
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  async waitForClose(timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!this.isClosed) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timeout waiting for websocket close');
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  // Helper to send message from client to server
  emitClientMessage(msg: unknown): void {
    const payload =
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string }).type === ClientMessageType.Auth &&
      !('protocolVersion' in msg)
        ? { protocolVersion: PROTOCOL_VERSION, ...(msg as object) }
        : msg;
    this.emit(
      'message',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    );
  }

  getParsedMessages<T = ServerMessage>(): T[] {
    return this.sentMessages.map((raw) => JSON.parse(raw) as T);
  }
}

async function connectAndAuth(
  sync: Sync,
  token: string,
  options: {
    clientId?: string;
    lastSyncSeq?: number;
    expectedMessages?: number;
  } = {},
): Promise<{ ws: MockServerWebSocket; messages: ServerMessage[] }> {
  const ws = new MockServerWebSocket();
  sync.handleConnection(ws as unknown as WebSocket);
  ws.emitClientMessage({
    type: ClientMessageType.Auth,
    token,
    clientId: options.clientId ?? 'client-1',
    lastSyncSeq: options.lastSyncSeq ?? 0,
  });
  await ws.waitForMessages(options.expectedMessages ?? 2);
  return { ws, messages: ws.getParsedMessages() };
}

describe.each(storageDescriptors)('Sync ($name)', ({ createBackend }) => {
  let context: StorageContext;
  let storage: Storage;
  let sync: Sync;
  let validToken: string;
  let testUserId: string;

  beforeEach(async () => {
    context = await createBackend();
    storage = context.storage;
    sync = new Sync(storage);

    await storage.createTable('todos');
    await storage.createTable('notes');

    const user = await storage.createUser('alice', 'password123');
    testUserId = user.userId;
    validToken = await user.createToken();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  describe('Authentication Handshake (ClientMessageType.Auth)', () => {
    it('should reject connection if protocolVersion is unsupported', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        protocolVersion: 99,
        token: validToken,
      });

      await ws.waitForMessages(1);

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe(ServerMessageType.AuthError);
      if (messages[0].type === ServerMessageType.AuthError) {
        expect(messages[0].message).toContain('Unsupported protocol version');
      }
      expect(ws.isClosed).toBe(true);
    });

    it('should allow guest connection when token is omitted', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'guest-1',
        lastSyncSeq: 0,
      });

      await ws.waitForMessages(2);

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe(ServerMessageType.AuthSuccess);
      if (messages[0].type === ServerMessageType.AuthSuccess) {
        expect(messages[0].userName).toBeUndefined();
      }
    });

    it('should reject connection if token is invalid or expired', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: 'invalid-token-xyz',
      });

      await ws.waitForMessages(1);

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Invalid or expired authentication token',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should successfully authenticate and return AuthSuccess + initial snapshot for seq 0', async () => {
      const { messages } = await connectAndAuth(sync, validToken);
      expect(messages).toHaveLength(2);

      // 1. AuthSuccess
      expect(messages[0].type).toBe(ServerMessageType.AuthSuccess);
      if (messages[0].type === ServerMessageType.AuthSuccess) {
        expect(messages[0].userName).toBe('alice');
        expect(messages[0].currentSeq).toBe(0);
        expect(messages[0].token).toBeDefined();
      }

      // 2. SyncSnapshot
      expect(messages[1].type).toBe(ServerMessageType.SyncSnapshot);
      if (messages[1].type === ServerMessageType.SyncSnapshot) {
        expect(messages[1].seq).toBe(0);
        expect(messages[1].snapshot).toEqual([]);
      }
    });
  });

  describe('Snapshot and Diff Synchronization', () => {
    it('should deliver full snapshot when lastSyncSeq is 0', async () => {
      const user = await storage.getUserByToken(validToken);
      expect(user).toBeDefined();
      if (!user) return;

      await storage.applyChanges(user, [
        {
          table: 'todos',
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Item 1' },
          timestamp: 100,
          clientId: 'client-0',
        },
      ]);

      const { messages } = await connectAndAuth(sync, validToken);
      expect(messages).toHaveLength(2);
      expect(messages[1].type).toBe(ServerMessageType.SyncSnapshot);
      if (messages[1].type === ServerMessageType.SyncSnapshot) {
        expect(messages[1].snapshot).toHaveLength(1);
        expect(messages[1].snapshot[0].id).toBe('t1');
      }
    });

    it('should deliver delta diff when client is behind by <= 50 changes', async () => {
      const user = await storage.getUserByToken(validToken);
      expect(user).toBeDefined();
      if (!user) return;

      await storage.applyChanges(user, [
        {
          table: 'todos',
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Item 1' },
          timestamp: 100,
          clientId: 'client-0',
        },
        {
          table: 'todos',
          id: 't2',
          op: OperationType.Put,
          data: { text: 'Item 2' },
          timestamp: 101,
          clientId: 'client-0',
        },
      ]);

      const { messages } = await connectAndAuth(sync, validToken, {
        lastSyncSeq: 1,
      });
      expect(messages).toHaveLength(2);
      expect(messages[1].type).toBe(ServerMessageType.SyncDiff);
      if (messages[1].type === ServerMessageType.SyncDiff) {
        expect(messages[1].fromSeq).toBe(1);
        expect(messages[1].toSeq).toBe(2);
        expect(messages[1].changes).toHaveLength(1);
        expect(messages[1].changes[0].id).toBe('t2');
      }
    });

    it('should deliver delta diff even when diff exceeds 50 changes if changelog is intact', async () => {
      const user = await storage.getUserByToken(validToken);
      expect(user).toBeDefined();
      if (!user) return;

      const changes = [];
      for (let i = 1; i <= 55; i++) {
        changes.push({
          table: 'todos',
          id: `t-${i}`,
          op: OperationType.Put,
          data: { text: `Item ${i}` },
          timestamp: 100 + i,
          clientId: 'client-0',
        });
      }
      await storage.applyChanges(user, changes);

      // Client connecting with seq 1 (> 50 changes diff, but changelog retained)
      const { messages } = await connectAndAuth(sync, validToken, {
        lastSyncSeq: 1,
      });
      expect(messages).toHaveLength(2);
      expect(messages[1].type).toBe(ServerMessageType.SyncDiff);
      if (messages[1].type === ServerMessageType.SyncDiff) {
        expect(messages[1].changes).toHaveLength(54);
        expect(messages[1].fromSeq).toBe(1);
        expect(messages[1].toSeq).toBe(55);
      }
    });
  });

  describe('Change Ingestion & Real-Time Broadcasting (ClientMessageType.ChangeBatch)', () => {
    it('should reject ChangeBatch when client writes to private table without auth', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'c1',
        lastSyncSeq: 0,
      });
      await ws.waitForMessages(2);

      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'c1',
        batchId: 'b1',
        changes: [
          {
            table: 'todos',
            id: 'item-1',
            op: OperationType.Put,
            data: { title: 'Todo' },
            timestamp: Date.now(),
            clientId: 'c1',
          },
        ],
      });
      await ws.waitForMessages(3);

      const messages = ws.getParsedMessages();
      const errMsg = messages.find((m) => m.type === ServerMessageType.Error);
      expect(errMsg).toBeDefined();
    });

    it('should apply changes, send ChangeAck to sender, and broadcast to other clients of the same user', async () => {
      // Client 1 (Sender)
      const ws1 = new MockServerWebSocket();
      sync.handleConnection(ws1 as unknown as WebSocket);
      ws1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-1',
        lastSyncSeq: 0,
      });

      // Client 2 (Receiver - same user)
      const ws2 = new MockServerWebSocket();
      sync.handleConnection(ws2 as unknown as WebSocket);
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-2',
        lastSyncSeq: 0,
      });

      await ws1.waitForMessages(2);
      await ws2.waitForMessages(2);

      // Client 1 sends changes
      ws1.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'client-1',
        batchId: 'batch-abc',
        changes: [
          {
            table: 'todos',
            id: 'item-1',
            op: OperationType.Put,
            data: { title: 'Sync Todo' },
            timestamp: Date.now(),
            clientId: 'client-1',
          },
        ],
      });

      await ws1.waitForMessages(3);
      await ws2.waitForMessages(3);

      // ws1 should receive ChangeAck
      const ws1Messages = ws1.getParsedMessages();
      const ackMsg = ws1Messages.find(
        (m) => m.type === ServerMessageType.ChangeAck,
      );
      expect(ackMsg).toBeDefined();
      if (ackMsg && ackMsg.type === ServerMessageType.ChangeAck) {
        expect(ackMsg.batchId).toBe('batch-abc');
        expect(ackMsg.appliedSeq).toBe(1);
      }

      // ws2 should receive BroadcastChanges
      const ws2Messages = ws2.getParsedMessages();
      const broadcastMsg = ws2Messages.find(
        (m) => m.type === ServerMessageType.BroadcastChanges,
      );
      expect(broadcastMsg).toBeDefined();
      if (
        broadcastMsg &&
        broadcastMsg.type === ServerMessageType.BroadcastChanges
      ) {
        expect(broadcastMsg.fromClientId).toBe('client-1');
        expect(broadcastMsg.changes).toHaveLength(1);
        expect(broadcastMsg.changes[0].id).toBe('item-1');
        expect(broadcastMsg.seq).toBe(1);
      }
    });

    it('should not broadcast changes on owner-restricted tables to other users or guests', async () => {
      // User 2 (Bob)
      const bob = await storage.createUser('bob', 'password123');
      const bobToken = await bob.createToken();

      // Client 1 (Alice - Sender)
      const wsAlice = new MockServerWebSocket();
      sync.handleConnection(wsAlice as unknown as WebSocket);
      wsAlice.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'alice-client',
        lastSyncSeq: 0,
      });

      // Client 2 (Bob - Different user)
      const wsBob = new MockServerWebSocket();
      sync.handleConnection(wsBob as unknown as WebSocket);
      wsBob.emitClientMessage({
        type: ClientMessageType.Auth,
        token: bobToken,
        clientId: 'bob-client',
        lastSyncSeq: 0,
      });

      // Client 3 (Guest - Unauthenticated)
      const wsGuest = new MockServerWebSocket();
      sync.handleConnection(wsGuest as unknown as WebSocket);
      wsGuest.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'guest-client',
        lastSyncSeq: 0,
      });

      await wsAlice.waitForMessages(2);
      await wsBob.waitForMessages(2);
      await wsGuest.waitForMessages(2);

      // Alice sends changes to private table 'todos' (default USER_PRIVATE_PERMISSIONS)
      wsAlice.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'alice-client',
        batchId: 'batch-private',
        changes: [
          {
            table: 'todos',
            id: 'alice-secret-item',
            op: OperationType.Put,
            data: { secret: 'Alice Only' },
            timestamp: Date.now(),
            clientId: 'alice-client',
          },
        ],
      });

      await wsAlice.waitForMessages(3);
      // Wait a short tick to ensure no messages were dispatched to Bob or Guest
      await new Promise((r) => setTimeout(r, 20));

      const bobBroadcasts = wsBob
        .getParsedMessages()
        .filter((m) => m.type === ServerMessageType.BroadcastChanges);
      expect(bobBroadcasts).toHaveLength(0);

      const guestBroadcasts = wsGuest
        .getParsedMessages()
        .filter((m) => m.type === ServerMessageType.BroadcastChanges);
      expect(guestBroadcasts).toHaveLength(0);
    });

    it('should reject ChangeBatch when changes is not an array', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-1',
        lastSyncSeq: 0,
      });
      await ws.waitForMessages(2);

      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'client-1',
        batchId: 'b1',
        changes: 'not-an-array',
      });
      await ws.waitForMessages(3);

      const messages = ws.getParsedMessages();
      const errMsg = messages.find((m) => m.type === ServerMessageType.Error);
      expect(errMsg).toBeDefined();
      expect(errMsg?.type).toBe(ServerMessageType.Error);
    });
  });

  describe('Ping & Error Handling', () => {
    it('should respond to Ping with Pong', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({ type: ClientMessageType.Ping });
      await ws.waitForMessages(1);

      const messages = ws.getParsedMessages();
      expect(messages).toEqual([{ type: ServerMessageType.Pong }]);
    });

    it('should handle malformed JSON and unsupported message types', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // 1. Invalid JSON
      ws.emit('message', '{ invalid');
      await ws.waitForMessages(1);

      // 2. Unsupported message type
      ws.emitClientMessage({ type: 'UNKNOWN_OP' });
      await ws.waitForMessages(2);

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe(ServerMessageType.Error);
      expect(messages[1].type).toBe(ServerMessageType.Error);
    });

    it('should clean up client on disconnect or socket error', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-disconnect',
        lastSyncSeq: 0,
      });
      await ws.waitForMessages(2);

      // Emit error then close
      ws.emit('error', new Error('Network reset'));
      ws.close();

      // @ts-expect-error - inspecting internal map
      expect(sync.webSocketToClient.has(ws)).toBe(false);
    });

    it('should send error if table is deleted when client sends change batch', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-table-del',
        lastSyncSeq: 0,
      });
      await ws.waitForMessages(2);

      // Now delete the table
      const todosTable = await storage.getTable('todos');
      await todosTable?.delete();

      // Send change batch
      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b-del',
        changes: [
          {
            table: 'todos',
            id: 't-del',
            op: OperationType.Put,
            data: { test: 1 },
            timestamp: 100,
          },
        ],
      });
      await ws.waitForMessages(3);

      const messages = ws.getParsedMessages();
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.type).toBe(ServerMessageType.Error);
      expect((lastMsg as { message: string }).message).toContain(
        'Table "todos" not found',
      );
    });
  });

  describe('Sync Rate Limiting & Resource Protection', () => {
    it('should enforce connection rate limits per IP', async () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
      const limitedSync = new Sync(storage, { rateLimiter: limiter });

      const ws1 = new MockServerWebSocket();
      limitedSync.handleConnection(
        ws1 as unknown as WebSocket,
        '192.168.1.100',
      );
      expect(ws1.isClosed).toBe(false);

      const ws2 = new MockServerWebSocket();
      limitedSync.handleConnection(
        ws2 as unknown as WebSocket,
        '192.168.1.100',
      );
      expect(ws2.isClosed).toBe(false);

      // 3rd connection exceeds maxRequests=2
      const ws3 = new MockServerWebSocket();
      limitedSync.handleConnection(
        ws3 as unknown as WebSocket,
        '192.168.1.100',
      );
      expect(ws3.isClosed).toBe(true);
      const messages = ws3.getParsedMessages();
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Too many connection attempts',
      });

      // Different IP should still connect
      const wsOther = new MockServerWebSocket();
      limitedSync.handleConnection(
        wsOther as unknown as WebSocket,
        '192.168.1.200',
      );
      expect(wsOther.isClosed).toBe(false);
    });

    it('should apply progressive backoff on repeated invalid tokens', async () => {
      const limiter = new RateLimiter({
        maxFailures: 2,
        initialBackoffMs: 2_000,
        windowMs: 60_000,
      });
      const limitedSync = new Sync(storage, { rateLimiter: limiter });

      // 1st failed token
      const ws1 = new MockServerWebSocket();
      limitedSync.handleConnection(ws1 as unknown as WebSocket, '10.0.0.1');
      ws1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: 'bad-token-1',
      });
      await ws1.waitForClose();
      expect(ws1.isClosed).toBe(true);

      // 2nd failed token -> triggers backoff
      const ws2 = new MockServerWebSocket();
      limitedSync.handleConnection(ws2 as unknown as WebSocket, '10.0.0.1');
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: 'bad-token-2',
      });
      await ws2.waitForClose();
      expect(ws2.isClosed).toBe(true);

      // 3rd connection during cooldown is rejected on connect
      const ws3 = new MockServerWebSocket();
      limitedSync.handleConnection(ws3 as unknown as WebSocket, '10.0.0.1');
      expect(ws3.isClosed).toBe(true);
      const msgs = ws3.getParsedMessages();
      expect((msgs[0] as { message: string }).message).toContain(
        'Too many connection attempts',
      );
    });

    it('should enforce maxConcurrentConnectionsPerUser limit', async () => {
      const cappedSync = new Sync(storage, {
        maxConcurrentConnectionsPerUser: 2,
      });

      // Client 1 connects & auths
      const ws1 = new MockServerWebSocket();
      cappedSync.handleConnection(ws1 as unknown as WebSocket);
      ws1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'c1',
      });
      await ws1.waitForMessages(2);
      expect(cappedSync.connectedClientsCount).toBe(1);

      // Client 2 connects & auths
      const ws2 = new MockServerWebSocket();
      cappedSync.handleConnection(ws2 as unknown as WebSocket);
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'c2',
      });
      await ws2.waitForMessages(2);
      expect(cappedSync.connectedClientsCount).toBe(2);

      // Client 3 exceeds maxConcurrentConnectionsPerUser=2
      const ws3 = new MockServerWebSocket();
      cappedSync.handleConnection(ws3 as unknown as WebSocket);
      ws3.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'c3',
      });
      await ws3.waitForClose();

      expect(ws3.isClosed).toBe(true);
      const msgs = ws3.getParsedMessages();
      expect((msgs[0] as { message: string }).message).toContain(
        'Maximum concurrent connections exceeded',
      );
      expect(cappedSync.connectedClientsCount).toBe(2);

      // After client 1 disconnects, client 3 can connect
      ws1.close();
      await ws1.waitForClose();
      expect(cappedSync.connectedClientsCount).toBe(1);

      const ws4 = new MockServerWebSocket();
      cappedSync.handleConnection(ws4 as unknown as WebSocket);
      ws4.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'c4',
      });
      await ws4.waitForMessages(2);
      expect(cappedSync.connectedClientsCount).toBe(2);
      expect(ws4.isClosed).toBe(false);
    });

    it('should terminate unauthenticated connections on authTimeoutMs', async () => {
      const fastTimeoutSync = new Sync(storage, {
        authTimeoutMs: 50,
      });

      const ws = new MockServerWebSocket();
      fastTimeoutSync.handleConnection(ws as unknown as WebSocket);
      expect(ws.isClosed).toBe(false);

      // Wait past timeout (50ms)
      await new Promise((r) => setTimeout(r, 70));
      expect(ws.isClosed).toBe(true);
      const msgs = ws.getParsedMessages();
      expect((msgs[0] as { message: string }).message).toContain(
        'Authentication timeout',
      );
    });

    it('should clean up old user subscriptions when re-authenticating with a different user', async () => {
      const user2 = await storage.createUser('user-two', 'Password123!');
      const token2 = await user2.createToken();

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // 1. Authenticate as user 1
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-reauth',
      });
      await ws.waitForMessages(2);

      // 2. Re-authenticate same socket as user 2
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: token2,
        clientId: 'client-reauth',
      });
      await ws.waitForMessages(4);

      // Clear message buffer
      ws.sentMessages = [];

      // 3. User 1 performs a mutation from another client
      const wsUser1 = new MockServerWebSocket();
      sync.handleConnection(wsUser1 as unknown as WebSocket);
      wsUser1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        clientId: 'client-other',
      });
      await wsUser1.waitForMessages(2);

      wsUser1.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'batch-1',
        changes: [
          {
            table: 'todos',
            id: 'todo-secret',
            op: OperationType.Put,
            clientId: 'client-other',
            data: { title: 'User 1 Secret' },
            timestamp: Date.now(),
          },
        ],
      });
      await wsUser1.waitForMessages(3);

      // 4. Verify that ws (now authenticated as user 2) did not receive user 1's broadcast
      const reauthMsgs = ws.getParsedMessages();
      const broadcastMsgs = reauthMsgs.filter(
        (m) => m.type === ServerMessageType.BroadcastChanges,
      );
      expect(broadcastMsgs).toHaveLength(0);
    });

    it('should deliver full snapshot when lastSyncSeq is older than pruned changelog', async () => {
      const table = await storage.getTable('todos');
      const user = await storage.getUser(testUserId);
      if (!table || !user) throw new Error('Setup missing');

      for (let i = 1; i <= 6; i++) {
        await table.applyChanges(user, [
          {
            table: 'todos',
            id: `item-${i}`,
            op: OperationType.Put,
            data: { title: `Item ${i}` },
            timestamp: 1000 + i,
            clientId: 'c1',
          },
        ]);
      }

      // Prune to keep only last 2 changes
      await storage.prune(2);

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // Connect with lastSyncSeq: 1 (which was pruned)
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        token: validToken,
        clientId: 'client-pruned',
        lastSyncSeq: 1,
      });
      await ws.waitForMessages(2);

      const msgs = ws.getParsedMessages();
      const snapshotMsg = msgs.find(
        (m) => m.type === ServerMessageType.SyncSnapshot,
      );
      expect(snapshotMsg).toBeDefined();
    });

    it('should throttle distributed login attempts targeting the same account across different IPs', async () => {
      const userLimiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 2,
      });

      const limitedSync = new Sync(storage, {
        userLoginLimiter: userLimiter,
      });

      const ws1 = new MockServerWebSocket();
      const ws2 = new MockServerWebSocket();
      const ws3 = new MockServerWebSocket();

      limitedSync.handleConnection(ws1 as unknown as WebSocket, '1.1.1.1');
      limitedSync.handleConnection(ws2 as unknown as WebSocket, '2.2.2.2');
      limitedSync.handleConnection(ws3 as unknown as WebSocket, '3.3.3.3');

      // Attempt 1: from IP 1.1.1.1 targeting alice
      ws1.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'alice',
        password: 'wrong_password_1',
      });
      await ws1.waitForMessages(1);

      // Attempt 2: from IP 2.2.2.2 targeting Alice with different casing
      ws2.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'Alice',
        password: 'wrong_password_2',
      });
      await ws2.waitForMessages(1);

      // Attempt 3: from IP 3.3.3.3 targeting ALICE (exceeds maxRequests: 2 for the account)
      ws3.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'ALICE',
        password: 'wrong_password_3',
      });
      await ws3.waitForMessages(1);

      const msg3 = ws3.getParsedMessages()[0];
      expect(msg3.type).toBe(ServerMessageType.AuthError);
      expect(msg3.message).toMatch(/Too many login attempts for this account/);
    });

    it('attributes mutations to the original author in broadcasts and delta syncs rather than the recipient', async () => {
      const userAlice = await storage.getUser(testUserId);
      expect(userAlice).toBeDefined();
      const userBob = await storage.createUser('bob_feed', 'password123');
      await storage.createTable('shared_feed', {
        permissions: PUBLIC_READ_WRITE_PERMISSIONS,
      });

      const tokenAlice = validToken;
      const tokenBob = await userBob.createToken();

      const { ws: wsAlice } = await connectAndAuth(sync, tokenAlice, {
        clientId: 'client-alice',
      });
      const { ws: wsBob } = await connectAndAuth(sync, tokenBob, {
        clientId: 'client-bob',
      });

      // Alice sends a change batch
      wsAlice.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'batch-1',
        changes: [
          {
            table: 'shared_feed',
            id: 'post-1',
            op: OperationType.Put,
            data: { message: 'Hello from Alice' },
            timestamp: Date.now(),
          },
        ],
      });

      // Alice sends a second change batch
      wsAlice.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'batch-2',
        changes: [
          {
            table: 'shared_feed',
            id: 'post-2',
            op: OperationType.Put,
            data: { message: 'Second message from Alice' },
            timestamp: Date.now(),
          },
        ],
      });

      await wsBob.waitForMessages(4); // 2 auth + 2 broadcasts
      const bobMessages = wsBob.getParsedMessages();
      const broadcastMsgs = bobMessages.filter(
        (m) => m.type === ServerMessageType.BroadcastChanges,
      );
      expect(broadcastMsgs).toHaveLength(2);
      if (broadcastMsgs[0].type === ServerMessageType.BroadcastChanges) {
        expect(broadcastMsgs[0].changes[0].userName).toBe('alice');
        expect(broadcastMsgs[0].changes[0].userName).not.toBe('bob_feed');
      }

      // Now Bob reconnects and requests a delta diff from seq 1
      const wsBobReconnect = new MockServerWebSocket();
      sync.handleConnection(wsBobReconnect as unknown as WebSocket);
      wsBobReconnect.emitClientMessage({
        type: ClientMessageType.Auth,
        token: tokenBob,
        clientId: 'client-bob-2',
        lastSyncSeq: 1,
      });

      await wsBobReconnect.waitForMessages(2);
      const reconnectMessages = wsBobReconnect.getParsedMessages();
      const diffMsg = reconnectMessages.find(
        (m) => m.type === ServerMessageType.SyncDiff,
      );
      expect(diffMsg).toBeDefined();
      if (diffMsg && diffMsg.type === ServerMessageType.SyncDiff) {
        expect(diffMsg.changes[0].userName).toBe('alice');
        expect(diffMsg.changes[0].userName).not.toBe('bob_feed');
      }
    });

    it('generates cryptographically secure hexadecimal client IDs when logging in without prior auth', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'alice',
        password: 'password123',
      });

      await ws.waitForMessages(2);
      const messages = ws.getParsedMessages();
      expect(messages[0].type).toBe(ServerMessageType.AuthSuccess);

      const client = (
        sync as unknown as {
          webSocketToClient: Map<unknown, { clientId: string }>;
        }
      ).webSocketToClient.get(ws);
      expect(client).toBeDefined();
      expect(client?.clientId).toMatch(/^client_[0-9a-f]{8}$/);
    });

    it('enforces IP rate limiting and failure tracking on invalid token login attempts', async () => {
      const ipLimiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 2,
        maxFailures: 2,
      });

      const limitedSync = new Sync(storage, {
        ipLoginLimiter: ipLimiter,
      });

      const ws = new MockServerWebSocket();
      limitedSync.handleConnection(ws as unknown as WebSocket, '192.168.1.50');

      // Attempt 1: Invalid token
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        token: 'invalid.token.attempt1',
      });
      await ws.waitForMessages(1);
      const msg1 = ws.getParsedMessages()[0];
      expect(msg1.type).toBe(ServerMessageType.AuthError);
      expect(msg1.message).toMatch(/Invalid or expired authentication token/);

      // Attempt 2: Invalid token (reaches maxRequests and maxFailures)
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        token: 'invalid.token.attempt2',
      });
      await ws.waitForMessages(2);
      const msg2 = ws.getParsedMessages()[1];
      expect(msg2.type).toBe(ServerMessageType.AuthError);
      expect(msg2.message).toMatch(/Invalid or expired authentication token/);

      // Attempt 3: Exceeds rate limit
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        token: 'invalid.token.attempt3',
      });
      await ws.waitForMessages(3);
      const msg3 = ws.getParsedMessages()[2];
      expect(msg3.type).toBe(ServerMessageType.AuthError);
      expect(msg3.message).toMatch(/Too many login attempts/);
    });

    it('should not reset IP login failure counters when authenticating with a token', async () => {
      const ipLimiter = new RateLimiter({
        windowMs: 60_000,
        maxRequests: 10,
        maxFailures: 2,
        initialBackoffMs: 5_000,
      });

      const limitedSync = new Sync(storage, {
        ipLoginLimiter: ipLimiter,
      });

      const ws = new MockServerWebSocket();
      limitedSync.handleConnection(ws as unknown as WebSocket, '192.168.1.99');

      // 2 failed password attempts -> triggers failure lockout on IP
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'alice',
        password: 'wrong_password_1',
      });
      await ws.waitForMessages(1);

      ws.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'alice',
        password: 'wrong_password_2',
      });
      await ws.waitForMessages(2);

      // Authenticate with valid token on the same IP
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        token: validToken,
      });
      await ws.waitForMessages(3);

      // Attempt another password login from the same IP -> should remain blocked by IP failure cooldown
      ws.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'alice',
        password: 'password123',
      });
      await ws.waitForMessages(4);

      const msgs = ws.getParsedMessages();
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg.type).toBe(ServerMessageType.AuthError);
      expect((lastMsg as { message: string }).message).toMatch(
        /Too many login attempts/,
      );
    });

    it('should terminate connection when pending message queue exceeds maximum capacity', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // Flood 1100 messages synchronously exceeding maxPendingMessages (1000)
      for (let i = 0; i < 1100; i++) {
        ws.emitClientMessage({ type: ClientMessageType.Ping });
      }

      await ws.waitForClose();
      expect(ws.isClosed).toBe(true);
      const messages = ws.getParsedMessages();
      const errorMsg = messages.find(
        (m) =>
          m.type === ServerMessageType.Error &&
          (m as { message: string }).message.includes(
            'Message queue limit exceeded',
          ),
      );
      expect(errorMsg).toBeDefined();
    });

    it('should reject change batch if unauthenticated or if batch exceeds size limit', async () => {
      const wsUnauth = new MockServerWebSocket();
      sync.handleConnection(wsUnauth as unknown as WebSocket);
      wsUnauth.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b1',
        changes: [
          {
            table: 'items',
            id: '1',
            op: OperationType.Put,
            data: 'val',
            timestamp: 100,
          },
        ],
      });
      await wsUnauth.waitForMessages(1);
      const unauthMsgs = wsUnauth.getParsedMessages();
      expect(unauthMsgs[0].type).toBe(ServerMessageType.AuthError);
    });

    it('should maintain auth timeout active across failed login attempts until valid auth or timeout', async () => {
      const shortTimeoutSync = new Sync(storage, {
        authTimeoutMs: 50,
      });
      const ws = new MockServerWebSocket();
      shortTimeoutSync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Login,
        userName: 'nonexistent',
        password: 'wrongpassword',
        requestId: 'req-1',
      });

      await ws.waitForMessages(1);
      const msgs = ws.getParsedMessages();
      expect(msgs[0].type).toBe(ServerMessageType.AuthError);

      await ws.waitForClose(500);
      expect(ws.isClosed).toBe(true);
      const timeoutMsg = ws.getParsedMessages()[1] as { message: string };
      expect(timeoutMsg.message).toBe('Authentication timeout');
    });

    it('should terminate connection when queued message byte limit is exceeded', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      const hugePayload = 'X'.repeat(11 * 1024 * 1024);
      ws.emit('message', hugePayload);

      await ws.waitForClose(1000);
      expect(ws.isClosed).toBe(true);
    });

    it('should sanitize change.clientId with authenticated connection clientId in handleChangeBatchMessage', async () => {
      const ws = new MockServerWebSocket();
      const table = await storage.createTable('audit_logs', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });

      sync.handleConnection(ws as unknown as WebSocket);
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'genuine_client_123',
      });

      await ws.waitForMessages(2);

      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'batch1',
        changes: [
          {
            table: table.name,
            id: 'log1',
            op: OperationType.Put,
            clientId: 'spoofed_client_id_zzzzz',
            data: { event: 'test' },
            timestamp: 1000,
          },
        ],
      });

      await ws.waitForMessages(3);
      const record = await table.getRecord(undefined, 'log1');
      expect(record?.clientId).toBe('genuine_client_123');
    });

    it('should broadcast changes to peer connection even when sharing the same clientId string', async () => {
      const wsA = new MockServerWebSocket();
      const wsB = new MockServerWebSocket();

      const table = await storage.createTable('shared_feed', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });

      sync.handleConnection(wsA as unknown as WebSocket);
      sync.handleConnection(wsB as unknown as WebSocket);

      wsA.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'shared_client_id_1',
      });
      wsB.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'shared_client_id_1',
      });

      await wsA.waitForMessages(2);
      await wsB.waitForMessages(2);

      wsA.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b1',
        changes: [
          {
            table: table.name,
            id: 'item1',
            op: OperationType.Put,
            data: { title: 'Broadcast test' },
            timestamp: 1000,
          },
        ],
      });

      await wsA.waitForMessages(3);
      await wsB.waitForMessages(3);
      const broadcastMsg = wsB.getParsedMessages()[2] as {
        type: ServerMessageType;
        changes: Array<{ id: string }>;
      };
      expect(broadcastMsg.type).toBe(ServerMessageType.BroadcastChanges);
      expect(broadcastMsg.changes[0].id).toBe('item1');
    });

    it('should permit re-authentication on the same WebSocket connection when concurrency limit is 1', async () => {
      const limitedSync = new Sync(storage, {
        maxConcurrentConnectionsPerUser: 1,
      });
      const ws = new MockServerWebSocket();
      const user = await storage.createUser('alice_reauth', 'Password123!');
      const token = await user.createToken();

      limitedSync.handleConnection(ws as unknown as WebSocket);

      // 1st Auth
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token,
        clientId: 'client_1',
      });

      await ws.waitForMessages(2);
      expect(ws.getParsedMessages()[0].type).toBe(
        ServerMessageType.AuthSuccess,
      );

      // 2nd Auth on same socket (e.g. token refresh)
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token,
        clientId: 'client_1',
      });

      await ws.waitForMessages(4);
      expect(ws.getParsedMessages()[2].type).toBe(
        ServerMessageType.AuthSuccess,
      );
      expect(ws.isClosed).toBe(false);
    });

    it('should advertise accessible tables in AuthSuccess for guests and authenticated users', async () => {
      // 1. Private table (USER_PRIVATE_PERMISSIONS)
      await storage.createTable('priv_table', {
        permissions: USER_PRIVATE_PERMISSIONS,
      });
      // 2. Public readonly table
      await storage.createTable('public_ro_table', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Nobody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });
      // 3. Public read / auth write (PUBLIC_READ_PERMISSIONS)
      await storage.createTable('public_auth_table', {
        permissions: PUBLIC_READ_PERMISSIONS,
      });
      // 4. Authenticated readonly table
      await storage.createTable('auth_ro_table', {
        permissions: {
          read: Permission.Authenticated,
          create: Permission.Nobody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });
      // 5. System table (Nobody)
      await storage.createTable('system_table', {
        permissions: {
          read: Permission.Nobody,
          create: Permission.Nobody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });

      // Guest connection
      const guestWs = new MockServerWebSocket();
      sync.handleConnection(guestWs as unknown as WebSocket);
      guestWs.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'guest_probe',
      });
      await guestWs.waitForMessages(2);
      const guestAuth = guestWs.getParsedMessages()[0] as {
        type: string;
        tables?: string[];
      };
      expect(guestAuth.type).toBe(ServerMessageType.AuthSuccess);
      expect(guestAuth.tables).toBeDefined();
      expect(guestAuth.tables).toContain('public_ro_table');
      expect(guestAuth.tables).toContain('public_auth_table');
      expect(guestAuth.tables).not.toContain('priv_table');
      expect(guestAuth.tables).not.toContain('auth_ro_table');
      expect(guestAuth.tables).not.toContain('system_table');

      // Authenticated user connection
      const user = await storage.createUser('test_auth_user', 'Pass123!');
      const token = await user.createToken();
      const userWs = new MockServerWebSocket();
      sync.handleConnection(userWs as unknown as WebSocket);
      userWs.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'user_probe',
        token,
      });
      await userWs.waitForMessages(2);
      const userAuth = userWs.getParsedMessages()[0] as {
        type: string;
        tables?: string[];
      };
      expect(userAuth.type).toBe(ServerMessageType.AuthSuccess);
      expect(userAuth.tables).toBeDefined();
      expect(userAuth.tables).toContain('priv_table');
      expect(userAuth.tables).toContain('public_ro_table');
      expect(userAuth.tables).toContain('public_auth_table');
      expect(userAuth.tables).toContain('auth_ro_table');
      expect(userAuth.tables).not.toContain('system_table');
    });

    it('should reject unauthorized batches with generic Access denied and correlation batchId', async () => {
      await storage.createTable('protected_notes', {
        permissions: USER_PRIVATE_PERMISSIONS,
      });
      await storage.createTable('announcements', {
        permissions: PUBLIC_READ_PERMISSIONS,
      });

      const guestWs = new MockServerWebSocket();
      sync.handleConnection(guestWs as unknown as WebSocket);
      guestWs.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'guest_batch_tester',
      });
      await guestWs.waitForMessages(2);

      // Guest sends change to private table
      guestWs.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_priv',
        changes: [
          {
            table: 'protected_notes',
            id: 'p1',
            op: OperationType.Put,
            data: { secret: 'data' },
            timestamp: Date.now(),
          },
        ],
      });
      await guestWs.waitForMessages(3);
      const privError = guestWs.getParsedMessages()[2] as {
        type: string;
        batchId?: string;
        message: string;
      };
      expect(privError.type).toBe(ServerMessageType.Error);
      expect(privError.batchId).toBe('b_priv');
      expect(privError.message).toBe('Access denied');
      expect(privError.message).not.toContain('protected_notes');

      // Guest sends change to public-read (auth create) table
      guestWs.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_pub_read',
        changes: [
          {
            table: 'announcements',
            id: 'a1',
            op: OperationType.Put,
            data: { text: 'Spam' },
            timestamp: Date.now(),
          },
        ],
      });
      await guestWs.waitForMessages(4);
      const pubReadError = guestWs.getParsedMessages()[3] as {
        type: string;
        batchId?: string;
        message: string;
      };
      expect(pubReadError.type).toBe(ServerMessageType.Error);
      expect(pubReadError.batchId).toBe('b_pub_read');
      expect(pubReadError.message).toBe('Access denied');
    });

    it('should reject authenticated mutations to read-only tables gracefully', async () => {
      await storage.createTable('system_docs', {
        permissions: {
          read: Permission.Authenticated,
          create: Permission.Nobody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });

      const user = await storage.createUser('writer_user', 'Pass123!');
      const token = await user.createToken();
      const userWs = new MockServerWebSocket();
      sync.handleConnection(userWs as unknown as WebSocket);
      userWs.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'auth_writer',
        token,
      });
      await userWs.waitForMessages(2);

      userWs.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_ro',
        changes: [
          {
            table: 'system_docs',
            id: 'doc1',
            op: OperationType.Put,
            data: { title: 'New Doc' },
            timestamp: Date.now(),
          },
        ],
      });
      await userWs.waitForMessages(3);
      const err = userWs.getParsedMessages()[2] as {
        type: string;
        batchId?: string;
        message: string;
      };
      expect(err.type).toBe(ServerMessageType.Error);
      expect(err.batchId).toBe('b_ro');
      expect(err.message).toContain('create access');
    });

    it('should log errors when attempting to create, update, or delete records without permission via sync', async () => {
      const mockLogger = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const loggedSync = new Sync(storage, {
        logger: mockLogger,
      });

      // Table that allows read, but disallows update & delete (append-only)
      const table = await storage.createTable('append_table', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Nobody,
          delete: Permission.Nobody,
        },
      });

      const ws = new MockServerWebSocket();
      loggedSync.handleConnection(ws as unknown as WebSocket);
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        clientId: 'test_mutator',
      });
      await ws.waitForMessages(2);

      // 1. Create a record (permitted)
      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_create',
        changes: [
          {
            table: table.name,
            id: 'rec1',
            op: OperationType.Put,
            data: { val: 1 },
            timestamp: 1000,
          },
        ],
      });
      await ws.waitForMessages(3);
      expect(mockLogger.error).not.toHaveBeenCalled();

      // 2. Attempt to update the existing record (forbidden -> update: Nobody)
      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_update_fail',
        changes: [
          {
            table: table.name,
            id: 'rec1',
            op: OperationType.Put,
            data: { val: 2 },
            timestamp: 2000,
          },
        ],
      });
      await ws.waitForMessages(4);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Change batch error'),
        expect.anything(),
      );
      mockLogger.error.mockClear();

      // 3. Attempt to delete the record (forbidden -> delete: Nobody)
      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b_delete_fail',
        changes: [
          {
            table: table.name,
            id: 'rec1',
            op: OperationType.Delete,
            timestamp: 3000,
          },
        ],
      });
      await ws.waitForMessages(5);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Change batch error'),
        expect.anything(),
      );
    });
  });
});
