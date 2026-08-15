import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import { validateAppId } from '../shared/sanitize.js';
import type { ServerLimits } from '../shared/types.js';
import { FileStorage } from './storage/file/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import type { Storage } from './storage/storage.js';
import { SyncHub } from './sync-hub.js';

/**
 * Configuration options for the TetherServer.
 */
export interface TetherServerOptions {
  /** Custom storage instance. */
  storage?: Storage;
  /** Filesystem root directory for storage & auth (e.g. '.data'). */
  baseDir?: string;
  /** Server-side table and quota limits. */
  limits?: ServerLimits;
  /** Path for WebSocket upgrade requests (defaults to '/sync'). */
  wsPath?: string;
  /** Initial apps and tables to declare on startup. */
  apps?: Record<string, string[]> | Map<string, string[]>;
}

/**
 * Options for starting the standard server launcher.
 */
export interface StartServerOptions extends TetherServerOptions {
  /** Port number to bind (defaults to 8080 or PORT environment variable). */
  port?: number;
  /** Host interface to bind (defaults to '0.0.0.0'). */
  host?: string;
}

/**
 * Result returned when launching a server using `startServer()`.
 */
export interface RunningServer {
  /** The TetherServer instance. */
  server: TetherServer;
  /** The running Node.js HTTP server instance. */
  httpServer: http.Server;
  /** Bound port number. */
  port: number;
  /** Bound host address. */
  host: string;
  /** Closes both HTTP and WebSocket server cleanly. */
  close(): Promise<void>;
}

/**
 * Unified HTTP and WebSocket server handling authentication endpoints (`/auth/register`, `/auth/login`),
 * application discovery (`/apps`, `/apps/:appId/tables`), and real-time streaming connections (`/sync`).
 */
export class TetherServer {
  private storageEngine: Storage;
  private syncHub: SyncHub;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private wsPath: string;
  private initialApps?: Record<string, string[]> | Map<string, string[]>;

  /**
   * Initializes a new TetherServer instance.
   *
   * @param options - Configuration options for storage and endpoints.
   */
  constructor(options: TetherServerOptions = {}) {
    if (options.storage) {
      this.storageEngine = options.storage;
    } else if (options.baseDir) {
      this.storageEngine = new FileStorage({
        baseDir: options.baseDir,
        limits: options.limits,
      });
    } else {
      this.storageEngine = new MemoryStorage({ limits: options.limits });
    }

    this.initialApps = options.apps;
    this.syncHub = new SyncHub(this.storageEngine, options.limits);
    this.wsPath = options.wsPath ?? '/sync';
  }

  /**
   * Declares an application and its tables.
   *
   * @param appId - Application identifier.
   * @param tables - Array of table names.
   */
  async declareApp(appId: string, tables: string[] = []): Promise<void> {
    const app = await this.storageEngine.createApp(appId);
    for (const t of tables) {
      await app.createTable(t);
    }
  }

  /**
   * The underlying storage instance.
   */
  get storage(): Storage {
    return this.storageEngine;
  }

  /**
   * The WebSocket synchronization hub instance.
   */
  get hub(): SyncHub {
    return this.syncHub;
  }

