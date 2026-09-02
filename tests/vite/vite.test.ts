import * as fs from 'node:fs/promises';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SqliteStorage } from '../../src/server/index.js';
import { readServerLock } from '../../src/server/shared/lock.js';
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

    // 2. Verify WebSocket sync handshake and pre-provisioned user login
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tether`);
    const messages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'));
      }, 5000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'login',
            protocolVersion: 1,
            clientId: 'vite-test-client',
            userName: 'vite-user',
            password: 'vite-password-123',
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

    // 4. Verify Vite HMR WebSocket connection is not intercepted by TetherDB
    const hmrWs = new WebSocket(`ws://127.0.0.1:${port}`, 'vite-hmr');
    const hmrMessages: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Vite HMR WebSocket connection timed out'));
      }, 5000);

      hmrWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        hmrMessages.push(msg);
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          resolve();
        }
      });

      hmrWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(
      hmrMessages.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'connected',
      ),
    ).toBe(true);

    hmrWs.close();
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
      expect(lock?.type).toBe('sqlite');
      expect(lock?.adminSecret).toBeDefined();

      await vite.close();
      vite = null;

      const lockAfterClose = readServerLock(tmpDir);
      expect(lockAfterClose).toBeNull();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should shut down Vite server when stopped via admin stop endpoint', async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-vite-stop-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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
      expect(lock?.adminSecret).toBeDefined();

      const stopRes = await fetch(`http://127.0.0.1:${lock?.port}/admin/stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lock?.adminSecret}`,
        },
      });
      expect(stopRes.status).toBe(200);

      for (let i = 0; i < 50; i++) {
        if (!vite?.httpServer?.listening) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(vite.httpServer?.listening).toBeFalsy();
      const lockAfterStop = readServerLock(tmpDir);
      expect(lockAfterStop).toBeNull();
      vite = null;
    } finally {
      if (vite) {
        await vite.close().catch(() => {});
        vite = null;
      }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should print storage info and admin token on printUrls with MemoryStorage', async () => {
    const logs: string[] = [];
    vite = await createViteServer({
      server: {
        host: '127.0.0.1',
        port: 0,
      },
      plugins: [
        tetherPlugin({
          tables: ['todos'],
        }),
      ],
      customLogger: {
        info(msg) {
          logs.push(msg);
        },
        warn() {},
        warnOnce() {},
        error() {},
        clearScreen() {},
        hasErrorLogged() {
          return false;
        },
        hasWarned: false,
      },
    });

    await vite.listen();
    vite.printUrls();

    expect(
      logs.some((l) => l.includes('Storage:') && l.includes('memory')),
    ).toBe(true);
    expect(logs.some((l) => l.includes('Admin Token:'))).toBe(true);
  });

  it('should print storage directory on printUrls with disk storage', async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-vite-print-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    try {
      const logs: string[] = [];
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
        customLogger: {
          info(msg) {
            logs.push(msg);
          },
          warn() {},
          warnOnce() {},
          error() {},
          clearScreen() {},
          hasErrorLogged() {
            return false;
          },
          hasWarned: false,
        },
      });

      await vite.listen();
      vite.printUrls();

      expect(
        logs.some((l) => l.includes('Storage:') && l.includes('sqlite')),
      ).toBe(true);
      expect(
        logs.some((l) => l.includes('Directory:') && l.includes(tmpDir)),
      ).toBe(true);
      expect(logs.some((l) => l.includes('Admin Token:'))).toBe(false);
    } finally {
      if (vite) {
        await vite.close().catch(() => {});
        vite = null;
      }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
