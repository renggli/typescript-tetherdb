import * as path from 'node:path';
import { type RunningServer, startServer } from '../../server/server.js';
import { type Storage, StorageType } from '../../server/storage/storage.js';
import {
  ANSI_BOLD,
  ANSI_COLOR_1,
  ANSI_CYAN,
  ANSI_DIM,
  ANSI_RESET,
  getBanner,
} from '../banner.js';

/**
 * Handles the 'serve' command to launch the HTTP and WebSocket synchronization server.
 *
 * @param storage - Instantiated Storage engine.
 * @param backend - Storage type ('memory', 'file', or 'sqlite').
 * @param dir - Data directory for file-based backends.
 * @param port - HTTP port to bind.
 * @param host - Network interface to bind.
 * @returns Handle to the running server.
 */
export async function handleServeCommand(
  storage: Storage,
  backend: StorageType,
  dir: string,
  port: number,
  host: string,
): Promise<RunningServer> {
  const baseDir = backend === StorageType.Memory ? undefined : dir;
  const running = await startServer({ port, host, storage, baseDir });
  const resolvedHost =
    running.host === '0.0.0.0'
      ? 'localhost'
      : running.host === '::'
        ? '::1'
        : running.host;
  const hostLabel = resolvedHost.includes(':')
    ? `[${resolvedHost}]`
    : resolvedHost;
  const storageInfo =
    backend === StorageType.Memory
      ? 'in-memory (ephemeral)'
      : `${backend} (${path.resolve(dir)})`;
  const httpUrl = `http://${hostLabel}:${running.port}${running.server.httpPath}`;
  const wsUrl = `ws://${hostLabel}:${running.port}${running.server.webSocketPath}`;

  console.log(`\n${getBanner()}\n`);
  console.log(
    `  ${ANSI_COLOR_1}➜${ANSI_RESET}  ${ANSI_BOLD}HTTP API:${ANSI_RESET}     ${ANSI_CYAN}${httpUrl}${ANSI_RESET}`,
  );
  console.log(
    `  ${ANSI_COLOR_1}➜${ANSI_RESET}  ${ANSI_BOLD}WebSocket:${ANSI_RESET}    ${ANSI_CYAN}${wsUrl}${ANSI_RESET}`,
  );
  console.log(
    `  ${ANSI_COLOR_1}➜${ANSI_RESET}  ${ANSI_BOLD}Storage:${ANSI_RESET}      ${storageInfo}`,
  );
  if (backend === StorageType.Memory) {
    console.log(
      `  ${ANSI_COLOR_1}➜${ANSI_RESET}  ${ANSI_BOLD}Admin Token:${ANSI_RESET}  ${ANSI_DIM}${running.adminToken}${ANSI_RESET}`,
    );
  }
  console.log('');

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
