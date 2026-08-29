import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Auth,
  AuthStatus,
  DataMode,
  type StoredAuthSession,
} from '../../src/client/auth.js';
import {
  TetherClientError,
  TetherClientErrorCode,
} from '../../src/client/errors.js';
import { Storage } from '../../src/client/storage.js';

describe('Auth', () => {
  let storage: Storage;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storage = new Storage(
      `test-auth-${Math.random().toString(36).substring(2, 8)}`,
    );
    mockFetch = vi.fn();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('should initialize with SignedOut status and undefined credentials', () => {
    const auth = new Auth(storage, {
      baseUrl: 'http://127.0.0.1:8080',
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(auth.baseUrl).toBe('http://127.0.0.1:8080');
    expect(auth.status).toBe(AuthStatus.SignedOut);
    expect(auth.userName).toBeUndefined();
    expect(auth.token).toBeUndefined();
  });

  it('should throw an error if no fetch implementation is available', () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error - simulating environment without fetch
    delete globalThis.fetch;

    try {
      expect(
        () =>
          new Auth(storage, {
            baseUrl: 'http://localhost',
          }),
      ).toThrow(TetherClientError);
      try {
        new Auth(storage, {
          baseUrl: 'http://localhost',
        });
      } catch (err) {
        expect((err as TetherClientError).code).toBe(
          TetherClientErrorCode.FetchUnavailable,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe('Session Restoration (restoreSession)', () => {
    it('should automatically restore remembered session from IndexedDB metadata', async () => {
      await storage.setMeta('auth', {
        userName: 'alice',
        token: 'jwt-token-xyz',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.restoreSession();

      expect(auth.status).toBe(AuthStatus.SignedIn);
      expect(auth.userName).toBe('alice');
      expect(auth.token).toBe('jwt-token-xyz');
    });

    it('should remain SignedOut if stored session is missing token or userName', async () => {
      await storage.setMeta('auth', { userName: 'alice' }); // incomplete

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.restoreSession();
      expect(auth.status).toBe(AuthStatus.SignedOut);
    });

    it('should handle storage errors during restoreSession gracefully', async () => {
      const brokenStorage = new Storage('broken');
      vi.spyOn(brokenStorage, 'getMeta').mockRejectedValue(
        new Error('DB failure'),
      );

      const auth = new Auth(brokenStorage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(auth.restoreSession()).resolves.toBeUndefined();
      expect(auth.status).toBe(AuthStatus.SignedOut);
      await brokenStorage.close();
    });
  });

  describe('register', () => {
    it('should throw error when username or password is missing', async () => {
      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      // @ts-expect-error - testing invalid args
      await expect(auth.register({})).rejects.toThrow(TetherClientError);
      // @ts-expect-error - testing invalid args
      await expect(auth.register({})).rejects.toMatchObject({
        code: TetherClientErrorCode.MissingCredentials,
      });
    });

    it('should successfully register a user and update auth state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userName: 'charlie',
          token: 'token-abc',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const statuses: AuthStatus[] = [];
      auth.onStatusChange.register((s) => statuses.push(s));

      const success = await auth.register({
        userName: 'charlie',
        password: 'password123',
        remember: true,
      });

      expect(success).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedIn);
      expect(auth.userName).toBe('charlie');
      expect(auth.token).toBe('token-abc');

      expect(statuses).toEqual([AuthStatus.SigningIn, AuthStatus.SignedIn]);

      // Stored session in metadata
      const stored = await storage.getMeta<StoredAuthSession>('auth');
      expect(stored).toEqual({
        token: 'token-abc',
        userName: 'charlie',
      });
    });

    it('should delete meta auth when remember is false', async () => {
      await storage.setMeta('auth', { token: 'old-token' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userName: 'david',
          token: 'token-def',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const success = await auth.register({
        userName: 'david',
        password: 'password123',
        remember: false,
      });

      expect(success).toBe(true);
      expect(await storage.getMeta('auth')).toBeUndefined();
    });

    it('should preserve local data by default when registering from SignedOut state', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userName: 'guest_user',
          token: 'token-guest',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      expect(auth.status).toBe(AuthStatus.SignedOut);
      await auth.register({
        userName: 'guest_user',
        password: 'password123',
      });

      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('should clear local data by default when registering from an already SignedIn state', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      const setMetaSpy = vi.spyOn(storage, 'setMeta');
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          userName: 'new_user',
          token: 'token-new',
        }),
      });

      await storage.setMeta('auth', {
        userName: 'old_user',
        token: 'token-old',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.restoreSession();
      expect(auth.status).toBe(AuthStatus.SignedIn);

      await auth.register({
        userName: 'new_user',
        password: 'password123',
      });

      expect(clearSpy).toHaveBeenCalledWith(true);
      expect(setMetaSpy).toHaveBeenCalledWith('lastSyncSeq', 0);
    });

    it('should clear tables when DataMode.Clear is explicitly specified on register', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userName: 'eve',
          token: 'token-ghi',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.register({
        userName: 'eve',
        password: 'password123',
        dataMode: DataMode.Clear,
      });

      expect(clearSpy).toHaveBeenCalledWith(true);
    });

    it('should transition to AuthStatus.Error and return false when server returns error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Username already taken' }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const clearSpy = vi.spyOn(storage, 'clearTables');
      const success = await auth.register({
        userName: 'duplicate',
        password: 'password123',
        dataMode: DataMode.Clear,
      });

      expect(success).toBe(false);
      expect(auth.status).toBe(AuthStatus.Error);
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('should login with username and password and set state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          userName: 'frank',
          token: 'token-frank',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const success = await auth.login({
        userName: 'frank',
        password: 'password123',
        remember: true,
      });

      expect(success).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedIn);
      expect(auth.userName).toBe('frank');
      expect(auth.token).toBe('token-frank');

      const stored = await storage.getMeta<StoredAuthSession>('auth');
      expect(stored?.token).toBe('token-frank');
    });

    it('should login using remembered session when username/password not provided', async () => {
      await storage.setMeta('auth', {
        userName: 'grace',
        token: 'token-grace',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const success = await auth.login();
      expect(success).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedIn);
      expect(auth.userName).toBe('grace');
      expect(auth.token).toBe('token-grace');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fail login if no credentials and no saved session exist', async () => {
      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const success = await auth.login({});
      expect(success).toBe(false);
      expect(auth.status).toBe(AuthStatus.Error);
    });

    it('should default to DataMode.Remote on login and reset lastSyncSeq', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      const setMetaSpy = vi.spyOn(storage, 'setMeta');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          userName: 'u',
          token: 't',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.login({ userName: 'u', password: 'p' });
      expect(clearSpy).toHaveBeenCalledWith(true);
      expect(setMetaSpy).toHaveBeenCalledWith('lastSyncSeq', 0);
    });

    it('should handle DataMode.Clear and DataMode.Merge on login', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      const setMetaSpy = vi.spyOn(storage, 'setMeta');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          userName: 'u',
          token: 't',
        }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      // DataMode.Clear
      await auth.login({
        userName: 'u',
        password: 'p',
        dataMode: DataMode.Clear,
      });
      expect(clearSpy).toHaveBeenCalledWith(true);

      // DataMode.Merge
      clearSpy.mockClear();
      setMetaSpy.mockClear();
      await auth.login({
        userName: 'u',
        password: 'p',
        dataMode: DataMode.Merge,
      });
      expect(clearSpy).not.toHaveBeenCalled();
      expect(setMetaSpy).toHaveBeenCalledWith('lastSyncSeq', 0);
    });

    it('should handle HTTP failure during login', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Invalid password' }),
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const success = await auth.login({ userName: 'u', password: 'bad' });
      expect(success).toBe(false);
      expect(auth.status).toBe(AuthStatus.Error);
    });
  });

  describe('logout', () => {
    it('should reset user credentials and transition to SignedOut', async () => {
      await storage.setMeta('auth', {
        token: 't1',
        userName: 'alice',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.restoreSession();
      expect(auth.status).toBe(AuthStatus.SignedIn);

      const statuses: AuthStatus[] = [];
      auth.onStatusChange.register((s) => statuses.push(s));

      const success = await auth.logout();
      expect(success).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedOut);
      expect(auth.userName).toBeUndefined();
      expect(auth.token).toBeUndefined();
      expect(await storage.getMeta('auth')).toBeUndefined();
      expect(statuses).toEqual([AuthStatus.SignedOut]);
    });

    it('should clear tables and reset lastSyncSeq by default on logout (DataMode.Clear)', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');
      const setMetaSpy = vi.spyOn(storage, 'setMeta');

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.logout();
      expect(clearSpy).toHaveBeenCalledWith(true);
      expect(setMetaSpy).toHaveBeenCalledWith('lastSyncSeq', 0);
    });

    it('should preserve tables on logout when DataMode.Local is requested', async () => {
      const clearSpy = vi.spyOn(storage, 'clearTables');

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.logout({ dataMode: DataMode.Local });
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  describe('Token Refresh and Auth Error Handling', () => {
    it('should handle token refresh in memory and update stored auth metadata', async () => {
      await storage.setMeta('auth', {
        token: 'old-token',
        userName: 'alice',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.restoreSession();

      await auth.handleTokenRefresh('new-refreshed-token');
      expect(auth.token).toBe('new-refreshed-token');

      const updated = await storage.getMeta<StoredAuthSession>('auth');
      expect(updated?.token).toBe('new-refreshed-token');
      expect(updated?.userName).toBe('alice');
    });

    it('should handle token refresh in memory even if no session was stored in metadata', async () => {
      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      await auth.handleTokenRefresh('refreshed-token-only');
      expect(auth.token).toBe('refreshed-token-only');
      expect(await storage.getMeta('auth')).toBeUndefined();
    });

    it('should handle auth error by clearing credentials, metadata, and setting SignedOut', async () => {
      await storage.setMeta('auth', {
        token: 'expired-token',
        userName: 'alice',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });
      await auth.restoreSession();
      expect(auth.status).toBe(AuthStatus.SignedIn);

      await auth.handleAuthError('Token expired');

      expect(auth.status).toBe(AuthStatus.SignedOut);
      expect(auth.userName).toBeUndefined();
      expect(auth.token).toBeUndefined();
      expect(await storage.getMeta('auth')).toBeUndefined();
    });

    it('should login using stored metadata session when no credentials are provided', async () => {
      await storage.setMeta('auth', {
        token: 'stored-valid-token',
        userName: 'saved_user',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await auth.login();
      expect(result).toBe(true);
      expect(auth.status).toBe(AuthStatus.SignedIn);
      expect(auth.token).toBe('stored-valid-token');
      expect(auth.userName).toBe('saved_user');
    });

    it('should return false when login() is called without credentials or stored session', async () => {
      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await auth.login();
      expect(result).toBe(false);
      expect(auth.status).toBe(AuthStatus.Error);
    });

    it('should return false when stored metadata has no token', async () => {
      await storage.setMeta('auth', {
        userName: 'no_token_user',
      });

      const auth = new Auth(storage, {
        baseUrl: 'http://127.0.0.1:8080',
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await auth.login();
      expect(result).toBe(false);
      expect(auth.status).toBe(AuthStatus.Error);
    });
  });
});
