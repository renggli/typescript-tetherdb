import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import { normalizeBasePath } from '../shared/path.js';
import {
  type ChangeRecord,
  OperationType,
  type TableSettings,
} from '../shared/types.js';
import { verifyDummyPasswordHash } from './crypto.js';
import { TetherServerError, TetherServerErrorCode } from './errors.js';
import { acquireServerLock, type ServerLockHandle } from './lock.js';
import { RateLimiter } from './rate-limiter.js';
import type {
  MaintenanceResult,
  Storage,
  TableStorage,
  UserStorage,
} from './storage/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import { Sync } from './sync.js';
import {
  normalizePassword,
  normalizeUsername,
  validateTableName,
} from './validate.js';

/**
 * Rate limiting and resource control options for authentication endpoints and sync streams.
 */
export interface RateLimitOptions {
  /** Sliding window duration in milliseconds (defaults to 60,000ms / 1 minute). */
  windowMs?: number;
  /** Maximum duration in milliseconds to wait for authentication before terminating socket (defaults to 10,000ms). */
  authTimeoutMs?: number;
  /** Maximum concurrent active WebSocket connections allowed per user channel (defaults to 20). */
  maxConcurrentConnectionsPerUser?: number;
  /** Consecutive failed attempts before progressive backoff begins (defaults to 5). */
  maxFailures?: number;
  /** Initial backoff duration in milliseconds (defaults to 1,000ms). */
  initialBackoffMs?: number;
  /** Maximum backoff duration in milliseconds (defaults to 900,000ms / 15 minutes). */
  maxBackoffMs?: number;
  /** Maximum login attempts per IP within the time window (defaults to 100). */
  ipLoginMaxRequests?: number;
  /** Maximum login attempts per target username within the time window (defaults to 20). */
  userLoginMaxRequests?: number;
  /** Maximum registration attempts per IP within the time window (defaults to 100). */
  ipRegisterMaxRequests?: number;
  /** Maximum WebSocket connection handshakes per IP within the time window (defaults to 100). */
  ipSyncMaxRequests?: number;
}

/**
 * Options for configuring Cross-Origin Resource Sharing (CORS) on HTTP endpoints.
 */
export interface CorsOptions {
  /**
   * Allowed origin(s). Can be `'*'` for unrestricted access, a specific origin string (e.g. `'https://example.com'`),
   * an array of allowed origin strings, `true` to reflect the request's `Origin` header, or `false` to disable CORS headers.
   * Defaults to `'*'`.
   */
  origin?: string | string[] | boolean;
  /** Whether to set `Access-Control-Allow-Credentials: true` (defaults to false). */
  credentials?: boolean;
  /** Allowed request headers for preflight OPTIONS checks (defaults to `['Content-Type', 'Authorization']`). */
  allowedHeaders?: string[];
  /** Exposed response headers (Access-Control-Expose-Headers). */
  exposedHeaders?: string[];
  /** Maximum age in seconds to cache preflight responses (Access-Control-Max-Age). */
  maxAge?: number;
}

/**
 * Pluggable logger interface for TetherServer logging.
 */
export interface TetherLogger {
  /** Logs debug information. */
  debug(message: string, ...args: unknown[]): void;
  /** Logs operational information. */
  info(message: string, ...args: unknown[]): void;
  /** Logs warning conditions. */
  warn(message: string, ...args: unknown[]): void;
  /** Logs error conditions. */
  error(message: string, ...args: unknown[]): void;
}

/**
 * Configuration options for the TetherServer.
 */
