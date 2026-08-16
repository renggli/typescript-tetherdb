import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { MemoryStorage } from '../../src/server/storage/memory/index.js';
import { SyncHub } from '../../src/server/sync-hub.js';
import {
  ClientMessageType,
  OperationType,
  type ServerMessage,
  ServerMessageType,
} from '../../src/shared/types.js';

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

  // Helper to send message from client to server
  emitClientMessage(msg: unknown): void {
    this.emit('message', typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  getParsedMessages<T = ServerMessage>(): T[] {
    return this.sentMessages.map((raw) => JSON.parse(raw) as T);
  }
}

describe('SyncHub (src/server/sync-hub.ts)', () => {
  let storage: MemoryStorage;
  let syncHub: SyncHub;
  let validToken: string;
  let testUserId: string;

  beforeEach(async () => {
    storage = new MemoryStorage();
    syncHub = new SyncHub(storage);

    const app = await storage.createApp('todo-app');
    await app.createTable('todos');
    await app.createTable('notes');

    const user = await storage.createUser('alice', 'password123');
    testUserId = user.id;
    validToken = await user.createToken();
  });

  describe('Authentication Handshake (ClientMessageType.Auth)', () => {
    it('should reject connection if token is missing or empty', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
        message: 'Missing or invalid authentication token.',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if token is invalid or expired', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
        message: 'Invalid or expired authentication token.',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if appId is missing or empty', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
        message: 'Missing required field: appId.',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should reject connection if application does not exist', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
        message: 'Application not found.',
      });
      expect(ws.isClosed).toBe(true);
    });

    it('should successfully authenticate and return AuthSuccess + initial snapshot for seq 0', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      syncHub.handleConnection(ws as unknown as WebSocket);

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

    it('should fallback to full snapshot when diff exceeds 50 changes threshold', async () => {
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
      syncHub.handleConnection(ws as unknown as WebSocket);

      // Client connecting with seq 1 (> 50 changes diff)
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
      expect(messages[1].type).toBe(ServerMessageType.SyncSnapshot);
      if (messages[1].type === ServerMessageType.SyncSnapshot) {
        expect(messages[1].snapshot).toHaveLength(55);
      }
    });

    it('should handle InitSync for authenticated client', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

      // 1. Auth
      ws.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      // 2. Explicit InitSync request
      ws.emitClientMessage({
        type: ClientMessageType.InitSync,
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(3);
      expect(messages[2].type).toBe(ServerMessageType.SyncSnapshot);
    });

    it('should reject InitSync when client is not authenticated', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

      ws.emitClientMessage({
        type: ClientMessageType.InitSync,
        lastSyncSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ServerMessageType.AuthError,
        message: 'Not authenticated.',
      });
    });
  });

  describe('Change Ingestion & Real-Time Broadcasting (ClientMessageType.ChangeBatch)', () => {
    it('should reject ChangeBatch when client is not authenticated', async () => {
      const ws = new MockServerWebSocket();
      syncHub.handleConnection(ws as unknown as WebSocket);

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
        message: 'Not authenticated.',
      });
    });

    it('should apply changes, send ChangeAck to sender, and broadcast to other clients of the same app and user', async () => {
      // Client 1 (Sender)
      const ws1 = new MockServerWebSocket();
      syncHub.handleConnection(ws1 as unknown as WebSocket);
      ws1.emitClientMessage({
        type: ClientMessageType.Auth,
        token: validToken,
        appId: 'todo-app',
        clientId: 'client-1',
        lastSyncSeq: 0,
      });

      // Client 2 (Receiver - same app, same user)
      const ws2 = new MockServerWebSocket();
      syncHub.handleConnection(ws2 as unknown as WebSocket);
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
            data: { title: 'SyncHub Todo' },
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
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      syncHub.handleConnection(ws as unknown as WebSocket);

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
      expect(syncHub.webSocketToClient.has(ws)).toBe(false);

      consoleSpy.mockRestore();
    });
  });
});
