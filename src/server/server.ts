import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import { FileStorage } from './storage/file/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import type { Storage, StorageOptions } from './storage/storage.js';
import { SyncHub } from './sync-hub.js';
import {
  normalizePassword,
  normalizeUsername,
  validateAppId,
} from './validate.js';

/**
 * Configuration options for the TetherServer.
 */
export interface TetherServerOptions {
  /** Custom storage instance. */
  storage?: Storage;
  /** Filesystem root directory for storage & auth (e.g. '.data'). */
  baseDir?: string;
  /** Storage configuration options and resource limits. */
  storageOptions?: StorageOptions;
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
        ...options.storageOptions,
      });
    } else {
      this.storageEngine = new MemoryStorage(options.storageOptions);
    }

    this.initialApps = options.apps;
    this.syncHub = new SyncHub(this.storageEngine);
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

  private async initializeApps(): Promise<void> {
    if (this.initialApps) {
      if (this.initialApps instanceof Map) {
        for (const [appId, tables] of this.initialApps.entries()) {
          await this.declareApp(appId, tables);
        }
      } else {
        for (const [appId, tables] of Object.entries(this.initialApps)) {
          await this.declareApp(appId, tables);
        }
      }
    }
  }

  /**
   * The underlying HTTP server instance, if listening.
   */
  get httpServer(): http.Server | null {
    return this._httpServer;
  }

  private _httpServer: http.Server | null = null;

  /**
   * Starts the HTTP and WebSocket server listening on the specified port and host.
   *
   * @param port - Port number to bind. Defaults to 8080.
   * @param host - Host interface to bind. Defaults to '0.0.0.0'.
   * @returns The active Node.js HTTP server instance.
   */
  async listen(port = 8080, host = '0.0.0.0'): Promise<http.Server> {
    await this.initializeApps();

    return new Promise<http.Server>((resolve) => {
      this._httpServer = http.createServer(async (req, res) => {
        await this.handleHttpRequest(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on('connection', (ws) => {
        this.syncHub.handleConnection(ws);
      });

      this._httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '', `http://${req.headers.host}`);
        if (url.pathname === this.wsPath) {
          this.wss?.handleUpgrade(req, socket, head, (ws) => {
            this.wss?.emit('connection', ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this._httpServer.listen(port, host, () => {
        if (this._httpServer) {
          resolve(this._httpServer);
        }
      });
    });
  }

  /**
   * Closes active HTTP server and WebSocket server listeners.
   */
  async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }
      if (this._httpServer) {
        this._httpServer.close((err) => {
          this._httpServer = null;
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
  }

  private async readJsonBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Handles incoming HTTP requests for authentication and discovery endpoints.
   */
  async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const method = req.method?.toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      // POST /auth/register
      if (method === 'POST' && url.pathname === '/auth/register') {
        const body = await this.readJsonBody(req);
        const { username, password } = body as {
          username?: string;
          password?: string;
        };
        const normUsername = normalizeUsername(username ?? '');
        const normPassword = normalizePassword(password ?? '');
        if (!normUsername) {
          return this.sendJson(res, 400, {
            error: 'Missing or invalid required field: username',
          });
        }
        if (!normPassword) {
          return this.sendJson(res, 400, {
            error: 'Missing or invalid required field: password',
          });
        }

        try {
          const user = await this.storageEngine.createUser(
            normUsername,
            normPassword,
          );
          const token = await user.createToken();
          return this.sendJson(res, 201, {
            userId: user.id,
            username: user.username,
            token,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Registration error';
          return this.sendJson(res, 409, { error: msg });
        }
      }

      // POST /auth/login
      if (method === 'POST' && url.pathname === '/auth/login') {
        const body = await this.readJsonBody(req);
        const { username, password } = body as {
          username?: string;
          password?: string;
        };
        const normUsername = normalizeUsername(username ?? '');
        const normPassword = normalizePassword(password ?? '');
        if (!normUsername || !normPassword) {
          return this.sendJson(res, 400, {
            error: 'Missing required field: username and password',
          });
        }

        const user = await this.storageEngine.getUserByUsername(normUsername);
        if (!user) {
          return this.sendJson(res, 401, {
            error: 'Invalid username or password',
          });
        }

        const valid = await user.verifyPassword(normPassword);
        if (!valid) {
          return this.sendJson(res, 401, {
            error: 'Invalid username or password',
          });
        }

        const token = await user.createToken();
        return this.sendJson(res, 200, {
          userId: user.id,
          username: user.username,
          token,
        });
      }

      // GET /apps
      if (method === 'GET' && url.pathname === '/apps') {
        const apps = await this.storageEngine.getApps();
        const appSummaries = await Promise.all(
          apps.map(async (app) => {
            const tables = await app.getTables();
            return {
              id: app.id,
              tables: tables.map((t) => t.name),
            };
          }),
        );
        return this.sendJson(res, 200, { apps: appSummaries });
      }

      // GET /apps/:appId/tables
      const matchAppTables = url.pathname.match(/^\/apps\/([^/]+)\/tables$/);
      if (method === 'GET' && matchAppTables) {
        const appId = matchAppTables[1];
        const safeAppId = validateAppId(appId);
        const app = await this.storageEngine.getApp(safeAppId);
        if (!app) {
          return this.sendJson(res, 404, {
            error: `Application "${safeAppId}" not found`,
          });
        }

        const tables = await app.getTables();
        return this.sendJson(res, 200, {
          appId: app.id,
          tables: tables.map((t) => t.name),
        });
      }

      // Health check endpoint
      if (method === 'GET' && url.pathname === '/health') {
        return this.sendJson(res, 200, { status: 'ok' });
      }

      return this.sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      return this.sendJson(res, 500, { error: msg });
    }
  }
}

/**
 * Starts a complete standalone HTTP & WebSocket synchronization server.
 *
 * @param options - Start options including port, host, storage, and limits.
 * @returns Handle to the running server.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const port =
    options.port ??
    (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080);
  const host = options.host ?? '0.0.0.0';

  const server = new TetherServer(options);
  const httpServer = await server.listen(port, host);
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    httpServer,
    port: boundPort,
    host,
    close: async () => {
      await server.close();
    },
  };
}
