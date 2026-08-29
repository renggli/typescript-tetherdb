import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/errors.js';
import { startServer, TetherServer } from '../../src/server/server.js';
import { Permission, type TableRow } from '../../src/shared/types.js';
import { type StorageContext, storageDescriptors } from './storage/matrix.js';

describe.each(storageDescriptors)(
  'TetherServer HTTP & Admin API ($name)',
  ({ createBackend }) => {
    let storageContext: StorageContext;
    let server: TetherServer;

    beforeEach(async () => {
      storageContext = await createBackend();
      server = new TetherServer({
        storage: storageContext.storage,
        adminSecret: 'test-admin-secret-key-1234567890',
      });
    });

    afterEach(async () => {
      await server.close();
      await storageContext.cleanup();
    });

    describe('declareTable', () => {
      it('should create a new table with settings if it does not exist', async () => {
        const table = await server.declareTable('documents', {
          permissions: {
            read: Permission.Everybody,
            create: Permission.Authenticated,
            update: Permission.Owner,
            delete: Permission.Owner,
          },
        });

        expect(table.name).toBe('documents');
        expect(table.settings.permissions?.read).toBe(Permission.Everybody);

        const retrieved = await server.storage.getTable('documents');
        expect(retrieved).toBeDefined();
        expect(retrieved?.settings.permissions?.read).toBe(
          Permission.Everybody,
        );
      });

      it('should update settings on an existing table', async () => {
        await server.declareTable('notes', {
          permissions: { read: Permission.Owner },
        });

        const updated = await server.declareTable('notes', {
          permissions: { read: Permission.Everybody },
        });

        expect(updated.settings.permissions?.read).toBe(Permission.Everybody);

        const retrieved = await server.storage.getTable('notes');
        expect(retrieved?.settings.permissions?.read).toBe(
          Permission.Everybody,
        );
      });

      it('should populate initial rows on a newly created table', async () => {
        const rows: TableRow[] = [
          { id: 'item1', data: { title: 'First Post' } },
          { id: 'item2', data: { title: 'Second Post' } },
        ];

        const table = await server.declareTable(
          'posts',
          { permissions: { read: Permission.Everybody } },
          rows,
        );
        const records = await table.getAllRecords();

        expect(records).toHaveLength(2);
        expect(records.map((r) => r.id).sort()).toEqual(['item1', 'item2']);
      });

      it('should not duplicate existing rows when declaring table again', async () => {
        const rows: TableRow[] = [
          { id: 'cat1', data: { name: 'Electronics' } },
        ];

        await server.declareTable(
          'categories',
          { permissions: { read: Permission.Everybody } },
          rows,
        );
        await server.declareTable(
          'categories',
          { permissions: { read: Permission.Everybody } },
          [
            { id: 'cat1', data: { name: 'Electronics Updated' } },
            { id: 'cat2', data: { name: 'Books' } },
          ],
        );

        const table = await server.storage.getTable('categories');
        const records = await table?.getAllRecords();

        expect(records).toHaveLength(2);
        expect(records?.map((r) => r.id).sort()).toEqual(['cat1', 'cat2']);
      });
    });

    describe('declareUser', () => {
      it('should create a new user if not already present', async () => {
        const user = await server.declareUser('alice', 'password123');

        expect(user.userName).toBe('alice');
        expect(user.userId).toBeDefined();
        expect(await user.verifyPassword('password123')).toBe(true);
        expect(await user.verifyPassword('wrongPassword')).toBe(false);
      });

      it('should update password for an existing user without changing userId', async () => {
        const initialUser = await server.declareUser('bobby', 'password_v1');
        const updatedUser = await server.declareUser('bobby', 'password_v2');

        expect(updatedUser.userId).toBe(initialUser.userId);
        expect(updatedUser.userName).toBe('bobby');

        expect(await updatedUser.verifyPassword('password_v1')).toBe(false);
        expect(await updatedUser.verifyPassword('password_v2')).toBe(true);
      });
    });

    describe('TetherServerOptions (basePath & webSocketPath)', () => {
      it('should default basePath to empty string and webSocketPath to /tether', async () => {
        expect(server.basePath).toBe('');
        expect(server.webSocketPath).toBe('/tether');
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
      });

      it('should prefix all REST endpoints and default WebSocket path when basePath is configured', async () => {
        const customCtx = await createBackend();
        const customServer = new TetherServer({
          basePath: '/api/v1',
          storage: customCtx.storage,
        });
        expect(customServer.basePath).toBe('/api/v1');
        expect(customServer.webSocketPath).toBe('/api/v1/tether');

        const httpServer = await customServer.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        try {
          // Health on root path should return 404 when basePath is /api/v1
          const rootRes = await fetch(`http://127.0.0.1:${port}/health`);
          expect(rootRes.status).toBe(404);

          // Health on prefixed path /api/v1/health should succeed
          const prefixedRes = await fetch(
            `http://127.0.0.1:${port}/api/v1/health`,
          );
          expect(prefixedRes.status).toBe(200);
        } finally {
          await customServer.close();
          await customCtx.cleanup();
        }
      });

      it('should allow explicitly overriding webSocketPath', () => {
        const customWsServer = new TetherServer({
          basePath: '/api/v1',
          webSocketPath: '/custom-sync-channel',
        });
        expect(customWsServer.basePath).toBe('/api/v1');
        expect(customWsServer.webSocketPath).toBe('/custom-sync-channel');
      });

      it('should normalize paths with missing leading slash and trailing slashes', () => {
        const s1 = new TetherServer({ basePath: 'api' });
        expect(s1.basePath).toBe('/api');
        expect(s1.webSocketPath).toBe('/api/tether');

        const s2 = new TetherServer({ basePath: '/api/' });
        expect(s2.basePath).toBe('/api');
        expect(s2.webSocketPath).toBe('/api/tether');

        const s3 = new TetherServer({ basePath: '/' });
        expect(s3.basePath).toBe('');
        expect(s3.webSocketPath).toBe('/tether');

        const s4 = new TetherServer({ basePath: '' });
        expect(s4.basePath).toBe('');
        expect(s4.webSocketPath).toBe('/tether');
      });
    });

    describe('startServer and HTTP Error Mapping', () => {
      it('should fall back to process.env.PORT in startServer', async () => {
        const originalPort = process.env.PORT;
        process.env.PORT = '0';

        try {
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

      it('should return 400 for malformed JSON request bodies on admin endpoints', async () => {
        const httpServer = await server.listen(0, '127.0.0.1');
        const addr = httpServer.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8080;

        const res = await fetch(`http://127.0.0.1:${port}/admin/tables`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-admin-secret-key-1234567890',
          },
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
          tablesCount: number;
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

    describe('CORS Integration', () => {
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
          const res = await fetch(`http://127.0.0.1:${port}/admin/status`, {
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
          adminSecret: 'test-admin-secret',
        });
        const running = await loggedServer.listen(0, '127.0.0.1');
        const port = (running.address() as { port: number }).port;

        try {
          // Send invalid JSON to trigger 400 debug log
          const res400 = await fetch(`http://127.0.0.1:${port}/admin/tables`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer test-admin-secret',
            },
            body: '{invalid-json',
          });
          expect(res400.status).toBe(400);
          expect(mockLogger.debug).toHaveBeenCalled();

          // Mock an unexpected internal error to trigger 500 error log
          vi.spyOn(loggedServer.storage, 'createTable').mockRejectedValueOnce(
            new Error('Database disk failure'),
          );
          const res500 = await fetch(`http://127.0.0.1:${port}/admin/tables`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer test-admin-secret',
            },
            body: JSON.stringify({
              name: 'error_table',
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
          Authorization: 'Bearer test-admin-secret-key-1234567890',
          'Content-Type': 'application/json',
        };

        // 1. GET /admin/status
        const statusRes = await fetch(`http://127.0.0.1:${port}/admin/status`, {
          headers: authHeader,
        });
        expect(statusRes.status).toBe(200);
        const statusData = (await statusRes.json()) as { backend: string };
        expect(statusData.backend).toBeDefined();

        // 2. POST /admin/tables (create table)
        const createTableRes = await fetch(
          `http://127.0.0.1:${port}/admin/tables`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              name: 'admin_test_table',
              settings: { permissions: { read: Permission.Everybody } },
            }),
          },
        );
        expect(createTableRes.status).toBe(201);
        const tableData = (await createTableRes.json()) as { name: string };
        expect(tableData.name).toBe('admin_test_table');

        // 3. GET /admin/tables
        const getTablesRes = await fetch(
          `http://127.0.0.1:${port}/admin/tables`,
          {
            headers: authHeader,
          },
        );
        expect(getTablesRes.status).toBe(200);
        const tablesList = (await getTablesRes.json()) as Array<{
          name: string;
        }>;
        expect(tablesList.some((t) => t.name === 'admin_test_table')).toBe(
          true,
        );

        // 4. POST /admin/users
        const createUserRes = await fetch(
          `http://127.0.0.1:${port}/admin/users`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              userName: 'admin_created_user',
              password: 'secretpassword123',
            }),
          },
        );
        expect(createUserRes.status).toBe(201);
        const userData = (await createUserRes.json()) as {
          userId: string;
          userName: string;
        };
        expect(userData.userName).toBe('admin_created_user');

        // 5. POST /admin/records (insert record)
        const insertRecordRes = await fetch(
          `http://127.0.0.1:${port}/admin/records`,
          {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              userId: userData.userId,
              changes: [
                {
                  table: 'admin_test_table',
                  id: 'rec-1',
                  op: 'put',
                  data: { message: 'Hello from admin API' },
                  timestamp: Date.now(),
                },
              ],
            }),
          },
        );
        expect(insertRecordRes.status).toBe(200);

        // 6. GET /admin/records
        const getRecordsRes = await fetch(
          `http://127.0.0.1:${port}/admin/records?table=admin_test_table&user=${userData.userId}`,
          {
            headers: authHeader,
          },
        );
        expect(getRecordsRes.status).toBe(200);
        const records = (await getRecordsRes.json()) as Array<{
          id: string;
          data: { message: string };
        }>;
        expect(records).toHaveLength(1);
        expect(records[0].id).toBe('rec-1');
        expect(records[0].data.message).toBe('Hello from admin API');

        // 7. POST /admin/maintenance
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

  it('should return 413 when JSON payload exceeds 1MB limit on admin routes', async () => {
    const server = new TetherServer({
      adminSecret: 'test-secret',
    });
    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      const hugeString = 'a'.repeat(1024 * 1024 + 100);
      const res = await fetch(`http://127.0.0.1:${port}/admin/tables`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret',
        },
        body: JSON.stringify({
          name: 'huge_table',
          extra: hugeString,
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

    it('should support server.handleHttpRequest directly', async () => {
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

      const handled = await server.handleHttpRequest(req, res);
      expect(handled).toBe(true);
      expect(status).toBe(200);
      expect(JSON.parse(body).status).toBe('ok');

      await server.close();
    });
  });
});
