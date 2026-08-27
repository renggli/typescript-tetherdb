import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/errors.js';
import { TetherServer } from '../../src/server/server.js';
import { type StorageContext, storageDescriptors } from './storage/matrix.js';

describe.each(storageDescriptors)(
  'TetherServer ($name)',
  ({ createBackend }) => {
    let server: TetherServer;
    let storageContext: StorageContext;

    beforeEach(async () => {
      storageContext = await createBackend();
      server = new TetherServer({ storage: storageContext.storage });
    });

    afterEach(async () => {
      await server.close();
      await storageContext.cleanup();
    });

    describe('declareTable', () => {
      it('should declare a table and configure its settings', async () => {
        await server.declareTable('tasks', { maxRecords: 500 });

        const table = await server.storage.getTable('tasks');
        expect(table).toBeDefined();
        expect(table?.name).toBe('tasks');
        expect(table?.settings.maxRecords).toBe(500);
      });

      it('should idempotently handle repeated declareTable calls and update settings', async () => {
        await server.declareTable('my-table', { maxRecords: 100 });
        await server.declareTable('my-table', { maxRecords: 200 });

        const table = await server.storage.getTable('my-table');
        expect(table).toBeDefined();
        expect(table?.settings.maxRecords).toBe(200);
      });
    });

    describe('declareUser', () => {
      it('should create a new user if not already registered', async () => {
        const user = await server.declareUser('alice', 'initial_pass_123');

        expect(user).toBeDefined();
        expect(user.id).toBeDefined();
        expect(user.username).toBe('alice');

        expect(await user.verifyPassword('initial_pass_123')).toBe(true);
        expect(await user.verifyPassword('wrong_password')).toBe(false);

        const retrieved = await server.storage.getUserByUsername('alice');
        expect(retrieved?.id).toBe(user.id);
      });

      it('should update the password of an existing user and keep the same user id', async () => {
        const initialUser = await server.declareUser('bobby', 'password_v1');
        expect(initialUser.username).toBe('bobby');
        expect(await initialUser.verifyPassword('password_v1')).toBe(true);

        const updatedUser = await server.declareUser('bobby', 'password_v2');
        expect(updatedUser.id).toBe(initialUser.id);
        expect(updatedUser.username).toBe('bobby');

        // Verify old password fails and new password works
        expect(await updatedUser.verifyPassword('password_v1')).toBe(false);
        expect(await updatedUser.verifyPassword('password_v2')).toBe(true);

        // Verify through storage lookup
        const retrieved = await server.storage.getUserByUsername('bobby');
        expect(retrieved).toBeDefined();
        expect(await retrieved?.verifyPassword('password_v1')).toBe(false);
        expect(await retrieved?.verifyPassword('password_v2')).toBe(true);
      });

      it('should allow authenticating via HTTP endpoints after declareUser', async () => {
        await server.declareUser('evelyn', 'evelyn_secret_pwd');
        const httpServer: http.Server = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        // Try logging in via HTTP
        const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'evelyn',
            password: 'evelyn_secret_pwd',
          }),
        });

        expect(res.status).toBe(200);
        const data = (await res.json()) as {
          userId: string;
          username: string;
          token: string;
        };
        expect(data.username).toBe('evelyn');
        expect(data.token).toBeDefined();

        // Change password via declareUser
        await server.declareUser('evelyn', 'evelyn_new_pwd');

        // Old password should fail login
        const failRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'evelyn',
            password: 'evelyn_secret_pwd',
          }),
        });
        expect(failRes.status).toBe(401);

        // New password should succeed login
        const successRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'evelyn',
            password: 'evelyn_new_pwd',
          }),
        });
        expect(successRes.status).toBe(200);
        const successData = (await successRes.json()) as {
          userId: string;
          username: string;
          token: string;
        };
        expect(successData.userId).toBe(data.userId);
      });
    });

    describe('TetherServerOptions (basePath & webSocketPath)', () => {
      it('should default basePath to empty string and webSocketPath to /sync', async () => {
        expect(server.basePath).toBe('');
        expect(server.webSocketPath).toBe('/sync');
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'default_path_user',
            password: 'password123',
          }),
        });
        expect(res.status).toBe(201);
        const data = (await res.json()) as { username: string };
        expect(data.username).toBe('default_path_user');
      });

      it('should prefix all REST endpoints and default WebSocket path when basePath is configured', async () => {
        const customCtx = await createBackend();
        const customServer = new TetherServer({
          basePath: '/api/v1',
          storage: customCtx.storage,
        });
        expect(customServer.basePath).toBe('/api/v1');
        expect(customServer.webSocketPath).toBe('/api/v1/sync');

        const httpServer = await customServer.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        try {
          // Register on root path should return 404 when basePath is /api/v1
          const rootRes = await fetch(
            `http://127.0.0.1:${port}/auth/register`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: 'pathuser',
                password: 'pathpassword123',
              }),
            },
          );
          expect(rootRes.status).toBe(404);

          // Register user on custom base path
          const regRes = await fetch(
            `http://127.0.0.1:${port}/api/v1/auth/register`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: 'pathuser',
                password: 'pathpassword123',
              }),
            },
          );
          expect(regRes.status).toBe(201);
          const regData = (await regRes.json()) as {
            username: string;
            token: string;
          };
          expect(regData.username).toBe('pathuser');

          // Login user on custom base path
          const loginRes = await fetch(
            `http://127.0.0.1:${port}/api/v1/auth/login`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: 'pathuser',
                password: 'pathpassword123',
              }),
            },
          );
          expect(loginRes.status).toBe(200);
        } finally {
          await customServer.close();
          await customCtx.cleanup();
        }
      });

      it('should support explicit custom webSocketPath', () => {
        const customWsServer = new TetherServer({
          basePath: '/api',
          webSocketPath: '/custom-sync-channel',
        });
        expect(customWsServer.basePath).toBe('/api');
        expect(customWsServer.webSocketPath).toBe('/custom-sync-channel');
      });

      it('should normalize paths with missing leading slash and trailing slashes', () => {
        const s1 = new TetherServer({ basePath: 'api' });
        expect(s1.basePath).toBe('/api');
        expect(s1.webSocketPath).toBe('/api/sync');

        const s2 = new TetherServer({ basePath: '/api/' });
        expect(s2.basePath).toBe('/api');
        expect(s2.webSocketPath).toBe('/api/sync');

        const s3 = new TetherServer({ basePath: '/' });
        expect(s3.basePath).toBe('');
        expect(s3.webSocketPath).toBe('/sync');

        const s4 = new TetherServer({ basePath: '' });
        expect(s4.basePath).toBe('');
        expect(s4.webSocketPath).toBe('/sync');
      });
    });

    describe('startServer and HTTP Error Mapping', () => {
      it('should fall back to process.env.PORT in startServer', async () => {
        const originalPort = process.env.PORT;
        process.env.PORT = '0';

        try {
          const { startServer } = await import('../../src/server/server.js');
          const running = await startServer({
            host: '127.0.0.1',
            storage: storageContext.storage,
          });
          expect(running.port).toBeGreaterThan(0);
          await running.close();
        } finally {
          process.env.PORT = originalPort;
        }
      });

      it('should return 400 for malformed JSON request bodies', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid-non-json{',
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { error: string };
        expect(json.error).toBe('Invalid JSON payload');
      });

      it('should return 404 for unknown HTTP methods or routes', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        const res = await fetch(`http://127.0.0.1:${port}/unknown-route`, {
          method: 'GET',
        });
        expect(res.status).toBe(404);

        const postRes = await fetch(`http://127.0.0.1:${port}/unknown-route`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        expect(postRes.status).toBe(404);
      });

      it('should map various TetherServerErrors and unexpected errors to correct HTTP status codes', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        // Mock storage.createUser to throw LimitExceeded
        const createSpy = vi
          .spyOn(server.storage, 'createUser')
          .mockRejectedValueOnce(
            new TetherServerError(
              TetherServerErrorCode.LimitExceeded,
              'User limit reached',
            ),
          );

        const limitRes = await fetch(`http://127.0.0.1:${port}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'validuser',
            password: 'password123',
          }),
        });
        expect(limitRes.status).toBe(413);

        // Mock storage.createUser to throw InternalError
        createSpy.mockRejectedValueOnce(
          new TetherServerError(
            TetherServerErrorCode.InternalError,
            'Disk failure',
          ),
        );
        const internalRes = await fetch(
          `http://127.0.0.1:${port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'validuser',
              password: 'password123',
            }),
          },
        );
        expect(internalRes.status).toBe(500);

        // Mock storage.createUser to throw Unauthorized
        createSpy.mockRejectedValueOnce(
          new TetherServerError(
            TetherServerErrorCode.Unauthorized,
            'Unauthorized action',
          ),
        );
        const unauthRes = await fetch(
          `http://127.0.0.1:${port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'validuser',
              password: 'password123',
            }),
          },
        );
        expect(unauthRes.status).toBe(401);

        // Mock storage.createUser to throw NotFound
        createSpy.mockRejectedValueOnce(
          new TetherServerError(
            TetherServerErrorCode.NotFound,
            'Resource not found',
          ),
        );
        const notFoundRes = await fetch(
          `http://127.0.0.1:${port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'validuser',
              password: 'password123',
            }),
          },
        );
        expect(notFoundRes.status).toBe(404);

        // Mock storage.createUser to throw AlreadyExists
        createSpy.mockRejectedValueOnce(
          new TetherServerError(
            TetherServerErrorCode.AlreadyExists,
            'User already exists',
          ),
        );
        const existsRes = await fetch(
          `http://127.0.0.1:${port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'validuser',
              password: 'password123',
            }),
          },
        );
        expect(existsRes.status).toBe(409);

        // Mock storage.createUser to throw generic non-TetherServerError
        createSpy.mockRejectedValueOnce(
          new Error('Unexpected runtime exception'),
        );
        const genericRes = await fetch(
          `http://127.0.0.1:${port}/auth/register`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'validuser',
              password: 'password123',
            }),
          },
        );
        expect(genericRes.status).toBe(500);

        createSpy.mockRestore();
      });

      it('should handle /health, /ready, and /metrics endpoints', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address() as { port: number };
        const port = addr.port;

        // Test /health
        const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
        expect(healthRes.status).toBe(200);
        const healthData = (await healthRes.json()) as {
          status: string;
          uptime: number;
        };
        expect(healthData.status).toBe('ok');
        expect(typeof healthData.uptime).toBe('number');

        // Test /ready
        const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
        expect(readyRes.status).toBe(200);
        const readyData = (await readyRes.json()) as { status: string };
        expect(readyData.status).toBe('ready');

        // Test /metrics
        const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`);
        expect(metricsRes.status).toBe(200);
        const metricsData = (await metricsRes.json()) as {
          status?: string;
          uptime: number;
          connectedClients: number;
          appsCount: number;
          memoryUsage: { rss: number };
        };
        expect(metricsData.connectedClients).toBe(0);
        expect(typeof metricsData.tablesCount).toBe('number');
        expect(metricsData.memoryUsage?.rss).toBeGreaterThan(0);
      });

      it('should handle unready storage on /ready and return 503', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address() as { port: number };
        const port = addr.port;

        const getTablesSpy = vi
          .spyOn(server.storage, 'getTables')
          .mockRejectedValueOnce(new Error('Disk read failure'));

        const res = await fetch(`http://127.0.0.1:${port}/ready`);
        expect(res.status).toBe(503);
        const data = (await res.json()) as { status: string; error: string };
        expect(data.status).toBe('unready');
        expect(data.error).toBe('Disk read failure');

        getTablesSpy.mockRestore();
      });

      it('should return 404 for invalid HTTP methods on observability endpoints', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address() as { port: number };
        const port = addr.port;

        const postHealth = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'POST',
        });
        expect(postHealth.status).toBe(404);

        const deleteReady = await fetch(`http://127.0.0.1:${port}/ready`, {
          method: 'DELETE',
        });
        expect(deleteReady.status).toBe(404);

        const putMetrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
          method: 'PUT',
        });
        expect(putMetrics.status).toBe(404);
      });
    });

    describe('Auth Endpoint Protection & Rate Limiting', () => {
      it('should return 404 Not found when allowRegistration is false', async () => {
        const noRegServer = new TetherServer({
          allowRegistration: false,
        });
        const httpServer = await noRegServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          const res = await fetch(`http://127.0.0.1:${port}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'new_user',
              password: 'secure_password_123',
            }),
          });
          expect(res.status).toBe(404);
          const data = (await res.json()) as { error: string };
          expect(data.error).toBe('Not found');
        } finally {
          await noRegServer.close();
        }
      });

      it('should enforce registration rate limits and return 429', async () => {
        const limitedServer = new TetherServer({
          rateLimiting: {
            ipRegisterMaxRequests: 2,
          },
        });
        const httpServer = await limitedServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // 1st registration -> 201
          const res1 = await fetch(`http://127.0.0.1:${port}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'reg_user1',
              password: 'password1',
            }),
          });
          expect(res1.status).toBe(201);

          // 2nd registration -> 201
          const res2 = await fetch(`http://127.0.0.1:${port}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'reg_user2',
              password: 'password2',
            }),
          });
          expect(res2.status).toBe(201);

          // 3rd registration (exceeds limit) -> 429
          const res3 = await fetch(`http://127.0.0.1:${port}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'reg_user3',
              password: 'password3',
            }),
          });
          expect(res3.status).toBe(429);
          const data = (await res3.json()) as { error: string };
          expect(data.error).toContain('Too many registration requests');
        } finally {
          await limitedServer.close();
        }
      });

      it('should apply progressive backoff on repeated failed logins', async () => {
        const limitedServer = new TetherServer({
          rateLimiting: {
            maxFailures: 2,
            initialBackoffMs: 2_000,
          },
        });
        await limitedServer.declareUser('target_user', 'correct_password');
        const httpServer = await limitedServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // 1st failed attempt -> 401
          const res1 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'wrong_password_1',
            }),
          });
          expect(res1.status).toBe(401);

          // 2nd failed attempt (hits maxFailures=2) -> 401 and triggers backoff
          const res2 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'wrong_password_2',
            }),
          });
          expect(res2.status).toBe(401);

          // 3rd attempt while under cooldown -> 429 Too Many Requests
          const res3 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'correct_password',
            }),
          });
          expect(res3.status).toBe(429);
        } finally {
          await limitedServer.close();
        }
      });

      it('should isolate account login lockout per IP to prevent unauthenticated DoS', async () => {
        const limitedServer = new TetherServer({
          trustProxy: true,
          rateLimiting: {
            ipLoginMaxRequests: 100,
            userLoginMaxRequests: 2,
            maxFailures: 2,
            initialBackoffMs: 10_000,
          },
        });
        await limitedServer.declareUser('target_user', 'correct_password');
        const httpServer = await limitedServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // Attacker from IP 198.51.100.1 spams failed passwords for target_user
          for (let i = 0; i < 2; i++) {
            const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.1',
              },
              body: JSON.stringify({
                username: 'target_user',
                password: 'wrong_password',
              }),
            });
            expect(res.status).toBe(401);
          }

          // Attacker from IP 198.51.100.1 is now locked out (429)
          const attackerRes = await fetch(
            `http://127.0.0.1:${port}/auth/login`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '198.51.100.1',
              },
              body: JSON.stringify({
                username: 'target_user',
                password: 'correct_password',
              }),
            },
          );
          expect(attackerRes.status).toBe(429);

          // Legitimate user from IP 203.0.113.50 can still log in successfully
          const legitRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '203.0.113.50',
            },
            body: JSON.stringify({
              username: 'target_user',
              password: 'correct_password',
            }),
          });
          expect(legitRes.status).toBe(200);
        } finally {
          await limitedServer.close();
        }
      });

      it('should reset failure tracking on valid login', async () => {
        const limitedServer = new TetherServer({
          rateLimiting: {
            maxFailures: 3,
            initialBackoffMs: 2_000,
          },
        });
        await limitedServer.declareUser('alice_user', 'correct_password');
        const httpServer = await limitedServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // 1 failed attempt
          const res1 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'alice_user',
              password: 'wrong_password',
            }),
          });
          expect(res1.status).toBe(401);

          // 1 successful login -> resets failure counter
          const res2 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'alice_user',
              password: 'correct_password',
            }),
          });
          expect(res2.status).toBe(200);

          // Verify failure count is reset: a subsequent single bad password gives 401 instead of 429 backoff
          const res3 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'alice_user',
              password: 'wrong_password_again',
            }),
          });
          expect(res3.status).toBe(401);
        } finally {
          await limitedServer.close();
        }
      });

      it('should ignore X-Forwarded-For when trustProxy is false (default)', async () => {
        const limitedServer = new TetherServer({
          rateLimiting: {
            ipLoginMaxRequests: 2,
          },
        });
        await limitedServer.declareUser('bob_user', 'correct_password');
        const httpServer = await limitedServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // Attempt 1 with spoofed IP header
          const res1 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '198.51.100.1',
            },
            body: JSON.stringify({
              username: 'bob_user',
              password: 'wrong_password',
            }),
          });
          expect(res1.status).toBe(401);

          // Attempt 2 with another spoofed IP header
          const res2 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '198.51.100.2',
            },
            body: JSON.stringify({
              username: 'bob_user',
              password: 'wrong_password',
            }),
          });
          expect(res2.status).toBe(401);

          // Attempt 3 with yet another spoofed IP header: rate limiter (scoped to actual socket IP 127.0.0.1) blocks it
          const res3 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '198.51.100.3',
            },
            body: JSON.stringify({
              username: 'bob_user',
              password: 'wrong_password',
            }),
          });
          expect(res3.status).toBe(429);
        } finally {
          await limitedServer.close();
        }
      });

      it('should respect X-Forwarded-For when trustProxy is true', async () => {
        const proxyServer = new TetherServer({
          trustProxy: true,
          rateLimiting: {
            ipLoginMaxRequests: 2,
            userLoginMaxRequests: 100,
          },
        });
        await proxyServer.declareUser('charlie_user', 'correct_password');
        const httpServer = await proxyServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // Send 2 requests from IP A
          for (let i = 0; i < 2; i++) {
            const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-For': '203.0.113.195',
              },
              body: JSON.stringify({
                username: 'charlie_user',
                password: 'wrong_password',
              }),
            });
            expect(res.status).toBe(401);
          }

          // 3rd request from IP A is rate limited
          const resA3 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '203.0.113.195',
            },
            body: JSON.stringify({
              username: 'charlie_user',
              password: 'wrong_password',
            }),
          });
          expect(resA3.status).toBe(429);

          // Request from IP B is allowed
          const resB = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': '203.0.113.196',
            },
            body: JSON.stringify({
              username: 'charlie_user',
              password: 'wrong_password',
            }),
          });
          expect(resB.status).toBe(401);
        } finally {
          await proxyServer.close();
        }
      });

      it('should rate limit per target username when userLoginMaxRequests is exceeded', async () => {
        const userLimiterServer = new TetherServer({
          storage: storageContext.storage,
          rateLimiting: {
            ipLoginMaxRequests: 100,
            userLoginMaxRequests: 2,
          },
        });
        await userLimiterServer.declareUser('target_user', 'correct_pass');
        const httpServer = await userLimiterServer.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        try {
          // Attempt 1: 401
          const res1 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'wrong_password',
            }),
          });
          expect(res1.status).toBe(401);

          // Attempt 2: 401
          const res2 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'wrong_password',
            }),
          });
          expect(res2.status).toBe(401);

          // Attempt 3: 429 Too many login attempts for this account
          const res3 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'target_user',
              password: 'wrong_password',
            }),
          });
          expect(res3.status).toBe(429);
          const data3 = (await res3.json()) as { error: string };
          expect(data3.error).toBe('Too many login attempts for this account');
        } finally {
          await userLimiterServer.close();
        }
      });
    });

    describe('CORS Configuration', () => {
      it('should return default permissive CORS headers when not configured', async () => {
        const running = await server.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain(
          'GET',
        );
      });

      it('should respect custom string origin', async () => {
        const corsServer = new TetherServer({
          storage: storageContext.storage,
          cors: { origin: 'https://trusted.app' },
        });
        const running = await corsServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: 'https://trusted.app' },
          });
          expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'https://trusted.app',
          );
          expect(res.headers.get('Vary')).toBe('Origin');
        } finally {
          await corsServer.close();
        }
      });

      it('should match origin against an array of allowed origins', async () => {
        const corsServer = new TetherServer({
          storage: storageContext.storage,
          cors: {
            origin: ['https://app1.example.com', 'https://app2.example.com'],
          },
        });
        const running = await corsServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          // Allowed origin
          const resAllowed = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: 'https://app2.example.com' },
          });
          expect(resAllowed.headers.get('Access-Control-Allow-Origin')).toBe(
            'https://app2.example.com',
          );

          // Disallowed origin
          const resDenied = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: 'https://malicious.com' },
          });
          expect(
            resDenied.headers.get('Access-Control-Allow-Origin'),
          ).toBeNull();
        } finally {
          await corsServer.close();
        }
      });

      it('should handle credentials, exposedHeaders, and maxAge on OPTIONS preflight', async () => {
        const corsServer = new TetherServer({
          storage: storageContext.storage,
          cors: {
            origin: true,
            credentials: true,
            allowedHeaders: ['X-Custom-Header', 'Content-Type'],
            exposedHeaders: ['X-Total-Count'],
            maxAge: 3600,
          },
        });
        const running = await corsServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://myclient.com' },
          });
          expect(res.status).toBe(204);
          expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
            'https://myclient.com',
          );
          expect(res.headers.get('Access-Control-Allow-Credentials')).toBe(
            'true',
          );
          expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
            'X-Custom-Header, Content-Type',
          );
          expect(res.headers.get('Access-Control-Expose-Headers')).toBe(
            'X-Total-Count',
          );
          expect(res.headers.get('Access-Control-Max-Age')).toBe('3600');
        } finally {
          await corsServer.close();
        }
      });

      it('should disable CORS headers when cors is false', async () => {
        const corsServer = new TetherServer({
          storage: storageContext.storage,
          cors: false,
        });
        const running = await corsServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Origin: 'https://client.com' },
          });
          expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
        } finally {
          await corsServer.close();
        }
      });
    });

    describe('Logger Integration', () => {
      it('should accept custom logger and receive debug logs on client errors and error logs on 500', async () => {
        const mockLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        };

        const loggedServer = new TetherServer({
          storage: storageContext.storage,
          logger: mockLogger,
        });
        const running = await loggedServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          // Send invalid JSON to trigger 400 debug log
          const res400 = await fetch(`http://127.0.0.1:${port}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{invalid-json',
          });
          expect(res400.status).toBe(400);
          expect(mockLogger.debug).toHaveBeenCalled();

          // Mock an unexpected internal error to trigger 500 error log
          vi.spyOn(loggedServer.storage, 'createUser').mockRejectedValueOnce(
            new Error('Database disk failure'),
          );
          const res500 = await fetch(`http://127.0.0.1:${port}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'testuser',
              password: 'password123',
            }),
          });
          expect(res500.status).toBe(500);
          expect(mockLogger.error).toHaveBeenCalled();
        } finally {
          await loggedServer.close();
        }
      });

      it('should support logger: false to silence logs completely', async () => {
        const silentServer = new TetherServer({
          storage: storageContext.storage,
          logger: false,
        });
        const running = await silentServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          expect(res.status).toBe(200);
        } finally {
          await silentServer.close();
        }
      });
    });

    describe('Admin API (/admin/*)', () => {
      it('should require admin authorization header for all admin routes', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;

        // No auth header
        const resNoAuth = await fetch(`http://127.0.0.1:${port}/admin/tables`);
        expect(resNoAuth.status).toBe(401);

        // Wrong secret
        const resBadAuth = await fetch(
          `http://127.0.0.1:${port}/admin/tables`,
          {
            headers: { Authorization: 'Bearer wrong-secret' },
          },
        );
        expect(resBadAuth.status).toBe(401);
      });

      it('should manage tables, users, records, and maintenance via admin API', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const port = (httpServer.address() as { port: number }).port;
        const authHeader = {
          Authorization: `Bearer ${server.adminSecret}`,
          'Content-Type': 'application/json',
        };

        // 1. Create table via POST /admin/tables
        const createTableRes = await fetch(
          `http://127.0.0.1:${port}/admin/tables`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              name: 'customers',
              settings: { maxRecords: 100 },
            }),
          },
        );
        expect(createTableRes.status).toBe(201);
        const tableData = (await createTableRes.json()) as { name: string };
        expect(tableData.name).toBe('customers');

        // 2. List tables via GET /admin/tables
        const listTablesRes = await fetch(
          `http://127.0.0.1:${port}/admin/tables`,
          {
            headers: authHeader,
          },
        );
        expect(listTablesRes.status).toBe(200);
        const tablesList = (await listTablesRes.json()) as Array<{
          name: string;
        }>;
        expect(tablesList.some((t) => t.name === 'customers')).toBe(true);

        // 3. Create user via POST /admin/users
        const createUserRes = await fetch(
          `http://127.0.0.1:${port}/admin/users`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              username: 'admin_created_user',
              password: 'password123',
            }),
          },
        );
        expect(createUserRes.status).toBe(201);
        const userData = (await createUserRes.json()) as {
          id: string;
          username: string;
        };
        expect(userData.username).toBe('admin_created_user');

        // 4. Put record via POST /admin/records
        const putRecordRes = await fetch(
          `http://127.0.0.1:${port}/admin/records`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              table: 'customers',
              id: 'c1',
              data: { name: 'Acme Corp' },
              userId: userData.id,
            }),
          },
        );
        expect(putRecordRes.status).toBe(200);

        // 5. Query records via GET /admin/records
        const getRecordsRes = await fetch(
          `http://127.0.0.1:${port}/admin/records?table=customers&userId=${userData.id}`,
          {
            headers: authHeader,
          },
        );
        expect(getRecordsRes.status).toBe(200);
        const records = (await getRecordsRes.json()) as Array<{
          id: string;
          data: { name: string };
        }>;
        expect(records).toHaveLength(1);
        expect(records[0].data.name).toBe('Acme Corp');

        // 6. Get status via GET /admin/status
        const statusRes = await fetch(`http://127.0.0.1:${port}/admin/status`, {
          headers: authHeader,
        });
        expect(statusRes.status).toBe(200);
        const status = (await statusRes.json()) as {
          backend: string;
          tablesCount: number;
        };
        expect(status.tablesCount).toBeGreaterThanOrEqual(1);

        // 7. Prune via POST /admin/maintenance
        const maintRes = await fetch(
          `http://127.0.0.1:${port}/admin/maintenance`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({ action: 'prune', keepCount: 10 }),
          },
        );
        expect(maintRes.status).toBe(200);
      });
    });
  },
);

