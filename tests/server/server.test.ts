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

    describe('declareApp', () => {
      it('should declare an app and its tables', async () => {
        await server.declareApp('todo-app', ['tasks', 'categories']);

        const app = await server.storage.getApp('todo-app');
        expect(app).toBeDefined();
        expect(app?.id).toBe('todo-app');

        const tasksTable = await app?.getTable('tasks');
        expect(tasksTable).toBeDefined();
        expect(tasksTable?.name).toBe('tasks');

        const categoriesTable = await app?.getTable('categories');
        expect(categoriesTable).toBeDefined();
        expect(categoriesTable?.name).toBe('categories');
      });

      it('should idempotently handle repeated declareApp calls and append new tables', async () => {
        await server.declareApp('my-app', ['t1']);
        await server.declareApp('my-app', ['t1', 't2']);

        const app = await server.storage.getApp('my-app');
        expect(app).toBeDefined();
        const tables = await app?.getTables();
        expect(tables?.map((t) => t.name).sort()).toEqual(['t1', 't2']);
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
        expect(json.error).toBe('Invalid JSON payload.');
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
    });
  },
);