export interface TetherServerOptions {
  /** Custom storage instance. Defaults to MemoryStorage if not defined. */
  storage?: Storage;
  /** Base path for HTTP REST endpoints (defaults to ''). */
  basePath?: string;
  /** Path for WebSocket upgrade requests (defaults to '/sync'). */
  webSocketPath?: string;
  /** Whether user self-registration is allowed via `/auth/register` (defaults to true). */
  allowRegistration?: boolean;
  /** Rate limiting options for auth and sync endpoints, or `false` to disable rate limiting (defaults to true). */
  rateLimiting?: boolean | RateLimitOptions;
  /** Whether to trust the `X-Forwarded-For` header for resolving client IP addresses (defaults to false). */
  trustProxy?: boolean;
  /** CORS options for HTTP endpoints, `false` to disable CORS headers, or `true` for default permissive CORS (defaults to true). */
  cors?: boolean | CorsOptions;
  /** Optional custom logger instance, or `false` to silence internal server logs (defaults to `console`). */
  logger?: TetherLogger | false;
  /** Optional secret token required for accessing local admin endpoints. */
  adminSecret?: string;
}

/**
 * Options for starting the standard server launcher.
 */
export interface StartServerOptions extends TetherServerOptions {
  /** Host interface to bind (defaults to '0.0.0.0'). */
  host?: string;
  /** Port number to bind (defaults to 8080 or PORT environment variable). */
  port?: number;
}

/**
 * Result returned when launching a server using `startServer()`.
 */
export interface RunningServer {
  /** The TetherServer instance. */
  server: TetherServer;
  /** The running Node.js HTTP server instance. */
  httpServer: http.Server;
  /** Bound host address. */
  host: string;
  /** Bound port number. */
  port: number;
  /** Root URL for the running server (e.g. 'http://127.0.0.1:8080'). */
  url: string;
  /** Closes both HTTP and WebSocket server cleanly. */
  close(): Promise<void>;
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
  const hostLabel = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${hostLabel}:${boundPort}${server.basePath}`;

  return {
    server,
    httpServer,
    port: boundPort,
    host,
    url,
    close: async () => {
      await server.close();
    },
  };
}

/**
 * Unified HTTP and WebSocket server handling authentication endpoints (`/auth/register`, `/auth/login`),
 * real-time streaming connections (`/sync`), and administration routes (`/admin/*`).
 */
export class TetherServer {
  /** Underlying storage engine for users and tables. */
  readonly storage: Storage;
  /** Real-time synchronization connection and broadcast coordinator. */
  readonly sync: Sync;
  /** Base path for HTTP REST endpoints. */
  readonly basePath: string;
  /** Path for WebSocket upgrade requests. */
  readonly webSocketPath: string;
  readonly trustProxy: boolean;
  private readonly allowRegistration: boolean;
  private readonly corsConfig: CorsOptions | null;
  private readonly logger: TetherLogger | null;
  private readonly ipLoginLimiter: RateLimiter | null;
  private readonly userLoginLimiter: RateLimiter | null;
  private readonly ipRegisterLimiter: RateLimiter | null;
  private _httpServer: http.Server | null = null;
  private _webSocketServer: WebSocketServer | null = null;
  private lockHandle: ServerLockHandle | null = null;
  private adminSecret: string;

