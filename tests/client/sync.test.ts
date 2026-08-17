import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TetherClientError,
  TetherClientErrorCode,
} from '../../src/client/errors.js';
import { Storage } from '../../src/client/storage.js';
import {
  Sync,
  SyncStatus,
  type WebSocketConstructor,
} from '../../src/client/sync.js';
import {
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type ServerMessage,
  ServerMessageType,
} from '../../src/shared/types.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  url: string;
  sentMessages: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = 'Normal closure'): void {
    this.readyState = this.CLOSED;
    this.onclose?.({ code, reason });
  }

  triggerOpen(): void {
    this.readyState = this.OPEN;
    this.onopen?.();
  }

  triggerMessage(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  getParsedMessages<T = ClientMessage>(): T[] {
    return this.sentMessages.map((raw) => JSON.parse(raw) as T);
  }
}

describe('Sync (src/client/sync.ts)', () => {
  let storage: Storage;
  const syncInstances: Sync[] = [];

  beforeEach(() => {
    MockWebSocket.instances = [];
    storage = new Storage(
      `test-sync-${Math.random().toString(36).substring(2, 8)}`,
    );
  });

  afterEach(async () => {
    for (const sync of syncInstances) {
      sync.destroy();
    }
    syncInstances.length = 0;
    // Allow any pending async sendAuth/pushOutbox to drain before closing storage
    await new Promise((r) => setTimeout(r, 20));
    await storage.close();
  });

  function createSync(
    options: Partial<ConstructorParameters<typeof Sync>[1]> = {},
  ): Sync {
    const sync = new Sync(storage, {
      appId: 'test-app',
      clientId: 'test-client',
      url: 'ws://127.0.0.1:8080/sync',
      webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      ...options,
    });
    syncInstances.push(sync);
    return sync;
  }

  describe('Constructor & Validation', () => {
    it('should throw error when appId is missing', () => {
      expect(
        () =>
          new Sync(storage, {
            // @ts-expect-error - testing missing appId
            appId: '',
            clientId: 'client-1',
          }),
      ).toThrow(TetherClientError);
      try {
        new Sync(storage, {
          // @ts-expect-error - testing missing appId
          appId: '',
          clientId: 'client-1',
        });
      } catch (err) {
        expect((err as TetherClientError).code).toBe(
          TetherClientErrorCode.MissingConfiguration,
        );
      }
    });

    it('should throw error when clientId is missing', () => {
      expect(
        () =>
          new Sync(storage, {
            appId: 'app-1',
            // @ts-expect-error - testing missing clientId
            clientId: '',
          }),
      ).toThrow(TetherClientError);
      try {
        new Sync(storage, {
          appId: 'app-1',
          // @ts-expect-error - testing missing clientId
          clientId: '',
        });
      } catch (err) {
        expect((err as TetherClientError).code).toBe(
          TetherClientErrorCode.MissingConfiguration,
        );
      }
    });

    it('should initialize with Disconnected status and configured properties', () => {
      const sync = createSync({
        appId: 'custom-app',
        clientId: 'custom-client',
        url: 'ws://127.0.0.1:9999/sync',
      });

      expect(sync.appId).toBe('custom-app');
      expect(sync.clientId).toBe('custom-client');
      expect(sync.url).toBe('ws://127.0.0.1:9999/sync');
      expect(sync.status).toBe(SyncStatus.Disconnected);
      expect(sync.getStatus()).toBe(SyncStatus.Disconnected);
    });

    it('should auto-connect when both token and url are provided in constructor', async () => {
      const sync = createSync({
        token: 'auth-token',
      });

      expect(sync.status).toBe(SyncStatus.Connecting);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe('Connection & Authentication Handshake', () => {
    it('should transition to Connecting and send Auth message upon onopen', async () => {
      await storage.setMeta('lastSyncSeq', 77);

      const sync = createSync({
        clientId: 'client-xyz',
      });

      sync.connect('my-jwt-token', 'ws://127.0.0.1:8080/sync');
      expect(sync.status).toBe(SyncStatus.Connecting);

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      ws.triggerOpen();

      // Wait for async sendAuth
      await new Promise((r) => setTimeout(r, 20));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ClientMessageType.Auth,
        token: 'my-jwt-token',
        appId: 'test-app',
        clientId: 'client-xyz',
        lastSyncSeq: 77,
      });
    });

    it('should transition to Error when no WebSocket implementation is available', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const sync = new Sync(storage, {
        appId: 'test-app',
        clientId: 'client-xyz',
        url: 'ws://localhost/sync',
        webSocketClass: undefined,
      });
      syncInstances.push(sync);

      const originalWS = globalThis.WebSocket;
      // @ts-expect-error - simulating environment without WebSocket
      delete globalThis.WebSocket;

      try {
        sync.connect('token');
        expect(sync.status).toBe(SyncStatus.Error);
      } finally {
        globalThis.WebSocket = originalWS;
        consoleSpy.mockRestore();
      }
    });

    it('should transition to Error and schedule reconnect when WebSocket constructor throws', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const BrokenWebSocket = (() => {
        throw new Error('Failed to connect');
      }) as unknown as WebSocketConstructor;

      const sync = createSync({
        webSocketClass: BrokenWebSocket,
        reconnectIntervalMs: 50,
      });

      sync.connect('token', 'ws://bad-url');
      expect(sync.status).toBe(SyncStatus.Error);
      consoleSpy.mockRestore();
    });

    it('should return early from connect when url is missing', () => {
      const sync = new Sync(storage, {
        appId: 'test-app',
        clientId: 'client-xyz',
        webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      });
      syncInstances.push(sync);

      sync.connect();
      expect(sync.status).toBe(SyncStatus.Disconnected);
      expect(MockWebSocket.instances).toHaveLength(0);
    });
  });

  describe('Server Message Handling', () => {
    let sync: Sync;
    let ws: MockWebSocket;
    const tokenRefreshCallback = vi.fn();
    const authErrorCallback = vi.fn();

    beforeEach(async () => {
      tokenRefreshCallback.mockReset();
      authErrorCallback.mockReset();

      sync = createSync({
        token: 'token-initial',
        onTokenRefresh: tokenRefreshCallback,
        onAuthError: authErrorCallback,
        pingIntervalMs: 5000,
      });

      ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 20));
    });

    it('should handle ServerMessageType.AuthSuccess and update token', async () => {
      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        userId: 'u1',
        token: 'new-sliding-token',
      });

      expect(sync.status).toBe(SyncStatus.Connected);
      expect(tokenRefreshCallback).toHaveBeenCalledWith('new-sliding-token');
    });

    it('should handle ServerMessageType.AuthError, disconnect, and call onAuthError', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      ws.triggerMessage({
        type: ServerMessageType.AuthError,
        message: 'Invalid signature',
      });

      expect(sync.status).toBe(SyncStatus.Disconnected);
      expect(authErrorCallback).toHaveBeenCalledWith('Invalid signature');
      consoleSpy.mockRestore();
    });

    it('should handle ServerMessageType.SyncSnapshot and notify table subscribers', async () => {
      const table = storage.table<{ title: string }>('todos');
      const tableEvents: unknown[] = [];
      table.onChange.register((events) => tableEvents.push(...events));

      ws.triggerMessage({
        type: ServerMessageType.SyncSnapshot,
        seq: 50,
        snapshot: [
          {
            table: 'todos',
            id: 'snap-1',
            data: { title: 'Snap Todo' },
            timestamp: 100,
            version: 1,
          },
          {
            table: 'todos',
            id: 'snap-del',
            data: null,
            timestamp: 101,
            version: 1,
            deleted: true,
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 25));

      expect(await table.get('snap-1')).toEqual({ title: 'Snap Todo' });
      expect(await table.get('snap-del')).toBeUndefined();
      expect(tableEvents).toHaveLength(2);
      expect(await storage.getMeta('lastSyncSeq')).toBe(50);
    });

    it('should handle ServerMessageType.SyncDiff and update storage and listeners', async () => {
      const table = storage.table<{ text: string }>('notes');
      const tableEvents: unknown[] = [];
      table.onChange.register((events) => tableEvents.push(...events));

      ws.triggerMessage({
        type: ServerMessageType.SyncDiff,
        fromSeq: 10,
        toSeq: 12,
        changes: [
          {
            table: 'notes',
            id: 'n1',
            op: OperationType.Put,
            data: { text: 'Diff Note' },
            timestamp: 200,
            clientId: 'remote',
            version: 1,
          },
          {
            table: 'notes',
            id: 'n2',
            op: OperationType.Delete,
            timestamp: 201,
            clientId: 'remote',
            version: 1,
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 25));

      expect(await table.get('n1')).toEqual({ text: 'Diff Note' });
      expect(tableEvents).toHaveLength(2);
      expect(await storage.getMeta('lastSyncSeq')).toBe(12);
    });

    it('should handle ServerMessageType.BroadcastChanges and notify listeners', async () => {
      const table = storage.table<{ name: string }>('users');
      const tableEvents: unknown[] = [];
      table.onChange.register((events) => tableEvents.push(...events));

      ws.triggerMessage({
        type: ServerMessageType.BroadcastChanges,
        seq: 99,
        changes: [
          {
            table: 'users',
            id: 'u1',
            op: OperationType.Put,
            data: { name: 'Alice' },
            timestamp: 300,
            clientId: 'remote',
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 25));

      expect(await table.get('u1')).toEqual({ name: 'Alice' });
      expect(tableEvents).toHaveLength(1);
    });

    it('should handle ServerMessageType.ChangeAck and drain acknowledged local outbox items', async () => {
      // Transition to Connected
      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        userId: 'u1',
      });

      // Put item to queue outbox entry
      const table = storage.table<{ title: string }>('todos');
      await table.put('ack-1', { title: 'Ack Test' });

      // Trigger push
      await sync.pushOutbox();

      const messages = ws.getParsedMessages();
      const changeBatchMsg = messages.find(
        (m) => m.type === ClientMessageType.ChangeBatch,
      );
      expect(changeBatchMsg).toBeDefined();

      if (
        changeBatchMsg &&
        changeBatchMsg.type === ClientMessageType.ChangeBatch
      ) {
        const batchId = changeBatchMsg.batchId;

        // Send ChangeAck from server
        ws.triggerMessage({
          type: ServerMessageType.ChangeAck,
          batchId,
          appliedSeq: 105,
        });

        await new Promise((r) => setTimeout(r, 25));

        const pendingOutbox = await storage.getPendingOutbox();
        expect(pendingOutbox).toHaveLength(0);
        expect(await storage.getMeta('lastSyncSeq')).toBe(105);
      }
    });

    it('should handle Pong, Server Error, and Malformed JSON without crashing', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // Pong
      ws.triggerMessage({ type: ServerMessageType.Pong });

      // Server error message
      ws.triggerMessage({
        type: ServerMessageType.Error,
        message: 'Something went wrong',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Sync] Server error:'),
        'Something went wrong',
      );

      // Malformed JSON string
      ws.onmessage?.({ data: '{ not valid json' });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[Sync] Failed to parse incoming WebSocket message:',
        ),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Outbox Push & Debouncing', () => {
    it('should debounce schedulePush calls', async () => {
      const sync = createSync({
        token: 'token-1',
      });

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 20));
      ws.triggerMessage({ type: ServerMessageType.AuthSuccess, userId: 'u1' });

      const pushSpy = vi.spyOn(sync, 'pushOutbox');

      sync.schedulePush(20);
      sync.schedulePush(20);
      sync.schedulePush(20);

      expect(pushSpy).not.toHaveBeenCalled();

      await new Promise((r) => setTimeout(r, 40));
      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('should not push outbox when disconnected or socket is not open', async () => {
      const sync = createSync();

      const table = storage.table<{ text: string }>('todos');
      await table.put('p1', { text: 'Offline' });

      // In disconnected state
      await sync.pushOutbox();
      expect(await storage.getPendingOutbox()).toHaveLength(1);
    });
  });

  describe('Reconnection & Keepalive Ping', () => {
    it('should schedule reconnection on non-clean socket close', async () => {
      createSync({
        token: 'token-1',
        reconnectIntervalMs: 20,
      });

      const ws1 = MockWebSocket.instances[0];
      ws1.triggerOpen();
      await new Promise((r) => setTimeout(r, 20));

      // Abnormal close (e.g. 1006)
      ws1.close(1006, 'Abnormal closure');

      // Wait for reconnect timer
      await new Promise((r) => setTimeout(r, 45));

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    });

    it('should send periodic Ping messages when connected', async () => {
      createSync({
        token: 'token-1',
        pingIntervalMs: 25,
      });

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 20));

      await new Promise((r) => setTimeout(r, 60));

      const messages = ws.getParsedMessages();
      const pings = messages.filter((m) => m.type === ClientMessageType.Ping);
      expect(pings.length).toBeGreaterThanOrEqual(1);
    });

    it('should clean up timers and state on destroy()', async () => {
      const sync = createSync({
        token: 'token-1',
      });

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 20));

      sync.destroy();
      expect(sync.status).toBe(SyncStatus.Disconnected);

      // Closing the socket after destroy should not schedule reconnect
      ws.close(1006);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});
