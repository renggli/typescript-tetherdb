import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStorage, TetherServer } from 'tetherdb/server';
import { createServer as createViteServer } from 'vite';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.join(rootDir, '.data');

/**
 * Main application server entry point.
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  const tetherServer = new TetherServer({
    storage: new FileStorage({ baseDir: dataDir }),
  });
  await tetherServer.declareApp('todo-example', ['todos']);

  // Create Vite server in middleware mode
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa',
  });

  const server = http.createServer(async (req, res) => {
    // 1. Handle TetherDB API routes (/auth/register, /auth/login, /health)
    if (await tetherServer.handleHttpRequest(req, res)) return;

    // 2. Delegate all other requests to Vite middleware (TS, HMR, HTML, assets)
    vite.middlewares(req, res);
  });

  // Attach WebSocket sync handler
  tetherServer.attach(server);

  server.listen(port, host, () => {
    console.log(
      `⚡ TetherDB Todo Example running at: http://localhost:${port}`,
    );
    console.log(`📁 Per-user storage location: ${dataDir}`);
    console.log(
      `🌐 Open multiple tabs on http://localhost:${port} to see real-time two-way synchronization!`,
    );
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