describe('TetherServer Standalone Lifecycle & Error Mapping', () => {
  it('should map TetherServerErrorCode.NotSupported to HTTP 501', async () => {
    const server = new TetherServer();
    vi.spyOn(server.storage, 'getTables').mockRejectedValueOnce(
      new TetherServerError(
        TetherServerErrorCode.NotSupported,
        'Feature not implemented',
      ),
    );

    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(501);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Feature not implemented');
    } finally {
      await server.close();
    }
  });

  it('should verify dummy password hash on login when user does not exist', async () => {
    const server = new TetherServer();
    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'non_existent_user',
          password: 'some_password',
        }),
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Invalid username or password');
    } finally {
      await server.close();
    }
  });

  it('should handle listen errors when port is already occupied', async () => {
    const server1 = new TetherServer();
    const running1 = await server1.listen(0, '127.0.0.1');
    const boundPort = (running1.address() as { port: number }).port;

    const server2 = new TetherServer();
    try {
      await expect(server2.listen(boundPort, '127.0.0.1')).rejects.toThrow();
    } finally {
      await server1.close();
      try {
        await server2.close();
      } catch {
        // Expected if server2 never started listening
      }
    }
  });

  it('should return 400 when registration or login request is missing required fields', async () => {
    const server = new TetherServer();
    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      // Register missing password
      const resReg = await fetch(`http://127.0.0.1:${port}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'only_username' }),
      });
      expect(resReg.status).toBe(400);

      // Login missing username
      const resLog = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'only_password' }),
      });
      expect(resLog.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('should return 413 when JSON payload exceeds 1MB limit', async () => {
    const server = new TetherServer();
    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      const hugeString = 'a'.repeat(1024 * 1024 + 100);
      const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'huge_user',
          password: hugeString,
        }),
      });
      expect(res.status).toBe(413);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Payload exceeds maximum allowed size');
    } finally {
      await server.close();
    }
  });

  it('should support startServer with PORT environment variable fallback', async () => {
    const { startServer } = await import('../../src/server/server.js');
    const originalPort = process.env.PORT;
    process.env.PORT = '0';

    try {
      const running = await startServer({ host: '127.0.0.1' });
      expect(running.port).toBeGreaterThan(0);
      expect(running.host).toBe('127.0.0.1');
      await running.close();
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  describe('createMiddleware', () => {
    it('should handle matching HTTP routes and delegate non-matching routes via next()', async () => {
      const server = new TetherServer();
      const middleware = server.createMiddleware();
      let nextCalled = false;

      // 1. Non-matching route calls next()
      const reqNonMatching = {
        url: '/api/other',
        method: 'GET',
        headers: { host: 'localhost' },
      } as unknown as http.IncomingMessage;
      const resNonMatching = {} as unknown as http.ServerResponse;

      middleware(reqNonMatching, resNonMatching, () => {
        nextCalled = true;
      });

      // Wait a tick for promise resolution
      await new Promise((r) => setTimeout(r, 10));
      expect(nextCalled).toBe(true);

      // 2. Matching route handles response without calling next()
      let nextCalledForHealth = false;
      let writtenStatus = 0;
      let responseBody = '';
      const reqHealth = {
        url: '/health',
        method: 'GET',
        headers: { host: 'localhost' },
      } as unknown as http.IncomingMessage;
      const resHealth = {
        writeHead(status: number) {
          writtenStatus = status;
          return this;
        },
        end(data: string) {
          responseBody = data;
        },
      } as unknown as http.ServerResponse;

      middleware(reqHealth, resHealth, () => {
        nextCalledForHealth = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(nextCalledForHealth).toBe(false);
      expect(writtenStatus).toBe(200);
      expect(JSON.parse(responseBody).status).toBe('ok');

      await server.close();
    });

    it('should support server.handleRequest alias directly', async () => {
      const server = new TetherServer();
      let status = 0;
      let body = '';
      const req = {
        url: '/health',
        method: 'GET',
        headers: { host: 'localhost' },
      } as unknown as http.IncomingMessage;
      const res = {
        writeHead(s: number) {
          status = s;
          return this;
        },
        end(data: string) {
          body = data;
        },
      } as unknown as http.ServerResponse;

      const handled = await server.handleRequest(req, res);
      expect(handled).toBe(true);
      expect(status).toBe(200);
      expect(JSON.parse(body).status).toBe('ok');

      await server.close();
    });
  });
});
