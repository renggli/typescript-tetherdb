import * as path from 'node:path';
import {
  type RunningServer,
  type Storage,
  startServer,
} from '../../server/index.js';
import { BackendType } from '../../shared/types.js';

/**
 * Handles the 'serve' command to launch the HTTP and WebSocket synchronization server.
 *
 * @param storage - Instantiated Storage engine.
 * @param backend - Storage backend type ('memory', 'file', or 'sqlite').
 * @param dir - Data directory for file-based backends.
 * @param port - HTTP port to bind.
 * @param host - Network interface to bind.
 * @returns Handle to the running server.
 */
export async function handleServeCommand(
  storage: Storage,
  backend: BackendType,
  dir: string,
  port: number,
  host: string,
): Promise<RunningServer> {
  const running = await startServer({ port, host, storage });
  const hostLabel = running.host === '0.0.0.0' ? 'localhost' : running.host;
  const storageInfo =
    backend === BackendType.Memory
      ? 'in-memory (ephemeral)'
      : `${backend} (${path.resolve(dir)})`;

  console.log(
    `TetherDB server listening at: http://${hostLabel}:${running.port}${running.server.basePath}`,
  );
  console.log(
    `WebSocket sync endpoint: ws://${hostLabel}:${running.port}${running.server.webSocketPath}`,
  );
  console.log(`Storage backend: ${storageInfo}`);

  const shutdown = async () => {
    console.log('Stopping TetherDB server...');
    try {
      await running.close();
      await storage.close?.();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return running;
}
