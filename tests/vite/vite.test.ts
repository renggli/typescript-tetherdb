import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SqliteStorage } from '../../src/server/index.js';
import { readServerLock } from '../../src/server/lock.js';
import { tetherPlugin } from '../../src/vite/index.js';

describe('tetherPlugin (Vite Dev Server Integration)', () => {
  let vite: ViteDevServer | null = null;

  afterEach(async () => {
    if (vite) {
      await vite.close();
      vite = null;
    }
  });

  it('should serve TetherDB HTTP endpoints, pre-provision accounts, and handle WebSocket sync', async () => {
    vite = await createViteServer({
      server: {
        host: '127.0.0.1',
        port: 0,
      },
      plugins: [
        tetherPlugin({
          tables: ['todos', 'notes'],
          users: [{ userName: 'vite-user', password: 'vite-password-123' }],
        }),
      ],
    });

    await vite.listen();
    const httpServer = vite.httpServer;
    expect(httpServer).toBeDefined();

    const addr = httpServer?.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    // 1. Verify health endpoint
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);
    const healthData = (await healthRes.json()) as { status: string };
    expect(healthData.status).toBe('ok');

    // 2. Verify pre-provisioned user login
    const loginRes = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: 'vite-user',
        password: 'vite-password-123',
      }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as {
      token: string;
      userId: string;
    };
    expect(loginData.token).toBeDefined();
    expect(loginData.userId).toBeDefined();

    // 3. Verify WebSocket sync handshake over the same port
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync`);
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'));
      }, 5000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: 1,
            clientId: 'vite-test-client',
            token: loginData.token,
          }),
        );
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.type === 'auth_success') {
          clearTimeout(timeout);
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(
      messages.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'auth_success',
      ),
    ).toBe(true);

    ws.close();
  });

  it('should handle preview server configuration and close cleanly', async () => {
    const plugin = tetherPlugin({
      tables: ['items'],
    });

    let middlewareRegistered = false;
    let upgradeAttached = false;

    const mockHttpServer = {
      on(event: string) {
        if (event === 'upgrade') upgradeAttached = true;
      },
    } as unknown as http.Server;

    const mockPreviewServer = {
      httpServer: mockHttpServer,
      middlewares: {
        use(_fn: unknown) {
          middlewareRegistered = true;
        },
      },
    };

    if (typeof plugin.configurePreviewServer === 'function') {
      await (
        plugin.configurePreviewServer as (
          server: unknown,
        ) => Promise<void> | void
      )(mockPreviewServer);
    }

    expect(middlewareRegistered).toBe(true);
    expect(upgradeAttached).toBe(true);

    // Test closeBundle cleanup
    if (typeof plugin.closeBundle === 'function') {
      await (plugin.closeBundle as () => Promise<void> | void)();
    }
  });

  it('should acquire server.lock with persistent storage and release on shutdown', async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-vite-lock-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      const storage = new SqliteStorage({ baseDir: tmpDir });
      vite = await createViteServer({
        server: {
          host: '127.0.0.1',
          port: 0,
        },
        plugins: [
          tetherPlugin({
            storage,
            tables: ['todos'],
          }),
        ],
      });

      await vite.listen();

      const lock = readServerLock(tmpDir);
      expect(lock).not.toBeNull();
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.backend).toBe('sqlite');
      expect(lock?.adminSecret).toBeDefined();

      await vite.close();
      vite = null;

      const lockAfterClose = readServerLock(tmpDir);
      expect(lockAfterClose).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
