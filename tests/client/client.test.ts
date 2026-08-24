import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthStatus,
  DataMode,
  Index,
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
      expect(client.username).toBeUndefined();
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

  describe('URL & Host Resolution', () => {
    it('should resolve Node.js host, port, basePath, and webSocketPath correctly', () => {
      const client = new TetherClient(
        `url-test-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: 'api.example.com',
          port: 8443,
          secure: true,
          basePath: '/api/v1/',
          webSocketPath: '/custom/sync',
        },
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('https://api.example.com:8443/api/v1');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('wss://api.example.com:8443/custom/sync');
    });

    it('should handle host already containing port without duplicating port', () => {
      const client = new TetherClient(
        `port-test-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: '127.0.0.1:9090',
          port: 9090,
        },
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('http://127.0.0.1:9090');
    });

    it('should handle default local-only client when host is omitted', () => {
      const client = new TetherClient(
        `local-only-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBeUndefined();
    });

    it('should parse http url and derive base and websocket URLs', () => {
      const client = new TetherClient('test-http-url', {
        url: 'http://localhost:8080',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('http://localhost:8080');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('ws://localhost:8080/sync');
    });

    it('should parse https url with path and derive companion websocket URL', () => {
      const client = new TetherClient('test-https-url', {
        url: 'https://api.example.com/db',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('https://api.example.com/db');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('wss://api.example.com/db/sync');
    });

    it('should parse wss url and derive companion http base URL', () => {
      const client = new TetherClient('test-wss-url', {
        url: 'wss://api.example.com:8443/custom/sync',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('https://api.example.com:8443/custom');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('wss://api.example.com:8443/custom/sync');
    });

    it('should parse ws url with path and derive sync endpoint', () => {
      const client = new TetherClient('test-ws-url', {
        url: 'ws://127.0.0.1:5000/api',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('http://127.0.0.1:5000/api');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('ws://127.0.0.1:5000/api/sync');
    });

    it('should allow explicit options to override properties extracted from url', () => {
      const client = new TetherClient('test-override-url', {
        url: 'http://localhost:8080/api',
        port: 9000,
        basePath: '/v2',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('http://localhost:9000/v2');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBe('ws://localhost:9000/v2/sync');
    });

    it('should handle pushDebounceMs configuration option', () => {
      const client = new TetherClient('test-push-debounce', {
        pushDebounceMs: 50,
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync options
      expect(client.sync.options.pushDebounceMs).toBe(50);
    });

    it('should safely ignore invalid url strings without crashing', () => {
      const client = new TetherClient('test-invalid-url', {
        url: 'not-a-valid-url',
      });
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      expect(client.auth.baseUrl).toBe('');
      // @ts-expect-error - inspecting internal sync
      expect(client.sync.url).toBeUndefined();
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
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          userId: 'u1',
          username: 'alice',
          token: 'token-123',
        }),
      });

      const client = new TetherClient(
        `auth-sync-test-${Math.random().toString(36).substring(2, 8)}`,
        {
          host: '127.0.0.1',
          port: 8080,
          fetch: mockFetch as unknown as typeof fetch,
          webSocketClass: MockWebSocket as unknown as WebSocketConstructor,
        },
      );
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal sync
      const connectSpy = vi.spyOn(client.sync, 'connect');
      // @ts-expect-error - inspecting internal sync
      const disconnectSpy = vi.spyOn(client.sync, 'disconnect');

      const authEvents: AuthStatus[] = [];
      client.onAuthStatusChange.register((s) => authEvents.push(s));

      const success = await client.register({
        username: 'alice',
        password: 'password123',
      });

      expect(success).toBe(true);
      expect(client.authStatus).toBe(AuthStatus.SignedIn);
      expect(client.username).toBe('alice');
      expect(authEvents).toContain(AuthStatus.SignedIn);
      expect(connectSpy).toHaveBeenCalledWith('token-123');

      // Logout should trigger disconnect
      await client.logout();
      expect(client.authStatus).toBe(AuthStatus.SignedOut);
      expect(disconnectSpy).toHaveBeenCalled();
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

      await client.register({ username: 'u', password: 'p' });
      expect(registerSpy).toHaveBeenCalledWith({
        username: 'u',
        password: 'p',
      });

      await client.login({ username: 'u', password: 'p' });
      expect(loginSpy).toHaveBeenCalledWith({ username: 'u', password: 'p' });

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
    it('should resolve host, port, and protocol from window.location if present', () => {
      // @ts-expect-error - simulating browser environment
      globalThis.window = {
        location: {
          hostname: 'app.mycompany.internal',
          port: '3000',
          protocol: 'https:',
        },
      };

      try {
        const client = new TetherClient('browser-loc-test');
        clientsToClose.push(client);

        // @ts-expect-error - inspecting internal auth
        expect(client.auth.baseUrl).toBe('https://app.mycompany.internal:3000');
      } finally {
        // @ts-expect-error - cleanup browser simulation
        delete globalThis.window;
      }
    });

    it('should wire sync onTokenRefresh and onAuthError callbacks to auth coordinator', () => {
      const client = new TetherClient('callbacks-test');
      clientsToClose.push(client);

      // @ts-expect-error - inspecting internal auth
      const refreshSpy = vi.spyOn(client.auth, 'handleTokenRefresh');
      // @ts-expect-error - inspecting internal auth
      const authErrorSpy = vi.spyOn(client.auth, 'handleAuthError');

      // @ts-expect-error - inspecting internal sync
      client.sync.options.onTokenRefresh?.('new-jwt');
      expect(refreshSpy).toHaveBeenCalledWith('new-jwt');

      // @ts-expect-error - inspecting internal sync
      client.sync.options.onAuthError?.('Session revoked');
      expect(authErrorSpy).toHaveBeenCalledWith('Session revoked');
    });

    it('should create table with declarative indexes through TetherClient.table()', async () => {
      const client = new TetherClient(
        `client-idx-${Math.random().toString(36).substring(2, 8)}`,
      );
      clientsToClose.push(client);

      const byEmail = new Index<string>('byEmail', 'email', { unique: true });
      const users = client.table<{ email: string; name: string }>('users', [
        byEmail,
      ]);

      await users.put('u1', { email: 'alice@example.com', name: 'Alice' });

      const indexed = users.index(byEmail);
      const user = await indexed.get('alice@example.com');
      expect(user).toEqual({ email: 'alice@example.com', name: 'Alice' });
    });
  });
});