  /**
   * Attaches WebSocket upgrade handlers and synchronization to an existing Node.js HTTP server.
   *
   * @param server - The Node HTTP server instance to attach to.
   */
  attach(server: http.Server): void {
    this.httpServer = server;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      if (url.pathname === this.wsPath) {
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.syncHub.handleConnection(ws);
        });
      } else {
        socket.destroy();
      }
    });

    const existingListeners = server.listeners('request').slice();
    server.removeAllListeners('request');

    server.on(
      'request',
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        this.handleHttpRequest(req, res, () => {
          for (const listener of existingListeners) {
            listener.call(server, req, res);
          }
        });
      },
    );
  }

  /**
   * Starts an HTTP server listening on the specified port and host, attaching TetherServer.
   *
   * @param port - Port number to bind (defaults to 8080).
   * @param host - Host interface to bind (defaults to '0.0.0.0').
   * @returns Running Node.js HTTP server.
   */
  async listen(port = 8080, host = '0.0.0.0'): Promise<http.Server> {
    if (this.initialApps) {
      const entries =
        this.initialApps instanceof Map
          ? Array.from(this.initialApps.entries())
          : Object.entries(this.initialApps);
      for (const [appId, tables] of entries) {
        await this.declareApp(appId, tables);
      }
    }

    const httpServer = http.createServer();
    this.attach(httpServer);
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(port, host, () => resolve());
      httpServer.on('error', reject);
    });
    return httpServer;
  }

  /**
   * Main HTTP request router for TetherDB authentication and discovery endpoints.
   *
   * @param req - Incoming HTTP request.
   * @param res - Outgoing HTTP response.
   * @param next - Next middleware / fallback handler callback.
   */
  handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: () => void = () => this._sendJson(res, 404, { error: 'Not found' }),
  ): void {
    const url = new URL(
      req.url ?? '',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const method = req.method?.toUpperCase();
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/health' && method === 'GET') {
      this._handleGetHealth(res);
      return;
    }

    if (pathname === '/auth/register' && method === 'POST') {
      this._handlePostRegister(req, res);
      return;
    }

    if (pathname === '/auth/login' && method === 'POST') {
      this._handlePostLogin(req, res);
      return;
    }

    if (pathname === '/apps' && method === 'GET') {
      this._handleGetApps(req, res);
      return;
    }

    const tablesMatch = pathname.match(/^\/apps\/([^/]+)\/tables$/);
    if (tablesMatch && method === 'GET') {
      this._handleGetTables(req, res, tablesMatch[1]);
      return;
    }

    next();
  }

  private _sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown,
  ): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private _handleGetHealth(res: http.ServerResponse): void {
    this._sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
  }

  private async _handleGetApps(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const apps = await this.storageEngine.getApps();
    this._sendJson(res, 200, { apps: apps.map((a) => a.id) });
  }

  private async _handleGetTables(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawAppIdParam: string,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      this._sendJson(res, 401, { error: 'Authorization header required' });
      return;
    }
    const token = authHeader.slice(7).trim();
    const user = await this.storageEngine.getUserByToken(token);
    if (!user) {
      this._sendJson(res, 401, { error: 'Invalid or expired token' });
      return;
    }

    try {
      const rawAppId = decodeURIComponent(rawAppIdParam);
      const appId = validateAppId(rawAppId);
      const app = await this.storageEngine.getApp(appId);
      if (!app) {
        this._sendJson(res, 404, {
          error: `Application "${appId}" not found`,
        });
        return;
      }
      const tables = await app.getTables();
      this._sendJson(res, 200, { appId, tables: tables.map((t) => t.name) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid request';
      this._sendJson(res, 400, { error: message });
    }
  }

  private async _handlePostRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{
        username?: string;
        password?: string;
      }>(req);
      if (!body.username || !body.password) {
        this._sendJson(res, 400, {
          error: 'Username and password are required',
        });
        return;
      }
      const user = await this.storageEngine.createUser(
        body.username,
        body.password,
      );
      const token = await user.createToken();
      this._sendJson(res, 201, {
        userId: user.id,
        username: user.username,
        token,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed';
      this._sendJson(res, 400, { error: message });
    }
  }

  private async _handlePostLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readJsonBody<{
        username?: string;
        password?: string;
      }>(req);
      if (!body.username || !body.password) {
        this._sendJson(res, 400, {
          error: 'Username and password are required',
        });
        return;
      }
      const user = await this.storageEngine.getUserByUsername(body.username);
      if (!user || !(await user.verifyPassword(body.password))) {
        this._sendJson(res, 401, { error: 'Invalid username or password' });
        return;
      }
      const token = await user.createToken();
      this._sendJson(res, 200, {
        userId: user.id,
        username: user.username,
        token,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Authentication failed';
      this._sendJson(res, 401, { error: message });
    }
  }

  private readJsonBody<T = unknown>(
    req: http.IncomingMessage,
    maxBytes = 1024 * 1024,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let data = '';
      let bytes = 0;

      req.on('data', (chunk: Buffer | string) => {
        bytes +=
          typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (bytes > maxBytes) {
          req.destroy();
          reject(new Error('Request body exceeds maximum size limit'));
          return;
        }
        data += chunk;
      });

      req.on('end', () => {
        if (!data.trim()) {
          resolve({} as T);
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new Error('Invalid JSON request body'));
        }
      });

      req.on('error', (err) => reject(err));
    });
  }

  /**
   * Closes the server and releases all bound ports and active WebSocket connections.
   */
  async close(): Promise<void> {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }

    if (this.storageEngine.close) {
      await this.storageEngine.close();
    }
  }
}

/**
 * Starts a TetherDB HTTP & WebSocket server instance.
 *
 * @param options - Startup configuration options including port and storage backend.
 * @returns A promise resolving to a `RunningServer` handle.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const port =
    options.port ?? (process.env.PORT ? Number(process.env.PORT) : 8080);
  const host = options.host ?? '0.0.0.0';

  const server = new TetherServer(options);
  const httpServer = http.createServer();
  server.attach(httpServer);

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.on('error', reject);
  });

  const address = httpServer.address();
  const actualPort =
    typeof address === 'object' && address ? address.port : port;

  return {
    server,
    httpServer,
    port: actualPort,
    host,
    async close() {
      await server.close();
    },
  };
}
