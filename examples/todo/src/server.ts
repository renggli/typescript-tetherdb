/**
 * TetherDB Todo Example — Server Setup Guide
 *
 * Demonstrates the step-by-step process of configuring and running a
 * TetherDB server with persistent storage, pre-provisioned data schemas,
 * REST authentication endpoints, and real-time WebSocket synchronization.
 *
 * Setup Steps:
 *   1. Configure storage persistence (FileStorage)
 *   2. Instantiate TetherServer
 *   3. Provision applications, tables, and default user accounts
 *   4. Configure frontend middleware (Vite SPA)
 *   5. Create HTTP server with TetherDB REST route handling
 *   6. Attach WebSocket synchronization handler
 *   7. Start the server listener
 */

import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStorage, TetherServer } from 'tetherdb/server';
import { createServer as createViteServer } from 'vite';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.join(rootDir, '.data');

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  // 1. Configure storage persistence (FileStorage, SqliteStorage, or MemoryStorage)
  const storage = new FileStorage({ baseDir: dataDir });

  // 2. Instantiate TetherServer with configured storage backend
  const tetherServer = new TetherServer({ storage });

  // 3. Provision applications, tables, and default accounts
  await tetherServer.declareApp('todo-example', ['todos']);
  await tetherServer.declareUser('demo', 'password123');

  // 4. Initialize Vite in middleware mode for frontend assets and HMR
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa',
  });

  // 5. Create HTTP server and route API requests to TetherDB
  const server = http.createServer(async (req, res) => {
    // Handle TetherDB REST endpoints (/auth/register, /auth/login)
    if (await tetherServer.handleHttpRequest(req, res)) {
      return;
    }

    // Delegate remaining frontend/static requests to Vite
    vite.middlewares(req, res);
  });

  // 6. Attach WebSocket real-time synchronization handling (/sync)
  tetherServer.attach(server);

  // 7. Start listening for incoming HTTP & WebSocket connections
  server.listen(port, host, () => {
    const hostLabel = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`Server listening on http://${hostLabel}:${port}`);
    console.log(`Storage directory: ${dataDir}`);
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
