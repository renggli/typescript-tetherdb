import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthStatus,
  DataMode,
  SyncStatus,
  TetherClient,
  TetherClientError,
  TetherClientErrorCode,
} from '../../src/client/index.js';
import type { WebSocketConstructor } from '../../src/client/sync.js';

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

    it('should export AuthStatus and DataMode enums', () => {
      expect(AuthStatus.SignedIn).toBe(2);
      expect(DataMode.Remote).toBe(0);
      expect(DataMode.Local).toBe(1);
      expect(DataMode.Merge).toBe(2);
      expect(DataMode.Clear).toBe(3);
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
});
