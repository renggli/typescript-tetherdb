import type * as http from 'node:http';
import type { TetherLogger } from '../server.js';
import type { Storage } from '../storage/storage.js';
import type { CorsOptions } from './cors.js';
import { sendJson } from './json.js';

/**
 * Handles the `/health` liveness probe route.
 */
export function handleHealth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsConfig: CorsOptions | null,
): void {
  sendJson(
    res,
    200,
    {
      status: 'ok',
      uptime: process.uptime(),
    },
    corsConfig,
    req,
  );
}

/**
 * Handles the `/ready` readiness probe route by testing storage availability.
 */
export async function handleReady(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storage: Storage,
  corsConfig: CorsOptions | null,
  logger: TetherLogger | null,
): Promise<void> {
  try {
    await storage.getTables();
    sendJson(res, 200, { status: 'ready' }, corsConfig, req);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Storage unavailable';
    logger?.error('Storage readiness error:', err);
    sendJson(res, 503, { status: 'unready', error: message }, corsConfig, req);
  }
}

/**
 * Handles the `/metrics` operational metrics route.
 */
export async function handleMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storage: Storage,
  connectedClientsCount: number,
  corsConfig: CorsOptions | null,
): Promise<void> {
  const tables = await storage.getTables();
  sendJson(
    res,
    200,
    {
      uptime: process.uptime(),
      connectedClients: connectedClientsCount,
      tablesCount: tables.length,
      memoryUsage: process.memoryUsage(),
    },
    corsConfig,
    req,
  );
}
