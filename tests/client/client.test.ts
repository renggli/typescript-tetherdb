import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthStatus,
  SyncStatus,
  TetherClient,
  TetherClientError,
  TetherClientErrorCode,
} from '../../src/client/index.js';
import type { WebSocketConstructor } from '../../src/client/sync.js';
import { waitForCondition } from '../helpers.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {
    this.readyState = this.CLOSED;
  }
}

describe('TetherClient', () => {
  const clientsToClose: TetherClient[] = [];

  afterEach(async () => {
    for (const client of clientsToClose) {
      await client.close();
    }
    clientsToClose.length = 0;
    MockWebSocket.instances.length = 0;
  });

  describe('Constructor & State', () => {
    it('should initialize with default states and empty credentials', () => {
      const client = new TetherClient(
        `init-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);
      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(client.userName).toBeUndefined();
      expect(client.syncStatus).toBe(SyncStatus.Disconnected);
    });
  });

  describe('URL & Endpoint Resolution', () => {
    it('should handle default local-only client when url is omitted', () => {
      const client = new TetherClient(
        `local-only-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBeUndefined();
    });

    it('should preserve options.url directly without modification', () => {
      const client1 = new TetherClient('test-raw-url-1', {
        url: 'wss://storage.mydomain.com/',
      });
      clientsToClose.push(client1);

      // @ts-expect-error - inspecting internal sync
      expect(client1.sync.url).toBe('wss://storage.mydomain.com/');

      const client2 = new TetherClient('test-raw-url-2', {
        url: 'ws://localhost:8080',
      });
      clientsToClose.push(client2);

      // @ts-expect-error - inspecting internal sync
      expect(client2.sync.url).toBe('ws://localhost:8080');

      const client3 = new TetherClient('test-raw-url-3', {
        url: 'https://api.example.com/custom-db',
      });
      clientsToClose.push(client3);

      // @ts-expect-error - inspecting internal sync
      expect(client3.sync.url).toBe('https://api.example.com/custom-db');
    });

    it('should handle pushDebounceMs configuration option', () => {
      const client = new TetherClient('test-push-debounce', {
        pushDebounceMs: 50,
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync options
      expect(client.sync.options.pushDebounceMs).toBe(50);
    });

    it('should preserve custom url strings as provided', () => {
      const client = new TetherClient('test-custom-url', {
        url: 'custom-scheme://host:1234/path',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('custom-scheme://host:1234/path');
    });
  });

  describe('Storage & Table Proxying', () => {
    it('should provide typed Table instances', async () => {
      const client = new TetherClient(
        `table-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const table = client.table<{ title: string }>('todos');
      expect(table).toBeDefined();
      expect(table.name).toBe('todos');

      await table.put('1', { title: 'Hello Table' });
      expect(await table.get('1')).toEqual({ title: 'Hello Table' });
    });

    it('should clear all data across tables and metadata on clear()', async () => {
      const client = new TetherClient(
        `clear-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const table = client.table<{ text: string }>('notes');
      await table.put('n1', { text: 'To be wiped' });
      expect(await table.getAll()).toHaveLength(1);

      await client.clear();
      expect(await table.getAll()).toHaveLength(0);
    });
  });

  describe('Auth & Sync Event Coordination', () => {
    it('should trigger sync.schedulePush when local mutations occur', async () => {
      const client = new TetherClient(
        `sync-push-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync
      const schedulePushSpy = vi.spyOn(client.sync, 'schedulePush');

      const todos = client.table<{ text: string }>('todos');
      await todos.put('t1', { text: 'Local item' });

      expect(schedulePushSpy).toHaveBeenCalled();
    });

    it('should publish auth status changes and connect/disconnect sync accordingly', async () => {
      const client = new TetherClient(
        `auth-sync-test-${Math.random().toString(36).substring(2, 8)}`,
        {
          url: 'ws://127.0.0.1:8080',
          webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
        },
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync
      const connectSpy = vi.spyOn(client.sync, 'connect');
      // @ts-expect-error - inspecting internal sync
      vi.spyOn(client.sync, 'register').mockResolvedValue({
        userName: 'alice',
        token: 'token-123',
      });
      // @ts-expect-error - inspecting internal sync
      vi.spyOn(client.sync, 'logout').mockResolvedValue();

      const authEvents: AuthStatus[] = [];
      client.onAuthStatusChange.register((s) => authEvents.push(s));

      const success = await client.register({
        userName: 'alice',
        password: 'password123',
      });

      expect(success).toBe(true);
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      expect(client.userName).toBe('alice');
      expect(authEvents).toContain(AuthStatus.SignedIn);
      expect(connectSpy).toHaveBeenCalledWith('token-123');

      // Logout should reconnect sync as guest
      await client.logout();
      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(connectSpy).toHaveBeenCalledWith(undefined);
    });

    it('should forward sync status change events to onSyncStatusChange', () => {
      const client = new TetherClient(
        `sync-status-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const syncStatuses: SyncStatus[] = [];
      client.onSyncStatusChange.register((s) => syncStatuses.push(s));

      // @ts-expect-error - triggering sync status change internally
      client.sync.onStatusChange.publish(SyncStatus.Connecting);
      // @ts-expect-error - triggering sync status change internally
      client.sync.onStatusChange.publish(SyncStatus.Connected);

      expect(syncStatuses).toEqual([
        SyncStatus.Connecting,
        SyncStatus.Connected,
      ]);
    });

    it('should forward sync errors to onError', () => {
      const client = new TetherClient(
        `sync-error-test-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const errors: TetherClientError[] = [];
      client.onError.register((err) => errors.push(err));

      const testError = new TetherClientError(
        TetherClientErrorCode.SyncError,
        'Simulated error',
      );
      // @ts-expect-error - triggering sync error internally
      client.sync.onError.publish(testError);

      expect(errors).toEqual([testError]);
    });

    it('should delegate login, register, and logout to Auth', async () => {
      const client = new TetherClient(
        `auth-delegate-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      const registerSpy = vi
        .spyOn(client.auth, 'register')
        .mockResolvedValue(true);
      // @ts-expect-error - inspecting internal auth
      const loginSpy = vi.spyOn(client.auth, 'login').mockResolvedValue(true);
      // @ts-expect-error - inspecting internal auth
      const logoutSpy = vi.spyOn(client.auth, 'logout').mockResolvedValue(true);

      await client.register({ userName: 'u', password: 'p' });
      expect(registerSpy).toHaveBeenCalledWith({
        userName: 'u',
        password: 'p',
      });

      await client.login({ userName: 'u', password: 'p' });
      expect(loginSpy).toHaveBeenCalledWith({ userName: 'u', password: 'p' });

      await client.logout();
      expect(logoutSpy).toHaveBeenCalledWith({});
    });
  });

  describe('close()', () => {
    it('should tear down sync and close storage connection', async () => {
      const client = new TetherClient(
        `close-test-${Math.random().toString(36).substring(2, 8)}`,
      );

      // @ts-expect-error - inspecting internal sync
      const destroySpy = vi.spyOn(client.sync, 'destroy');
      // @ts-expect-error - inspecting internal storage
      const closeStorageSpy = vi.spyOn(client.storage, 'close');

      await client.close();

      expect(destroySpy).toHaveBeenCalled();
      expect(closeStorageSpy).toHaveBeenCalled();
    });
  });

  describe('Browser location resolution and sync callbacks', () => {
    it('should resolve protocol and host from window.location if present', () => {
      // @ts-expect-error - simulating browser environment
      globalThis.window = {
        location: {
          hostname: 'app.mycompany.internal',
          port: '3000',
          protocol: 'https:',
          href: 'https://app.mycompany.internal:3000',
        },
      };

      try {
        const client = new TetherClient('browser-loc-test');
        clientsToClose.push(client);

        // @ts-expect-error - inspecting internal sync
        expect(client.sync.url).toBe(
          'wss://app.mycompany.internal:3000/tether',
        );
      } finally {
        // @ts-expect-error - cleanup browser simulation
        delete globalThis.window;
      }
    });

    it('should wire sync onTokenRefresh and onError auth failures to auth coordinator', () => {
      const client = new TetherClient('callbacks-test');
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      const refreshSpy = vi.spyOn(client.auth, 'handleTokenRefresh');
      // @ts-expect-error - inspecting internal auth
      const authErrorSpy = vi.spyOn(client.auth, 'handleAuthError');

      // @ts-expect-error - inspecting internal sync
      client.sync.onTokenRefresh.publish('new-jwt');
      expect(refreshSpy).toHaveBeenCalledWith('new-jwt');

      // @ts-expect-error - inspecting internal sync
      client.sync.onError.publish(
        new TetherClientError(
          TetherClientErrorCode.AuthenticationFailed,
          'Session revoked',
        ),
      );
      expect(authErrorSpy).toHaveBeenCalledWith('Session revoked');
    });

    it('should query declarative indexes created on table', async () => {
      const client = new TetherClient(
        `client-idx-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const users = client.table<{ email: string; name: string }>('users');
      const email = users.index<string>('email', { unique: true });

      await users.put('u1', { email: 'alice@example.com', name: 'Alice' });

      const user = await email.get('alice@example.com');
      expect(user).toEqual({ email: 'alice@example.com', name: 'Alice' });
    });

    it('should attribute active userName to local records and mutations', async () => {
      const dbName = `user-author-test-${Math.random().toString(36).substring(2, 8)}`;
      const client = new TetherClient(dbName);
      clientsToClose.push(client);

      // @ts-expect-error - set current user for test
      client.storage.setCurrentUser('alice');

      const posts = client.table<{ title: string }>('posts');
      await posts.put('p1', { title: 'First Post' });

      const record = await posts.getWithMetadata('p1');
      expect(record?.data).toEqual({ title: 'First Post' });
      expect(record?.userName).toBe('alice');
    });
  });

  describe('Multi-Tab Synchronization', () => {
    it('should propagate local mutations from Tab A to Tab B via BroadcastChannel', async () => {
      const dbName = `multitab-sync-${Math.random().toString(36).substring(2, 8)}`;
      const tabA = new TetherClient(dbName);
      const tabB = new TetherClient(dbName);
      clientsToClose.push(tabA, tabB);

      const todosA = tabA.table<{ title: string }>('todos');
      const todosB = tabB.table<{ title: string }>('todos');

      const eventsReceivedByB: Array<{
        id: string;
        op: string;
        data?: { title: string };
        isRemote?: boolean;
      }> = [];
      todosB.onChange.register((events) => {
        eventsReceivedByB.push(...events);
      });

      await todosA.put('t1', { title: 'Buy oat milk' });

      await waitForCondition(() => eventsReceivedByB.length === 1);
      expect(eventsReceivedByB[0]).toMatchObject({
        id: 't1',
        op: 'put',
        data: { title: 'Buy oat milk' },
        isRemote: true,
      });
    });

    it('should propagate sign-in from Tab A to Tab B in real-time', async () => {
      const dbName = `multitab-auth-${Math.random().toString(36).substring(2, 8)}`;
      const tabA = new TetherClient(dbName, {
        webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      });
      const tabB = new TetherClient(dbName, {
        webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      });
      clientsToClose.push(tabA, tabB);

      const authStatusesB: AuthStatus[] = [];
      tabB.onAuthStatusChange.register((status) => {
        authStatusesB.push(status);
      });

      // @ts-expect-error - mock login without real server
      vi.spyOn(tabA.sync, 'login').mockResolvedValueOnce({
        userName: 'alice',
        token: 'token-alice-123',
      });

      await tabA.login({ userName: 'alice', password: 'password123' });

      expect(tabA.authStatus).toBe(AuthStatus.SignedIn);
      expect(tabA.userName).toBe('alice');

      await waitForCondition(() => tabB.authStatus === AuthStatus.SignedIn);
      expect(tabB.userName).toBe('alice');
      expect(tabB.token).toBe('token-alice-123');
      expect(authStatusesB).toContain(AuthStatus.SignedIn);
    });

    it('should propagate sign-out from Tab A to Tab B in real-time', async () => {
      const dbName = `multitab-logout-${Math.random().toString(36).substring(2, 8)}`;
      const tabA = new TetherClient(dbName, {
        webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      });
      const tabB = new TetherClient(dbName, {
        webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
      });
      clientsToClose.push(tabA, tabB);

      // Simulate both signed in
      // @ts-expect-error - set internal session
      tabA.auth.applyRemoteAuth(AuthStatus.SignedIn, 'alice', 'token-alice');
      // @ts-expect-error - set internal session
      tabB.auth.applyRemoteAuth(AuthStatus.SignedIn, 'alice', 'token-alice');

      expect(tabA.authStatus).toBe(AuthStatus.SignedIn);
      expect(tabB.authStatus).toBe(AuthStatus.SignedIn);

      const authStatusesB: AuthStatus[] = [];
      tabB.onAuthStatusChange.register((status) => {
        authStatusesB.push(status);
      });

      // @ts-expect-error - mock sync logout
      vi.spyOn(tabA.sync, 'logout').mockResolvedValueOnce(undefined);

      await tabA.logout();

      expect(tabA.authStatus).toBe(AuthStatus.SignedOut);

      await waitForCondition(() => tabB.authStatus === AuthStatus.SignedOut);
      expect(tabB.userName).toBeUndefined();
      expect(tabB.token).toBeUndefined();
      expect(authStatusesB).toContain(AuthStatus.SignedOut);
    });

    it('should isolate cross-tab messages between different database names', async () => {
      const db1 = `isolated-db-1-${Math.random().toString(36).substring(2, 8)}`;
      const db2 = `isolated-db-2-${Math.random().toString(36).substring(2, 8)}`;

      const client1 = new TetherClient(db1);
      const client2 = new TetherClient(db2);
      clientsToClose.push(client1, client2);

      const eventsInClient2: unknown[] = [];
      client2.table('items').onChange.register((events) => {
        eventsInClient2.push(...events);
      });

      await client1.table('items').put('item-1', { name: 'Widget' });

      // Let event loop settle and verify client2 received no events
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(eventsInClient2).toHaveLength(0);
    });
  });

  describe('Lifecycle & Leader Election', () => {
    it('should initialize client, restore session and clear data', async () => {
      const dbName = `init-test-${Math.random().toString(36).substring(2, 8)}`;
      const client = new TetherClient(dbName);
      clientsToClose.push(client);
      await client.init();
      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      await client.table('items').put('1', { text: 'hello' });
      expect(await client.table('items').get('1')).toEqual({ text: 'hello' });
      await client.clear();
      expect(await client.table('items').get('1')).toBeUndefined();
    });

    it('should acquire leader lock when navigator.locks is available', async () => {
      const dbName = `locks-test-${Math.random().toString(36).substring(2, 8)}`;
      let requestedLock = false;
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'navigator',
      );
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          locks: {
            request: vi
              .fn()
              .mockImplementation(
                async (
                  _name: string,
                  _options: unknown,
                  callback: () => Promise<void>,
                ) => {
                  requestedLock = true;
                  return callback();
                },
              ),
          },
        },
        configurable: true,
        writable: true,
      });
      try {
        const client = new TetherClient(dbName);
        clientsToClose.push(client);
        await client.init();
        expect(requestedLock).toBe(true);
        await client.close();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'navigator', originalDescriptor);
        }
      }
    });

    it('should handle leader election lock rejection errors gracefully', async () => {
      const dbName = `locks-err-${Math.random().toString(36).substring(2, 8)}`;
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        'navigator',
      );
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          locks: {
            request: vi
              .fn()
              .mockRejectedValue(new Error('Lock request rejected')),
          },
        },
        configurable: true,
        writable: true,
      });
      try {
        const client = new TetherClient(dbName);
        clientsToClose.push(client);
        await client.init();
        await client.close();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(globalThis, 'navigator', originalDescriptor);
        }
      }
    });
  });
});
