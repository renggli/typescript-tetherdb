import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BeamedServer } from 'beameddb/server';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, '.data', 'todo-example');

/**
 * Main application server entry point.
 */
async function main(): Promise<void> {
  const PORT = Number(process.env.PORT ?? 3000);
  await fs.mkdir(dataDir, { recursive: true });

  const beamedServer = new BeamedServer({
    storageDir: dataDir,
  });

  await beamedServer.auth.init();

  // Create Vite server in middleware mode
  const vite = await createViteServer({
    root: rootDir,
    server: {
      middlewareMode: true,
    },
    appType: 'spa',
  });

  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      // 1. Handle BeamedDB API routes (/auth/register, /auth/login, /health)
      const handledByBeamed = await beamedServer.handleHttpRequest(req, res);
      if (handledByBeamed) return;

      // 2. Delegate all other requests to Vite middleware (handles TS, HMR, HTML, etc.)
      vite.middlewares(req, res);
    },
  );

  // Attach WebSocket sync handler
  beamedServer.attach(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `⚡ BeamedDB Todo Example running at: http://localhost:${PORT}`,
    );
    console.log(`📁 Per-user storage location: ${dataDir}`);
    console.log(
      `🌐 Open multiple tabs on http://localhost:${PORT} to see real-time two-way synchronization!`,
    );
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
