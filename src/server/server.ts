import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import type { Storage, UserStorage } from './storage/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import { SyncHub } from './sync-hub.js';
import { normalizePassword, normalizeUsername } from './validate.js';

/**
 * Configuration options for the TetherServer.
 */
export interface TetherServerOptions {
  /** Custom storage instance. Defaults to MemoryStorage if not defined. */
  storage?: Storage;
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
 * health checks (`/health`), and real-time streaming connections (`/sync`).
 */
export class TetherServer {
  private storageEngine: Storage;
  private syncHub: SyncHub;
  private wss: WebSocketServer | null = null;
  private wsPath: string;

  /**
   * Initializes a new TetherServer instance.
   *
   * @param options - Configuration options for storage and endpoints.
   */
  constructor(options: TetherServerOptions = {}) {
    this.storageEngine = options.storage ?? new MemoryStorage();
    this.syncHub = new SyncHub(this.storageEngine);
    this.wsPath = options.wsPath ?? '/sync';
  }

  /**
   * Declares an application and its tables.
   * Registers the application and any declared tables if not already present.
   *
   * @param appId - Application identifier.
   * @param tables - Array of table names.
   */
  async declareApp(appId: string, tables: string[] = []): Promise<void> {
    let app = await this.storageEngine.getApp(appId);
    if (!app) {
      app = await this.storageEngine.createApp(appId);
    }
    for (const table of tables) {
      const existing = await app.getTable(table);
      if (!existing) {
        await app.createTable(table);
      }
    }
  }

  /**
   * Declares a user account with the specified username and password.
   * Creates the user if not already registered, or updates the existing user's password.
   *
   * @param username - Username for the account.
   * @param password - Plaintext password for the account.
   * @returns UserStorage handle for the declared user.
   */
  async declareUser(username: string, password: string): Promise<UserStorage> {
    const user = await this.storageEngine.getUserByUsername(username);
    if (user) {
      await user.changePassword(password);
      return user;
    }
    return this.storageEngine.createUser(username, password);
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
   * The underlying HTTP server instance, if listening.
   */
  get httpServer(): http.Server | null {
    return this._httpServer;
  }

  private _httpServer: http.Server | null = null;

  /**
   * Attaches WebSocket synchronization handling to an existing HTTP server.
   *
   * @param server - The HTTP server instance to attach to.
   */
  attach(server: http.Server): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on('connection', (ws) => {
        this.syncHub.handleConnection(ws);
      });
    }

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(
        req.url ?? '',
        `http://${req.headers.host ?? 'localhost'}`,
      );
      if (url.pathname === this.wsPath) {
        this.wss?.handleUpgrade(req, socket, head, (ws) => {
          this.wss?.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  /**
   * Starts the HTTP and WebSocket server listening on the specified port and host.
   *
   * @param port - Port number to bind. Defaults to 8080.
   * @param host - Host interface to bind. Defaults to '0.0.0.0'.
   * @returns The active Node.js HTTP server instance.
   */
  async listen(port = 8080, host = '0.0.0.0'): Promise<http.Server> {
    return new Promise<http.Server>((resolve) => {
      this._httpServer = http.createServer(async (req, res) => {
        const handled = await this.handleHttpRequest(req, res);
        if (!handled) {
          this.sendJson(res, 404, { error: 'Not found' });
        }
      });

      this.attach(this._httpServer);

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
   *
   * @param req - Incoming HTTP request.
   * @param res - Server HTTP response.
   * @returns `true` if the request was handled by TetherDB; `false` if the path did not match.
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

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return true;
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
          this.sendJson(res, 400, {
            error: 'Missing or invalid required field: username',
          });
          return true;
        }
        if (!normPassword) {
          this.sendJson(res, 400, {
            error: 'Missing or invalid required field: password',
          });
          return true;
        }

        try {
          const user = await this.storageEngine.createUser(
            normUsername,
            normPassword,
          );
          const token = await user.createToken();
          this.sendJson(res, 201, {
            userId: user.id,
            username: user.username,
            token,
          });
          return true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Registration error';
          this.sendJson(res, 409, { error: msg });
          return true;
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
          this.sendJson(res, 400, {
            error: 'Missing required field: username and password',
          });
          return true;
        }

        const user = await this.storageEngine.getUserByUsername(normUsername);
        if (!user) {
          this.sendJson(res, 401, {
            error: 'Invalid username or password',
          });
          return true;
        }

        const valid = await user.verifyPassword(normPassword);
        if (!valid) {
          this.sendJson(res, 401, {
            error: 'Invalid username or password',
          });
          return true;
        }

        const token = await user.createToken();
        this.sendJson(res, 200, {
          userId: user.id,
          username: user.username,
          token,
        });
        return true;
      }

      // Health check endpoint
      if (method === 'GET' && url.pathname === '/health') {
        this.sendJson(res, 200, { status: 'ok' });
        return true;
      }

      return false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Internal server error';
      this.sendJson(res, 500, { error: msg });
      return true;
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