  /**
   * Initializes a new TetherServer instance.
   *
   * @param options - Configuration options for storage, endpoints, and rate limiting.
   */
  constructor(options: TetherServerOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.basePath = normalizeBasePath(options.basePath ?? '');
    this.webSocketPath = options.webSocketPath ?? `${this.basePath}/sync`;
    this.allowRegistration = options.allowRegistration ?? true;
    this.trustProxy = options.trustProxy ?? false;
    this.adminSecret =
      options.adminSecret ?? crypto.randomBytes(32).toString('hex');
    this.corsConfig =
      options.cors === false
        ? null
        : typeof options.cors === 'object'
          ? options.cors
          : {};
    this.logger = options.logger === false ? null : (options.logger ?? console);

    const rateLimitConfig = options.rateLimiting ?? true;
    if (rateLimitConfig === false) {
      this.ipLoginLimiter = null;
      this.userLoginLimiter = null;
      this.ipRegisterLimiter = null;
      this.sync = new Sync(this.storage, {
        maxConcurrentConnectionsPerUser: 1_000,
        authTimeoutMs: 0,
        rateLimiter: null,
        logger: this.logger,
      });
    } else {
      const opts: RateLimitOptions =
        typeof rateLimitConfig === 'object' ? rateLimitConfig : {};
      const windowMs = opts.windowMs ?? 60_000;
      const maxFailures = opts.maxFailures ?? 5;
      const initialBackoffMs = opts.initialBackoffMs ?? 1_000;
      const maxBackoffMs = opts.maxBackoffMs ?? 900_000;

      this.ipLoginLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.ipLoginMaxRequests ?? 100,
        maxFailures,
        initialBackoffMs,
        maxBackoffMs,
      });
      this.userLoginLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.userLoginMaxRequests ?? 20,
        maxFailures,
        initialBackoffMs,
        maxBackoffMs,
      });
      this.ipRegisterLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.ipRegisterMaxRequests ?? 100,
      });

      const syncLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.ipSyncMaxRequests ?? 100,
        maxFailures,
        initialBackoffMs,
        maxBackoffMs,
      });

      this.sync = new Sync(this.storage, {
        maxConcurrentConnectionsPerUser:
          opts.maxConcurrentConnectionsPerUser ?? 20,
        authTimeoutMs: opts.authTimeoutMs ?? 10_000,
        rateLimiter: syncLimiter,
        logger: this.logger,
      });
    }
  }

  /**
   * Active Node.js HTTP server instance, or `null` if not listening.
   */
  get httpServer(): http.Server | null {
    return this._httpServer;
  }

  /**
   * Active WebSocketServer instance, or `null` if not listening.
   */
  get webSocketServer(): WebSocketServer | null {
    return this._webSocketServer;
  }

  /**
   * Declares a table with optional settings.
   * Creates the table if not already present or updates its settings.
   *
   * @param name - Name of the table.
   * @param settings - Optional table settings.
   * @returns TableStorage handle for the declared table.
   */
  async declareTable(
    name: string,
    settings?: TableSettings,
  ): Promise<TableStorage> {
    const safeName = validateTableName(name);
    let table = await this.storage.getTable(safeName);
    if (!table) {
      table = await this.storage.createTable(safeName, settings);
    } else if (settings) {
      await table.updateSettings(settings);
    }
    return table;
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
    const user = await this.storage.getUserByUsername(username);
    if (user) {
      await user.changePassword(password);
      return user;
    }
    return this.storage.createUser(username, password);
  }

  /**
   * Attaches WebSocket synchronization handling and lockfile management to an existing HTTP server.
   *
   * @param server - The HTTP server instance to attach to.
   */
  attach(server: http.Server): void {
    if (!this._webSocketServer) {
      this._webSocketServer = new WebSocketServer({
        noServer: true,
        perMessageDeflate: {
          zlibDeflateOptions: {
            level: 6,
            memLevel: 8,
          },
          threshold: 1024,
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
        },
      });
      this._webSocketServer.on('connection', (ws, req) => {
        const ip = req ? this.getClientIp(req) : '127.0.0.1';
        this.sync.handleConnection(ws, ip);
      });
    }
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(
        req.url ?? '',
        `http://${req.headers.host ?? 'localhost'}`,
      );
      if (url.pathname === this.webSocketPath) {
        this._webSocketServer?.handleUpgrade(req, socket, head, (ws) => {
          this._webSocketServer?.emit('connection', ws, req);
        });
      }
    });

    const setupLock = () => {
      const addr =
        typeof server.address === 'function' ? server.address() : null;
      const port = typeof addr === 'object' && addr ? addr.port : 8080;
      const host =
        typeof addr === 'object' && addr && 'address' in addr
          ? (addr.address as string)
          : '127.0.0.1';
      this.acquireLockIfPersistent(port, host);
    };

    if (server.listening) {
      setupLock();
    } else if (typeof server.once === 'function') {
      server.once('listening', setupLock);
    } else if (typeof server.on === 'function') {
      server.on('listening', setupLock);
    }

    if (typeof server.once === 'function') {
      server.once('close', () => {
        if (this.lockHandle) {
          this.lockHandle.release();
          this.lockHandle = null;
        }
      });
    } else if (typeof server.on === 'function') {
      server.on('close', () => {
        if (this.lockHandle) {
          this.lockHandle.release();
          this.lockHandle = null;
        }
      });
    }
  }

  /**
   * Starts the HTTP and WebSocket server listening on the specified port and host.
   *
   * @param port - Port number to bind. Defaults to 8080.
   * @param host - Host interface to bind. Defaults to '0.0.0.0'.
   * @returns The active Node.js HTTP server instance.
   */
  async listen(port = 8080, host = '0.0.0.0'): Promise<http.Server> {
    this.acquireLockIfPersistent(port, host);

    return new Promise<http.Server>((resolve, reject) => {
      this._httpServer = http.createServer(async (req, res) => {
        const handled = await this.handleHttpRequest(req, res);
        if (!handled) {
          this.sendJson(res, 404, { error: 'Not found' });
        }
      });
      this.attach(this._httpServer);
      this._httpServer.listen(port, host, () => {
        if (this._httpServer) {
          const addr = this._httpServer.address();
          const actualPort =
            typeof addr === 'object' && addr ? addr.port : port;
          if (actualPort !== port) {
            this.acquireLockIfPersistent(actualPort, host);
          }
          resolve(this._httpServer);
        }
      });
      this._httpServer.on('error', (err) => {
        if (this.lockHandle) {
          this.lockHandle.release();
          this.lockHandle = null;
        }
        reject(err);
      });
    });
  }

  /**
   * Closes active HTTP server and WebSocket server listeners.
   */
  async close(): Promise<void> {
    if (this.lockHandle) {
      this.lockHandle.release();
      this.lockHandle = null;
    }
    return new Promise<void>((resolve, reject) => {
      if (this._webSocketServer) {
        for (const client of this._webSocketServer.clients) {
          try {
            client.terminate();
          } catch {
            // Ignore termination errors on shutdown
          }
        }
        this._webSocketServer.close();
        this._webSocketServer = null;
      }
      if (this._httpServer) {
        try {
          this._httpServer.closeAllConnections?.();
        } catch {
          // Ignore
        }
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

  /**
   * Creates a Connect- and Express-compatible HTTP middleware handler.
   *
   * @returns Middleware function `(req, res, next) => void`.
   */
  createMiddleware(): (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (err?: unknown) => void,
  ) => void {
    return (req, res, next) => {
      this.handleHttpRequest(req, res).then(
        (handled) => {
          if (!handled) next();
        },
        (err) => {
          next(err);
        },
      );
    };
  }

  /**
   * Handles incoming HTTP requests for authentication, discovery, and administration endpoints.
   *
   * @param req - Incoming HTTP request.
   * @param res - Server HTTP response.
   * @returns `true` if the request was handled by TetherDB; `false` if the path did not match.
   */
  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    return this.handleHttpRequest(req, res);
  }

  /**
   * Handles incoming HTTP requests for authentication, discovery, and administration endpoints.
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
      this.handleOptions(req, res);
      return true;
    }

    try {
      if (method === 'GET' && url.pathname === `${this.basePath}/health`) {
        this.handleHealth(req, res);
        return true;
      }

      if (method === 'GET' && url.pathname === `${this.basePath}/ready`) {
        await this.handleReady(req, res);
        return true;
      }

      if (method === 'GET' && url.pathname === `${this.basePath}/metrics`) {
        await this.handleMetrics(req, res);
        return true;
      }

      if (
        this.allowRegistration &&
        method === 'POST' &&
        url.pathname === `${this.basePath}/auth/register`
      ) {
        await this.handleRegister(req, res);
        return true;
      }

      if (method === 'POST' && url.pathname === `${this.basePath}/auth/login`) {
        await this.handleLogin(req, res);
        return true;
      }

      // Handle /admin/* routes
      if (url.pathname.startsWith(`${this.basePath}/admin`)) {
        return await this.handleAdminRequest(req, res, url);
      }

      return false;
    } catch (err) {
      const status = getHttpStatusForError(err);
      if (status >= 500) {
        this.logger?.error('Error handling HTTP request:', err);
      } else {
        this.logger?.debug('Client error handling HTTP request:', err);
      }
      const msg = err instanceof Error ? err.message : 'Internal server error';
      this.sendJson(res, status, { error: msg }, req);
      return true;
    }
  }

  // -- Private Admin API Handlers -------------------------------------------

  private assertAdminAuth(req: http.IncomingMessage): void {
    const authHeader = req.headers.authorization ?? '';
    const xAdmin = req.headers['x-admin-secret'];
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : typeof xAdmin === 'string'
        ? xAdmin.trim()
        : '';

    const tokenBuf = Buffer.from(token, 'utf-8');
    const secretBuf = Buffer.from(this.adminSecret, 'utf-8');

    if (
      tokenBuf.length !== secretBuf.length ||
      !crypto.timingSafeEqual(tokenBuf, secretBuf)
    ) {
      throw new TetherServerError(
        TetherServerErrorCode.Unauthorized,
        'Invalid or missing admin authorization token',
      );
    }
  }

  private async handleAdminRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean> {
    this.assertAdminAuth(req);
    const method = req.method?.toUpperCase();
    const adminPath = url.pathname.slice(`${this.basePath}/admin`.length);

    if (method === 'GET' && adminPath === '/status') {
      const status = await this.storage.getStatus();
      this.sendJson(res, 200, status, req);
      return true;
    }

    if (method === 'POST' && adminPath === '/maintenance') {
      const body = (await this.readJsonBody(req)) as {
        action: 'checkpoint' | 'vacuum' | 'prune';
        keepCount?: number;
        tableName?: string;
      };
      let result: MaintenanceResult;
      if (body.action === 'checkpoint') {
        result = await this.storage.checkpoint(body.tableName);
      } else if (body.action === 'vacuum') {
        result = await this.storage.vacuum();
      } else if (body.action === 'prune') {
        result = await this.storage.prune(body.keepCount, body.tableName);
      } else {
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          `Invalid maintenance action "${body.action}"`,
        );
      }
      this.sendJson(res, 200, result, req);
      return true;
    }

    if (method === 'POST' && adminPath === '/stop') {
      this.sendJson(res, 200, { message: 'Server stopping' }, req);
      setImmediate(() => {
        this.close().catch(() => {});
      });
      return true;
    }

    // /admin/tables
    if (method === 'GET' && adminPath === '/tables') {
      const tables = await this.storage.getTables();
      const list = tables.map((t) => ({
        name: t.name,
        settings: t.settings,
      }));
      this.sendJson(res, 200, list, req);
      return true;
    }

    if (method === 'POST' && adminPath === '/tables') {
      const body = (await this.readJsonBody(req)) as {
        name: string;
        settings?: TableSettings;
      };
      if (!body.name) {
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          'Table name is required',
        );
      }
      const table = await this.storage.createTable(body.name, body.settings);
      this.sendJson(
        res,
        201,
        { name: table.name, settings: table.settings },
        req,
      );
      return true;
    }

    if (adminPath.startsWith('/tables/')) {
      const tableName = decodeURIComponent(adminPath.slice('/tables/'.length));
      if (method === 'GET') {
        const table = await this.storage.getTable(tableName);
        if (!table) {
          throw new TetherServerError(
            TetherServerErrorCode.NotFound,
            `Table "${tableName}" not found`,
          );
        }
        this.sendJson(
          res,
          200,
          { name: table.name, settings: table.settings },
          req,
        );
        return true;
      }
      if (method === 'PATCH') {
        const body = (await this.readJsonBody(req)) as {
          settings: Partial<TableSettings>;
        };
        const table = await this.storage.getTable(tableName);
        if (!table) {
          throw new TetherServerError(
            TetherServerErrorCode.NotFound,
            `Table "${tableName}" not found`,
          );
        }
        const updated = await table.updateSettings(body.settings ?? {});
        this.sendJson(res, 200, { name: table.name, settings: updated }, req);
        return true;
      }
      if (method === 'DELETE') {
        const table = await this.storage.getTable(tableName);
        if (!table) {
          throw new TetherServerError(
            TetherServerErrorCode.NotFound,
            `Table "${tableName}" not found`,
          );
        }
        await table.delete();
        this.sendJson(res, 200, { deleted: true }, req);
        return true;
      }
    }

    // /admin/users
    if (method === 'GET' && adminPath === '/users') {
      const users = await this.storage.getUsers();
      const list = users.map((u) => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt,
      }));
      this.sendJson(res, 200, list, req);
      return true;
    }

    if (method === 'POST' && adminPath === '/users') {
      const body = (await this.readJsonBody(req)) as {
        username?: string;
        password?: string;
      };
      if (!body.username || !body.password) {
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          'Username and password are required',
        );
      }
      const user = await this.storage.createUser(body.username, body.password);
      this.sendJson(
        res,
        201,
        { id: user.id, username: user.username, createdAt: user.createdAt },
        req,
      );
      return true;
    }

    if (adminPath.startsWith('/users/')) {
      const userId = decodeURIComponent(adminPath.slice('/users/'.length));
      if (method === 'DELETE') {
        const user = await this.storage.getUser(userId);
        if (!user) {
          throw new TetherServerError(
            TetherServerErrorCode.NotFound,
            `User "${userId}" not found`,
          );
        }
        await user.delete();
        this.sendJson(res, 200, { deleted: true }, req);
        return true;
      }
    }

    // /admin/records
    if (adminPath === '/records') {
      if (method === 'GET') {
        const tableName = url.searchParams.get('table');
        const userParam =
          url.searchParams.get('user') ?? url.searchParams.get('userId');
        if (!tableName) {
          throw new TetherServerError(
            TetherServerErrorCode.InvalidInput,
            'Query parameter "table" is required',
          );
        }
        const table = await this.storage.getTable(tableName);
        if (!table) {
          throw new TetherServerError(
            TetherServerErrorCode.NotFound,
            `Table "${tableName}" not found`,
          );
        }
        const user = userParam
          ? ((await this.storage.getUser(userParam)) ??
            (await this.storage.getUserByUsername(userParam)))
          : undefined;
        const records = await table.getAllRecords(user);
        this.sendJson(res, 200, records, req);
        return true;
      }

      if (method === 'POST') {
        const body = (await this.readJsonBody(req)) as {
          userId?: string;
          changes?: ChangeRecord[];
          table?: string;
          id?: string;
          data?: unknown;
          op?: OperationType;
        };
        const user = body.userId
          ? ((await this.storage.getUser(body.userId)) ??
            (await this.storage.getUserByUsername(body.userId)))
          : undefined;

        let changes = body.changes;
        if (!changes && body.table && body.id) {
          changes = [
            {
              table: body.table,
              id: body.id,
              op: body.op ?? OperationType.Put,
              data: body.data,
              timestamp: Date.now(),
              clientId: 'admin_cli',
            },
          ];
        }
        if (!changes) {
          throw new TetherServerError(
            TetherServerErrorCode.InvalidInput,
            'Either "changes" array or "table" and "id" must be provided',
          );
        }
        const result = await this.storage.applyChanges(user, changes);
        this.sendJson(res, 200, result, req);
        return true;
      }
    }

    return false;
  }

  // -- Private Helpers ------------------------------------------------------

  private getCorsHeaders(req?: http.IncomingMessage): Record<string, string> {
    if (!this.corsConfig) return {};

    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': (
        this.corsConfig.allowedHeaders ?? [
          'Content-Type',
          'Authorization',
          'X-Admin-Secret',
        ]
      ).join(', '),
    };

    if (
      this.corsConfig.exposedHeaders &&
      this.corsConfig.exposedHeaders.length > 0
    ) {
      headers['Access-Control-Expose-Headers'] =
        this.corsConfig.exposedHeaders.join(', ');
    }

    if (this.corsConfig.maxAge !== undefined) {
      headers['Access-Control-Max-Age'] = String(this.corsConfig.maxAge);
    }

    const reqOrigin = req?.headers.origin;
    const origin = this.corsConfig.origin ?? '*';

    if (origin === '*') {
      if (this.corsConfig.credentials) {
        if (reqOrigin) {
          headers['Access-Control-Allow-Origin'] = reqOrigin;
          headers.Vary = 'Origin';
        }
      } else {
        headers['Access-Control-Allow-Origin'] = '*';
      }
    } else if (typeof origin === 'string') {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    } else if (Array.isArray(origin)) {
      if (reqOrigin && origin.includes(reqOrigin)) {
        headers['Access-Control-Allow-Origin'] = reqOrigin;
        headers.Vary = 'Origin';
      }
    } else if (origin === true && reqOrigin) {
      headers['Access-Control-Allow-Origin'] = reqOrigin;
      headers.Vary = 'Origin';
    }

    if (this.corsConfig.credentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }

    return headers;
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
    req?: http.IncomingMessage,
  ) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...this.getCorsHeaders(req),
    });
    res.end(JSON.stringify(data));
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          reject(
            new TetherServerError(
              TetherServerErrorCode.LimitExceeded,
              'Payload exceeds maximum allowed size',
            ),
          );
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(
            new TetherServerError(
              TetherServerErrorCode.InvalidInput,
              'Invalid JSON payload',
            ),
          );
        }
      });
      req.on('error', reject);
    });
  }

  private handleOptions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.writeHead(204, this.getCorsHeaders(req));
    res.end();
  }

  private handleHealth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    this.sendJson(
      res,
      200,
      {
        status: 'ok',
        uptime: process.uptime(),
      },
      req,
    );
  }

  private async handleReady(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      await this.storage.getTables();
      this.sendJson(res, 200, { status: 'ready' }, req);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Storage unavailable';
      this.logger?.error('Storage readiness error:', err);
      this.sendJson(res, 503, { status: 'unready', error: message }, req);
    }
  }

  private async handleMetrics(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const tables = await this.storage.getTables();
    this.sendJson(
      res,
      200,
      {
        uptime: process.uptime(),
        connectedClients: this.sync.connectedClientsCount,
        tablesCount: tables.length,
        memoryUsage: process.memoryUsage(),
      },
      req,
    );
  }

  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const ip = this.getClientIp(req);
    if (this.ipRegisterLimiter && !this.ipRegisterLimiter.consume(ip)) {
      this.sendJson(res, 429, { error: 'Too many registration requests' }, req);
      return;
    }

    const credentials = await this.readCredentials(req, res);
    if (!credentials) return;

    try {
      const user = await this.storage.createUser(
        credentials.username,
        credentials.password,
      );
      const token = await user.createToken();
      this.sendJson(
        res,
        201,
        {
          userId: user.id,
          username: user.username,
          token,
        },
        req,
      );
    } catch (err) {
      const status = getHttpStatusForError(err);
      if (status >= 500) {
        this.logger?.error('Registration error:', err);
      } else {
        this.logger?.debug('Client registration error:', err);
      }
      const msg = err instanceof Error ? err.message : 'Registration error';
      this.sendJson(res, status, { error: msg }, req);
    }
  }

  private async handleLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const ip = this.getClientIp(req);
    if (this.ipLoginLimiter && !this.ipLoginLimiter.consume(ip)) {
      this.sendJson(res, 429, { error: 'Too many login attempts' }, req);
      return;
    }

    const credentials = await this.readCredentials(req, res);
    if (!credentials) return;

    const userKey = `${ip}:${credentials.username}`;
    if (this.userLoginLimiter && !this.userLoginLimiter.consume(userKey)) {
      this.sendJson(
        res,
        429,
        { error: 'Too many login attempts for this account' },
        req,
      );
      return;
    }

    const user = await this.storage.getUserByUsername(credentials.username);
    const valid = user
      ? await user.verifyPassword(credentials.password)
      : await verifyDummyPasswordHash(credentials.password);

    if (!user || !valid) {
      this.ipLoginLimiter?.recordFailure(ip);
      this.userLoginLimiter?.recordFailure(userKey);
      this.sendJson(
        res,
        401,
        {
          error: 'Invalid username or password',
        },
        req,
      );
      return;
    }

    this.ipLoginLimiter?.reset(ip);
    this.userLoginLimiter?.reset(userKey);

    const token = await user.createToken();
    this.sendJson(
      res,
      200,
      {
        userId: user.id,
        username: user.username,
        token,
      },
      req,
    );
  }

  private async readCredentials(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<{ username: string; password: string } | null> {
    const body = await this.readJsonBody(req);
    const { username, password } = body as {
      username?: string;
      password?: string;
    };
    const normUsername = normalizeUsername(username ?? '');
    const normPassword = normalizePassword(password ?? '');
    if (!normUsername || !normPassword) {
      this.sendJson(
        res,
        400,
        {
          error: 'Missing or invalid required field: username and password',
        },
        req,
      );
      return null;
    }
    return { username: normUsername, password: normPassword };
  }

  private getClientIp(req: http.IncomingMessage): string {
    if (this.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') {
        const ips = forwarded
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ips.length > 0) return ips[ips.length - 1];
      }
    }
    return req.socket.remoteAddress ?? '127.0.0.1';
  }

  private acquireLockIfPersistent(port: number, host: string): void {
    const storageBaseDir = (
      this.storage as { baseDir?: string; inMemory?: boolean }
    ).baseDir;
    const isMemory =
      (this.storage as { inMemory?: boolean }).inMemory ??
      this.storage instanceof MemoryStorage;

    if (storageBaseDir && !isMemory) {
      if (
        this.lockHandle &&
        this.lockHandle.info.port === port &&
        this.lockHandle.info.host === host
      ) {
        return;
      }
      if (this.lockHandle) {
        this.lockHandle.release();
        this.lockHandle = null;
      }
      this.lockHandle = acquireServerLock(storageBaseDir, {
        port,
        host,
        backend: this.storage.backend,
        adminSecret: this.adminSecret,
      });
    }
  }
}

// -- Private Helpers --------------------------------------------------------

function getHttpStatusForError(err: unknown): number {
  if (err instanceof TetherServerError) {
    switch (err.code) {
      case TetherServerErrorCode.InvalidInput:
      case TetherServerErrorCode.ConfigurationError:
        return 400;
      case TetherServerErrorCode.Unauthorized:
      case TetherServerErrorCode.AuthenticationFailed:
        return 401;
      case TetherServerErrorCode.Forbidden:
        return 403;
      case TetherServerErrorCode.NotFound:
        return 404;
      case TetherServerErrorCode.AlreadyExists:
        return 409;
      case TetherServerErrorCode.LimitExceeded:
        return 413;
      case TetherServerErrorCode.NotSupported:
        return 501;
      case TetherServerErrorCode.InternalError:
        return 500;
    }
  }
  return 500;
}
