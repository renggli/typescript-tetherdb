import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import { validateAppId } from '../shared/sanitize.js';
import type { ServerLimits } from '../shared/types.js';
import { AuthManager, type AuthManagerOptions } from './auth.js';
import type { StorageAdapter } from './storage/adapter.js';
import { FileStorageAdapter } from './storage/file.js';
import { MemoryStorageAdapter } from './storage/memory.js';
import { SyncHub } from './sync-hub.js';

/**
 * Configuration options for the TetherServer.
 */
export interface TetherServerOptions {
  /** Custom storage adapter instance. */
  storage?: StorageAdapter;
  /** Filesystem root directory for per-user directories (used if `storage` is omitted). */
  storageDir?: string;
  /** Custom AuthManager instance or configuration options. */
  auth?: AuthManager | AuthManagerOptions;
  /** Server-side table and quota limits. */
  limits?: ServerLimits;
  /** Path for WebSocket upgrade requests (defaults to '/sync'). */
  wsPath?: string;
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
  private storage: StorageAdapter;
  private authManager: AuthManager;
  private syncHub: SyncHub;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private wsPath: string;

  /**
   * Initializes a new TetherServer instance.
   *
   * @param options - Configuration options for storage, authentication, and endpoints.
   */
  constructor(options: TetherServerOptions = {}) {
    if (options.storage) {
      this.storage = options.storage;
    } else if (options.storageDir) {
      this.storage = new FileStorageAdapter({
        baseDir: options.storageDir,
        limits: options.limits,
      });
    } else {
      this.storage = new MemoryStorageAdapter({ limits: options.limits });
    }

    if (options.auth instanceof AuthManager) {
      this.authManager = options.auth;
    } else {
      const authOpts: AuthManagerOptions = { ...options.auth };
      if (options.storageDir) {
        authOpts.usersFilePath =
          authOpts.usersFilePath ?? path.join(options.storageDir, 'users.json');
        authOpts.secretFilePath =
          authOpts.secretFilePath ??
          path.join(options.storageDir, 'secret.key');
      }
      this.authManager = new AuthManager(authOpts);
    }

    this.syncHub = new SyncHub(this.storage, this.authManager, options.limits);
    this.wsPath = options.wsPath ?? '/sync';
  }

  /**
   * The authentication manager instance.
   */
  get auth(): AuthManager {
    return this.authManager;
  }

  /**
   * The underlying storage adapter instance.
   */
  get storageAdapter(): StorageAdapter {
    return this.storage;
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
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );
      if (pathname === this.wsPath) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });

    wss.on('connection', (ws) => {
      this.syncHub.handleConnection(ws);
    });
  }

  /**
   * Handles incoming HTTP requests for authentication, discovery, and health check endpoints.
   *
   * @param req - The HTTP incoming request.
   * @param res - The HTTP server response.
   * @returns A promise resolving to `true` if the request was handled by TetherServer; otherwise `false`.
   */
  async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const method = req.method?.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (method === 'GET' && url.pathname === '/health') {
      this._handleGetHealth(res);
      return true;
    }

    if (method === 'GET' && url.pathname === '/apps') {
      await this._handleGetApps(req, res);
      return true;
    }

    const tablesMatch = url.pathname.match(/^\/apps\/([^/]+)\/tables$/);
    if (method === 'GET' && tablesMatch) {
      await this._handleGetTables(req, res, tablesMatch[1] ?? 'default');
      return true;
    }

    if (method === 'POST' && url.pathname === '/auth/register') {
      await this._handlePostRegister(req, res);
      return true;
    }

    if (method === 'POST' && url.pathname === '/auth/login') {
      await this._handlePostLogin(req, res);
      return true;
    }

    return false;
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
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const authHeader = req.headers.authorization;
    let userId: string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const session = this.authManager.verifyToken(token);
      if (session) userId = session.userId;
    }
    const apps = await this.storage.listApps(userId);
    this._sendJson(res, 200, { apps });
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
    const session = this.authManager.verifyToken(token);
    if (!session) {
      this._sendJson(res, 401, { error: 'Invalid or expired token' });
      return;
    }

    try {
      const rawAppId = decodeURIComponent(rawAppIdParam);
      const appId = validateAppId(rawAppId);
      const tables = await this.storage.listStores(session.userId, appId);
      this._sendJson(res, 200, { appId, tables });
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
      const result = await this.authManager.register(
        body.username,
        body.password,
      );
      this._sendJson(res, 201, result);
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
      const result = await this.authManager.login(body.username, body.password);
      this._sendJson(res, 200, result);
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
        try {
          resolve((data ? JSON.parse(data) : {}) as T);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', reject);
    });
  }

  /**
   * Starts an HTTP and WebSocket server listening on the specified port and host.
   *
   * @param port - Port number to bind.
   * @param host - Host interface to bind (defaults to '0.0.0.0').
   * @returns A promise resolving to the running `http.Server`.
   */
  async listen(port: number, host = '0.0.0.0'): Promise<http.Server> {
    await this.authManager.init();

    const server = http.createServer(async (req, res) => {
      const handled = await this.handleHttpRequest(req, res);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.attach(server);

    return new Promise((resolve) => {
      server.listen(port, host, () => {
        resolve(server);
      });
    });
  }

  /**
   * Closes the active WebSocket server, HTTP listener, and storage adapter.
   */
  async close(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    const httpServer = this.httpServer;
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      this.httpServer = null;
    }
    if (this.storage.close) {
      await this.storage.close();
    }
  }
}

/**
 * Standard zero-configuration server starter for hosting TetherDB.
 *
 * @example
 * ```ts
 * import { startServer } from 'tetherdb/server';
 *
 * const running = await startServer({
 *   port: 8080,
 *   storageDir: './data',
 * });
 * console.log(`TetherDB running at http://${running.host}:${running.port}`);
 * ```
 *
 * @param options - Server configuration options (port, host, storageDir, limits).
 * @returns A promise resolving to the running server handles.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const port =
    options.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';

  const server = new TetherServer(options);
  const httpServer = await server.listen(port, host);
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    httpServer,
    port: actualPort,
    host,
    close: async () => {
      await server.close();
    },
  };
}
