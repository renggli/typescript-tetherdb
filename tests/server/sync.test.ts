import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RateLimiter } from '../../src/server/rate-limiter.js';
import type { Storage } from '../../src/server/storage/index.js';
import { Sync } from '../../src/server/sync.js';
import {
  ClientMessageType,
  OperationType,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageType,
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
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.isClosed = true;
    this.emit('close');
  }

  terminate(): void {
    this.close();
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

    const app = await storage.createApp('todo-app');
    await app.createTable('todos');
    await app.createTable('notes');

    const user = await storage.createUser('alice', 'password123');
    testUserId = user.id;
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
        appId: 'todo-app',
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe(ServerMessageType.AuthError);
      if (messages[0].type === ServerMessageType.AuthError) {
        expect(messages[0].message).toContain('Unsupported protocol version');
      }
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if token is missing or empty', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: '',
        appId: 'todo-app',
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Missing or invalid authentication token',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if token is invalid or expired', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: 'invalid-token-xyz',
        appId: 'todo-app',
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Invalid or expired authentication token',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if appId is missing or empty', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: '',
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Missing required field: appId',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if application does not exist', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'non-existent-app',
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Application not found',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should successfully authenticate and return AuthSuccess + initial snapshot for seq 0', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(2);

      // 1. AuthSuccess
      expect(messages[0].type).toBe(ServerMessageType.AuthSuccess);
      if (messages[0].type === ServerMessageType.AuthSuccess) {
        expect(messages[0].userId).toBe(testUserId);
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

      const app = await storage.getApp('todo-app');
      await app?.applyChanges(user, [
        {
          table: 'todos',
          id: 't1',
          op: OperationType.Put,
          data: { text: 'Item 1' },
          timestamp: 100,
          clientId: 'client-0',
        },
      ]);

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
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

      const app = await storage.getApp('todo-app');
      await app?.applyChanges(user, [
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

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 1,
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
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

      const app = await storage.getApp('todo-app');
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
      await app?.applyChanges(user, changes);

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // Client connecting with seq 1 (> 50 changes diff, but changelog retained)
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 1,
      });

      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
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
    it('should reject ChangeBatch when client is not authenticated', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'c1',
        batchId: 'b1',
        changes: [],
      });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Not authenticated',
      });
    });

    it('should apply changes, send ChangeAck to sender, and broadcast to other clients of the same app and user', async () => {
      // Client 1 (Sender)
      const ws1 = new MockServerWebSocket();
      sync.handleConnection(ws1 as unknown as WebSocket);
      ws1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });

      // Client 2 (Receiver - same app, same user)
      const ws2 = new MockServerWebSocket();
      sync.handleConnection(ws2 as unknown as WebSocket);
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-2',
        lastSyncSeq: 0,
      });

      await new Promise((r) => setTimeout(r, 20));

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

      await new Promise((r) => setTimeout(r, 25));

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

    it('should reject ChangeBatch when changes is not an array', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      ws.emitClientMessage({
        type: ClientMessageType.ChangeBatch,
        clientId: 'client-1',
        batchId: 'b1',
        changes: 'not-an-array',
      });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      const errMsg = messages.find((m) => m.type === ServerMessageType.Error);
      expect(errMsg).toBeDefined();
      expect(errMsg?.type).toBe(ServerMessageType.Error);

      consoleSpy.mockRestore();
    });
  });

  describe('Ping & Error Handling', () => {
    it('should respond to Ping with Pong', async () => {
      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({ type: ClientMessageType.Ping });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toEqual([{ type: ServerMessageType.Pong }]);
    });

    it('should handle malformed JSON and unsupported message types', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      // 1. Invalid JSON
      ws.emit('message', '{ invalid');
      await new Promise((r) => setTimeout(r, 20));

      // 2. Unsupported message type
      ws.emitClientMessage({ type: 'UNKNOWN_OP' });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe(ServerMessageType.Error);
      expect(messages[1].type).toBe(ServerMessageType.Error);

      consoleSpy.mockRestore();
    });

    it('should clean up client on disconnect or socket error', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-disconnect',
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      // Emit error then close
      ws.emit('error', new Error('Network reset'));
      ws.close();

      // @ts-expect-error - inspecting internal map
      expect(sync.webSocketToClient.has(ws)).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should send error when appId does not exist during auth sync', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'nonexistent-app',
        clientId: 'client-no-app',
      });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe(ServerMessageType.AuthError);
      expect((messages[0] as { message: string }).message).toContain(
        'Application not found',
      );

      consoleSpy.mockRestore();
    });

    it('should send error if app is deleted when client sends change batch', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const ws = new MockServerWebSocket();
      sync.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-app-del',
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      // Now delete the app
      await (await storage.getApp('todo-app'))?.delete();

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
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.type).toBe(ServerMessageType.Error);
      expect((lastMsg as { message: string }).message).toContain(
        'Application not found',
      );

      consoleSpy.mockRestore();
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
        appId: 'todo-app',
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(ws1.isClosed).toBe(true);

      // 2nd failed token -> triggers backoff
      const ws2 = new MockServerWebSocket();
      limitedSync.handleConnection(ws2 as unknown as WebSocket, '10.0.0.1');
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: 'bad-token-2',
        appId: 'todo-app',
      });
      await new Promise((r) => setTimeout(r, 20));
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
        appId: 'todo-app',
        clientId: 'c1',
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(cappedSync.connectedClientsCount).toBe(1);

      // Client 2 connects & auths
      const ws2 = new MockServerWebSocket();
      cappedSync.handleConnection(ws2 as unknown as WebSocket);
      ws2.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'c2',
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(cappedSync.connectedClientsCount).toBe(2);

      // Client 3 exceeds maxConcurrentConnectionsPerUser=2
      const ws3 = new MockServerWebSocket();
      cappedSync.handleConnection(ws3 as unknown as WebSocket);
      ws3.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'c3',
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(ws3.isClosed).toBe(true);
      const msgs = ws3.getParsedMessages();
      expect((msgs[0] as { message: string }).message).toContain(
        'Maximum concurrent connections exceeded',
      );
      expect(cappedSync.connectedClientsCount).toBe(2);

      // After client 1 disconnects, client 3 can connect
      ws1.close();
      expect(cappedSync.connectedClientsCount).toBe(1);

      const ws4 = new MockServerWebSocket();
      cappedSync.handleConnection(ws4 as unknown as WebSocket);
      ws4.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'c4',
      });
      await new Promise((r) => setTimeout(r, 20));
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
        appId: 'todo-app',
        clientId: 'client-reauth',
      });
      await new Promise((r) => setTimeout(r, 20));

      // 2. Re-authenticate same socket as user 2
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: token2,
        appId: 'todo-app',
        clientId: 'client-reauth',
      });
      await new Promise((r) => setTimeout(r, 20));

      // Clear message buffer
      ws.sentMessages = [];

      // 3. User 1 performs a mutation from another client
      const wsUser1 = new MockServerWebSocket();
      sync.handleConnection(wsUser1 as unknown as WebSocket);
      wsUser1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-other',
      });
      await new Promise((r) => setTimeout(r, 20));

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
      await new Promise((r) => setTimeout(r, 30));

      // 4. Verify that ws (now authenticated as user 2) did not receive user 1's broadcast
      const reauthMsgs = ws.getParsedMessages();
      const broadcastMsgs = reauthMsgs.filter(
        (m) => m.type === ServerMessageType.BroadcastChanges,
      );
      expect(broadcastMsgs).toHaveLength(0);
    });
  });
});
