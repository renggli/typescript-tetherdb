import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TetherClientError,
  TetherClientErrorCode,
} from '../../../src/client/errors.js';
import { Storage } from '../../../src/client/storage/storage.js';
import { Sync } from '../../../src/client/sync/sync.js';
import {
  SyncStatus,
  type WebSocketConstructor,
} from '../../../src/client/sync/types.js';
import {
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type ServerMessage,
  ServerMessageType,
} from '../../../src/shared/types.js';
import { waitForCondition } from '../../helpers.js';

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

describe('Sync', () => {
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
    await new Promise((r) => setTimeout(r, 2));
    await storage.close();
  });

  function createSync(
    options: Partial<ConstructorParameters<typeof Sync>[1]> = {},
  ): Sync {
    const sync = new Sync(storage, {
      clientId: 'test-client',
      url: 'ws://127.0.0.1:8080/sync',
      webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      ...options,
    });
    syncInstances.push(sync);
    return sync;
  }

  describe('Constructor & Validation', () => {
    it('should throw error when clientId is missing', () => {
      expect(
        () =>
          new Sync(storage, {
            // @ts-expect-error - testing missing clientId
            clientId: '',
          }),
      ).toThrow(TetherClientError);
      try {
        new Sync(storage, {
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
        clientId: 'custom-client',
        url: undefined,
      });

      expect(sync.clientId).toBe('custom-client');
      expect(sync.status).toBe(SyncStatus.Disconnected);
    });

    it('should auto-connect when url is provided in constructor', async () => {
      const sync = createSync({
        url: 'ws://127.0.0.1:9999/sync',
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
        url: undefined,
      });

      sync.connect('my-jwt-token', 'ws://127.0.0.1:8080/sync');
      expect(sync.status).toBe(SyncStatus.Connecting);

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      ws.triggerOpen();

      // Wait for async sendAuth
      await new Promise((r) => setTimeout(r, 2));

      const messages = ws.getParsedMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: ClientMessageType.Auth,
        protocolVersion: 1,
        token: 'my-jwt-token',
        clientId: 'client-xyz',
        lastSyncSeq: 77,
      });
    });

    it('should transition to Error when no WebSocket implementation is available', () => {
      const sync = new Sync(storage, {
        clientId: 'client-xyz',
        url: 'ws://localhost/sync',
        webSocketClass: null as unknown as WebSocketConstructor,
      });
      syncInstances.push(sync);

      sync.connect('token');
      expect(sync.status).toBe(SyncStatus.Error);
    });

    it('should transition to Error and schedule reconnect when WebSocket constructor throws', () => {
      const BrokenWebSocket = (() => {
        throw new Error('Failed to connect');
      }) as unknown as WebSocketConstructor;

      const sync = createSync({
        webSocketClass: BrokenWebSocket,
        reconnectIntervalMs: 50,
      });

      sync.connect('token', 'ws://bad-url');
      expect(sync.status).toBe(SyncStatus.Error);
    });

    it('should return early from connect when url is missing', () => {
      const sync = new Sync(storage, {
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
    const errorCallback = vi.fn();

    beforeEach(async () => {
      tokenRefreshCallback.mockReset();
      errorCallback.mockReset();

      sync = createSync({
        token: 'token-initial',
        pingIntervalMs: 5000,
      });
      sync.onTokenRefresh.register(tokenRefreshCallback);
      sync.onError.register(errorCallback);

      ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 2));
    });

    it('should handle ServerMessageType.AuthSuccess and update token', async () => {
      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        userId: 'u1',
        token: 'new-sliding-token',
      });
      await new Promise((r) => setTimeout(r, 2));

      expect(sync.status).toBe(SyncStatus.Connected);
      expect(tokenRefreshCallback).toHaveBeenCalledWith('new-sliding-token');
    });

    it('should handle ServerMessageType.AuthError, disconnect, and notify onError', async () => {
      ws.triggerMessage({
        type: ServerMessageType.AuthError,
        message: 'Invalid signature',
      });
      await new Promise((r) => setTimeout(r, 2));

      expect(sync.status).toBe(SyncStatus.Disconnected);
      expect(errorCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          code: TetherClientErrorCode.AuthenticationFailed,
          message: 'Invalid signature',
        }),
      );
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

      await new Promise((r) => setTimeout(r, 20));

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

      await new Promise((r) => setTimeout(r, 20));

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

      await waitForCondition(async () => (await table.get('u1')) !== undefined);

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

        await new Promise((r) => setTimeout(r, 2));

        const pendingOutbox = await storage.getPendingOutbox();
        expect(pendingOutbox).toHaveLength(0);
        expect(await storage.getMeta('lastSyncSeq')).toBe(105);
      }
    });

    it('should publish TetherClientError on onError for ServerMessageType.Error and Malformed JSON', async () => {
      const errors: TetherClientError[] = [];
      sync.onError.register((err) => errors.push(err));

      // Pong
      ws.triggerMessage({ type: ServerMessageType.Pong });
      await new Promise((r) => setTimeout(r, 10));

      // Server error message
      ws.triggerMessage({
        type: ServerMessageType.Error,
        message: 'Something went wrong on server',
      });
      await new Promise((r) => setTimeout(r, 2));
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe(TetherClientErrorCode.SyncError);
      expect(errors[0].message).toBe('Something went wrong on server');

      // Malformed JSON string
      ws.onmessage?.({ data: '{ not valid json' });
      await new Promise((r) => setTimeout(r, 2));
      expect(errors).toHaveLength(2);
      expect(errors[1].code).toBe(TetherClientErrorCode.SyncError);

      // WebSocket onerror
      ws.onerror?.(new Event('error') as unknown as ErrorEvent);
      expect(errors).toHaveLength(3);
      expect(errors[2].code).toBe(TetherClientErrorCode.NetworkError);
    });

    it('should process consecutive incoming messages sequentially in arrival order', async () => {
      const table = storage.table<{ count: number }>('counters');

      // Fire 3 server messages synchronously in the same event loop tick
      ws.triggerMessage({
        type: ServerMessageType.BroadcastChanges,
        seq: 1,
        changes: [
          {
            table: 'counters',
            id: 'c1',
            op: OperationType.Put,
            data: { count: 1 },
            timestamp: 100,
            clientId: 'server',
          },
        ],
      });

      ws.triggerMessage({
        type: ServerMessageType.BroadcastChanges,
        seq: 2,
        changes: [
          {
            table: 'counters',
            id: 'c1',
            op: OperationType.Put,
            data: { count: 2 },
            timestamp: 200,
            clientId: 'server',
          },
        ],
      });

      ws.triggerMessage({
        type: ServerMessageType.BroadcastChanges,
        seq: 3,
        changes: [
          {
            table: 'counters',
            id: 'c1',
            op: OperationType.Put,
            data: { count: 3 },
            timestamp: 300,
            clientId: 'server',
          },
        ],
      });

      await new Promise((r) => setTimeout(r, 40));

      const finalRecord = await table.get('c1');
      expect(finalRecord).toEqual({ count: 3 });
      expect(await storage.getMeta('lastSyncSeq')).toBe(3);
    });
  });

  describe('Outbox Push & Debouncing', () => {
    it('should debounce schedulePush calls', async () => {
      const sync = createSync({
        token: 'token-1',
      });

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 2));
      ws.triggerMessage({ type: ServerMessageType.AuthSuccess, userId: 'u1' });
      await new Promise((r) => setTimeout(r, 2));

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

    it('should filter outbox changes by accessibleTables for unauthenticated guests', async () => {
      const sync = createSync();
      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 2));

      // Server indicates only public_chat is accessible to guest
      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        protocolVersion: 1,
        currentSeq: 0,
        tables: ['public_chat'],
      });
      await new Promise((r) => setTimeout(r, 2));

      const chatTable = storage.table<{ text: string }>('public_chat');
      const settingsTable = storage.table<{ theme: string }>('user_settings');

      await chatTable.put('m1', { text: 'Public message' });
      await settingsTable.put('s1', { theme: 'dark' });

      ws.sentMessages.length = 0;
      await sync.pushOutbox();

      expect(ws.sentMessages).toHaveLength(1);
      const batch = JSON.parse(ws.sentMessages[0]) as {
        type: string;
        changes: Array<{ table: string; id: string }>;
      };
      expect(batch.type).toBe(ClientMessageType.ChangeBatch);
      expect(batch.changes).toHaveLength(1);
      expect(batch.changes[0].table).toBe('public_chat');

      // user_settings remains in outbox
      const pending = await storage.getPendingOutbox();
      expect(pending.map((p) => p.change.table)).toContain('user_settings');
    });

    it('should not filter changes by initial accessibleTables when authenticated', async () => {
      const sync = createSync({ token: 'auth-token-123' });
      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 2));

      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        protocolVersion: 1,
        currentSeq: 0,
        token: 'auth-token-123',
        tables: ['todos'],
      });
      await new Promise((r) => setTimeout(r, 2));

      const newTable = storage.table<{ content: string }>('dynamically_added');
      await newTable.put('d1', { content: 'Dynamic' });

      ws.sentMessages.length = 0;
      await sync.pushOutbox();

      expect(ws.sentMessages).toHaveLength(1);
      const batch = JSON.parse(ws.sentMessages[0]) as {
        changes: Array<{ table: string }>;
      };
      expect(batch.changes[0].table).toBe('dynamically_added');
    });

    it('should not schedule retry on ServerMessageType.Error and release batch', async () => {
      const sync = createSync({ token: 'tok' });
      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();
      await new Promise((r) => setTimeout(r, 2));
      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        protocolVersion: 1,
        currentSeq: 0,
        token: 'tok',
      });
      await new Promise((r) => setTimeout(r, 2));

      const table = storage.table<{ text: string }>('readonly_table');
      await table.put('r1', { text: 'Will fail' });

      const scheduleSpy = vi.spyOn(sync, 'schedulePush');
      ws.sentMessages.length = 0;
      await sync.pushOutbox();

      expect(ws.sentMessages).toHaveLength(1);
      const batch = JSON.parse(ws.sentMessages[0]) as { batchId: string };

      // Server returns error with batchId
      ws.triggerMessage({
        type: ServerMessageType.Error,
        batchId: batch.batchId,
        message: 'Access denied',
      });
      await new Promise((r) => setTimeout(r, 5));

      // schedulePush should NOT have been called on error
      expect(scheduleSpy).not.toHaveBeenCalled();
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
      await new Promise((r) => setTimeout(r, 2));

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
      await new Promise((r) => setTimeout(r, 2));

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
      await new Promise((r) => setTimeout(r, 2));

      sync.destroy();
      expect(sync.status).toBe(SyncStatus.Disconnected);

      // Closing the socket after destroy should not schedule reconnect
      ws.close(1006);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe('Online/Offline Status Tracking', () => {
    it('should not schedule reconnect when navigator.onLine is false', async () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        globalThis.navigator,
        'onLine',
      );
      Object.defineProperty(globalThis.navigator, 'onLine', {
        value: false,
        configurable: true,
        writable: true,
      });

      try {
        createSync({
          token: 'token-1',
          reconnectIntervalMs: 20,
        });

        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        await new Promise((r) => setTimeout(r, 2));

        // Abnormal close
        ws.close(1006);

        await new Promise((r) => setTimeout(r, 45));
        // Should not have created a new connection attempt
        expect(MockWebSocket.instances).toHaveLength(1);
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(
            globalThis.navigator,
            'onLine',
            originalDescriptor,
          );
        } else {
          Object.defineProperty(globalThis.navigator, 'onLine', {
            value: true,
            configurable: true,
            writable: true,
          });
        }
      }
    });

    it('should immediately reconnect when online window event fires', async () => {
      const mockWindow = new EventTarget();
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      (globalThis as unknown as { window: unknown }).window = mockWindow;

      try {
        const sync = createSync({
          token: 'token-1',
          reconnectIntervalMs: 10000,
        });

        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        await new Promise((r) => setTimeout(r, 2));

        // Disconnect socket
        ws.close(1006);
        expect(MockWebSocket.instances).toHaveLength(1);

        // Trigger online event on mockWindow
        mockWindow.dispatchEvent(new Event('online'));
        await new Promise((r) => setTimeout(r, 2));

        expect(MockWebSocket.instances).toHaveLength(2);
        expect(sync.status).toBe(SyncStatus.Connecting);
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    });

    it('should disconnect active socket when offline window event fires', async () => {
      const mockWindow = new EventTarget();
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      (globalThis as unknown as { window: unknown }).window = mockWindow;

      try {
        const sync = createSync({
          token: 'token-1',
        });

        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        await new Promise((r) => setTimeout(r, 2));
        expect(sync.status).toBe(SyncStatus.Connecting);

        // Trigger offline event
        mockWindow.dispatchEvent(new Event('offline'));
        expect(sync.status).toBe(SyncStatus.Disconnected);
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    });

    it('should clear active reconnectTimer when offline event fires while waiting for reconnect', async () => {
      const mockWindow = new EventTarget();
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      (globalThis as unknown as { window: unknown }).window = mockWindow;

      try {
        const sync = createSync({
          token: 'token-1',
          reconnectIntervalMs: 50000,
        });

        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        ws.close(1006); // triggers scheduleReconnect

        // Now fire offline while reconnectTimer is set
        mockWindow.dispatchEvent(new Event('offline'));
        expect(sync.status).toBe(SyncStatus.Disconnected);
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    });

    it('should emit onError when pushOutbox encounters an error', async () => {
      const sync = createSync({ token: 'token-1' });
      const errors: TetherClientError[] = [];
      sync.onError.register((err) => errors.push(err));

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();

      vi.spyOn(storage, 'getPendingOutbox').mockRejectedValue(
        new Error('DB read error'),
      );

      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        userId: 'user-1',
      });
      await new Promise((r) => setTimeout(r, 2));

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe(TetherClientErrorCode.SyncError);
      expect(errors[0].message).toBe('DB read error');
    });

    it('should handle non-Error exceptions in pushOutbox catch block', async () => {
      const sync = createSync({ token: 'token-1' });
      const errors: TetherClientError[] = [];
      sync.onError.register((err) => errors.push(err));

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();

      vi.spyOn(storage, 'getPendingOutbox').mockRejectedValue(
        'String error instead of Error instance',
      );

      ws.triggerMessage({
        type: ServerMessageType.AuthSuccess,
        userId: 'user-1',
      });
      await new Promise((r) => setTimeout(r, 2));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Failed to push outbox batch to server');
    });

    it('should unregister window event listeners on destroy if window exists', () => {
      const removeSpy = vi.fn();
      const mockWindow = {
        addEventListener: vi.fn(),
        removeEventListener: removeSpy,
      };
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      (globalThis as unknown as { window: unknown }).window = mockWindow;

      try {
        const sync = createSync({ token: 'token-1' });
        sync.destroy();
        expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));
        expect(removeSpy).toHaveBeenCalledWith('offline', expect.any(Function));
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    });

    it('should emit onError when message parsing or processing fails', async () => {
      const sync = createSync({ token: 'token-1' });
      const errors: TetherClientError[] = [];
      sync.onError.register((err) => errors.push(err));

      const ws = MockWebSocket.instances[0];
      ws.triggerOpen();

      // 1. Invalid JSON string
      ws.onmessage?.({ data: '{invalid-json' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[errors.length - 1].code).toBe(
        TetherClientErrorCode.SyncError,
      );

      // 2. Storage failure during message handling
      vi.spyOn(storage, 'applySnapshotBatch').mockRejectedValueOnce(
        new Error('Disk write failed'),
      );
      ws.triggerMessage({
        type: ServerMessageType.SyncSnapshot,
        seq: 1,
        snapshot: [],
      });
      await new Promise((r) => setTimeout(r, 2));

      expect(errors.some((e) => e.message === 'Disk write failed')).toBe(true);
    });

    it('should handle exceptions gracefully during disconnect', () => {
      const sync = createSync({ token: 'token-1' });
      const ws = MockWebSocket.instances[0];
      ws.close = () => {
        throw new Error('Socket already disposed');
      };
      expect(() => sync.disconnect()).not.toThrow();
      expect(sync.status).toBe(SyncStatus.Disconnected);
    });

    it('should handle window online and offline events to reconnect or disconnect', () => {
      let onlineHandler: (() => void) | undefined;
      let offlineHandler: (() => void) | undefined;
      const mockWindow = {
        addEventListener: (event: string, handler: () => void) => {
          if (event === 'online') onlineHandler = handler;
          if (event === 'offline') offlineHandler = handler;
        },
        removeEventListener: vi.fn(),
      };
      const originalWindow = (globalThis as unknown as { window?: unknown })
        .window;
      (globalThis as unknown as { window: unknown }).window = mockWindow;
      try {
        const sync = createSync({ token: 'token-online' });
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        expect(offlineHandler).toBeDefined();
        offlineHandler?.();
        expect(sync.status).toBe(SyncStatus.Disconnected);
        expect(onlineHandler).toBeDefined();
        onlineHandler?.();
        expect(sync.status).toBe(SyncStatus.Connecting);
        sync.destroy();
      } finally {
        (globalThis as unknown as { window?: unknown }).window = originalWindow;
      }
    });
  });
});
