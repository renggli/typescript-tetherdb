import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import { normalizeBasePath } from '../shared/path.js';
import type { TableRow, TableSettings } from '../shared/types.js';
import {
  type CorsOptions,
  getHttpStatusForError,
  handleAdminRequest,
  handleCorsPreflight,
  handleHealth,
  handleMetrics,
  handleReady,
  sendJson,
} from './http/index.js';
import { acquireServerLock, type ServerLockHandle } from './shared/lock.js';
import { RateLimiter } from './shared/rate-limiter.js';
import { validateTableName } from './shared/validate.js';
import type { Storage, TableStorage, UserStorage } from './storage/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import { Sync } from './sync.js';

export type { CorsOptions };

/**
 * Rate limiting and resource control options for WebSocket connections and authentication streams.
 */
export interface RateLimitOptions {
  /** Sliding window duration in milliseconds (defaults to 60,000ms / 1 minute). */
  windowMs?: number;
  /** Maximum duration in milliseconds to wait for authentication before terminating socket (defaults to 10,000ms). */
  authTimeoutMs?: number;
  /** Maximum concurrent active connections allowed per user channel (defaults to 20). */
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
  /** Maximum connection handshakes per IP within the time window (defaults to 100). */
  ipSyncMaxRequests?: number;
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
  /** Path for sync endpoint requests (defaults to basePath or '/tether'). */
  webSocketPath?: string;
  /** Whether user self-registration is allowed via WebSocket (defaults to true). */
  allowRegistration?: boolean;
  /** Rate limiting options for WebSocket handshakes and auth, or `false` to disable rate limiting (defaults to true). */
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
 * Options for launching a standalone server via `startServer()`.
 */
export interface StartServerOptions extends TetherServerOptions {
  /** Port number to listen on (defaults to 8080). Pass `0` for an ephemeral OS-assigned port. */
  port?: number;
  /** Hostname or IP address to bind against (defaults to '0.0.0.0'). */
  host?: string;
  /** Filepath to write the server process lockfile to (defaults to `server.lock` in backend base directory). */
  lockFile?: string;
  /** Filepath to persist or read the server secret key (defaults to `.secret` in backend base directory). */
  keyFile?: string;
}

/**
 * Active server handle returned by `startServer()`.
 */
export interface RunningServer {
  /** The underlying TetherServer application instance. */
  readonly server: TetherServer;
  /** The active Node.js HTTP server instance. */
  readonly httpServer: http.Server;
  /** Bound host address. */
  readonly host: string;
  /** Bound port number. */
  readonly port: number;
  /** Root URL for the running server (e.g. 'http://127.0.0.1:8080'). */
  readonly url: string;
  /** Closes server listeners cleanly. */
  close(): Promise<void>;
}

/**
 * Starts a complete standalone synchronization server.
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
 * Unified HTTP and WebSocket server handling administration routes (`/admin/*`),
 * health/metrics probes, and real-time synchronization streams.
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
  /** Whether X-Forwarded-For is trusted for resolving client IPs. */
  readonly trustProxy: boolean;

  private readonly corsConfig: CorsOptions | null;
  private readonly logger: TetherLogger | null;
  private readonly adminSecret: string;

  private _httpServer: http.Server | null = null;
  private _webSocketServer: WebSocketServer | null = null;
  private lockHandle: ServerLockHandle | null = null;

  /**
   * Initializes a new TetherServer instance.
   *
   * @param options - Configuration options for storage, endpoints, and rate limiting.
   */
  constructor(options: TetherServerOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.basePath = normalizeBasePath(options.basePath ?? '');
    this.webSocketPath =
      options.webSocketPath ??
      (this.basePath === '' ? '/tether' : `${this.basePath}/tether`);
    const allowRegistration = options.allowRegistration ?? true;
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
      this.sync = new Sync(this.storage, {
        maxConcurrentConnectionsPerUser: 1_000,
        authTimeoutMs: 0,
        allowRegistration,
        rateLimiter: null,
        ipLoginLimiter: null,
        userLoginLimiter: null,
        ipRegisterLimiter: null,
        logger: this.logger,
      });
    } else {
      const opts: RateLimitOptions =
        typeof rateLimitConfig === 'object' ? rateLimitConfig : {};
      const windowMs = opts.windowMs ?? 60_000;
      const maxFailures = opts.maxFailures ?? 5;
      const initialBackoffMs = opts.initialBackoffMs ?? 1_000;
      const maxBackoffMs = opts.maxBackoffMs ?? 900_000;

      const ipLoginLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.ipLoginMaxRequests ?? 100,
        maxFailures,
        initialBackoffMs,
        maxBackoffMs,
      });
      const userLoginLimiter = new RateLimiter({
        windowMs,
        maxRequests: opts.userLoginMaxRequests ?? 20,
        maxFailures,
        initialBackoffMs,
        maxBackoffMs,
      });
      const ipRegisterLimiter = new RateLimiter({
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
        allowRegistration,
        rateLimiter: syncLimiter,
        ipLoginLimiter,
        userLoginLimiter,
        ipRegisterLimiter,
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
   * Starts the HTTP and WebSocket server listening on the specified port and host.
   *
   * @param port - Port number to bind (defaults to 8080).
   * @param host - Host interface to bind (defaults to '0.0.0.0').
   * @returns The active Node.js HTTP server instance.
   */
  async listen(port = 8080, host = '0.0.0.0'): Promise<http.Server> {
    this.acquireLockIfPersistent(port, host);

    return new Promise<http.Server>((resolve, reject) => {
      this._httpServer = http.createServer(async (req, res) => {
        const handled = await this.handleHttpRequest(req, res);
        if (!handled) {
          sendJson(res, 404, { error: 'Not found' }, this.corsConfig, req);
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
      const protocol = req.headers['sec-websocket-protocol'];
      if (
        typeof protocol === 'string' &&
        (protocol === 'vite-hmr' || protocol.includes('vite-hmr'))
      ) {
        return;
      }
      const url = new URL(
        req.url ?? '',
        `http://${req.headers.host ?? 'localhost'}`,
      );
      const pathname = url.pathname.replace(/\/$/, '') || '/';
      const targetPath = this.webSocketPath.replace(/\/$/, '') || '/';
      if (pathname === targetPath) {
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

    const releaseLock = () => {
      if (this.lockHandle) {
        this.lockHandle.release();
        this.lockHandle = null;
      }
    };

    if (typeof server.once === 'function') {
      server.once('close', releaseLock);
    } else if (typeof server.on === 'function') {
      server.on('close', releaseLock);
    }
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
   * Handles incoming HTTP requests for administration, discovery, and system probes.
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
      handleCorsPreflight(req, res, this.corsConfig);
      return true;
    }

    try {
      if (method === 'GET' && url.pathname === `${this.basePath}/health`) {
        handleHealth(req, res, this.corsConfig);
        return true;
      }

      if (method === 'GET' && url.pathname === `${this.basePath}/ready`) {
        await handleReady(req, res, this.storage, this.corsConfig, this.logger);
        return true;
      }

      if (method === 'GET' && url.pathname === `${this.basePath}/metrics`) {
        await handleMetrics(
          req,
          res,
          this.storage,
          this.sync.connectedClientsCount,
          this.corsConfig,
        );
        return true;
      }

      if (url.pathname.startsWith(`${this.basePath}/admin`)) {
        return await handleAdminRequest(req, res, url, this.basePath, {
          storage: this.storage,
          adminSecret: this.adminSecret,
          corsConfig: this.corsConfig,
          closeServer: () => this.close(),
        });
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
      sendJson(res, status, { error: msg }, this.corsConfig, req);
      return true;
    }
  }

  /**
   * Declares a table with optional settings and initial rows.
   * Creates the table if not already present, updates its settings, and inserts initial rows.
   *
   * @param name - Name of the table.
   * @param settings - Optional table settings.
   * @param rows - Optional array of table rows to insert if not already present.
   * @returns TableStorage handle for the declared table.
   */
  async declareTable(
    name: string,
    settings?: TableSettings,
    rows?: TableRow[],
  ): Promise<TableStorage> {
    const safeName = validateTableName(name);
    let table = await this.storage.getTable(safeName);
    if (!table) {
      table = await this.storage.createTable(safeName, settings);
    } else if (settings) {
      await table.updateSettings(settings);
    }
    const initialRows = rows ?? settings?.rows;
    if (initialRows && initialRows.length > 0 && table.insertRows) {
      await table.insertRows(initialRows);
    }
    return table;
  }

  /**
   * Declares a user account with the specified username and password.
   * Creates the user if not already registered, or updates the existing user's password.
   *
   * @param userName - Username for the account.
   * @param password - Plaintext password for the account.
   * @returns UserStorage handle for the declared user.
   */
  async declareUser(userName: string, password: string): Promise<UserStorage> {
    const user = await this.storage.getUserByUserName(userName);
    if (user) {
      await user.changePassword(password);
      return user;
    }
    return this.storage.createUser(userName, password);
  }

  // -- Private Helpers --------------------------------------------------------

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
