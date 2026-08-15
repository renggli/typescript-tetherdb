import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import type { ServerLimits } from '../shared/types.js';
import { AuthManager, type AuthManagerOptions } from './auth.js';
import type { StorageAdapter } from './storage/adapter.js';
import { FileStorageAdapter } from './storage/file.js';
import { MemoryStorageAdapter } from './storage/memory.js';
import { SyncHub } from './sync-hub.js';

/**
 * Configuration options for the BeamedServer.
 */
export interface BeamedServerOptions {
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
 * Unified HTTP and WebSocket server handling authentication endpoints (`/auth/register`, `/auth/login`)
 * and real-time streaming WebSocket connections (`/sync`).
 */
export class BeamedServer {
  private storage: StorageAdapter;
  private authManager: AuthManager;
  private syncHub: SyncHub;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private wsPath: string;

  /**
   * Initializes a new BeamedServer instance.
   *
   * @param options - Configuration options for storage, authentication, and endpoints.
   */
  constructor(options: BeamedServerOptions = {}) {
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
   * Handles incoming HTTP requests for authentication and health check endpoints.
   *
   * @param req - The HTTP incoming request.
   * @param res - The HTTP server response.
   * @returns A promise resolving to `true` if the request was handled by BeamedServer; otherwise `false`.
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      return true;
    }

    if (method === 'POST' && url.pathname === '/auth/register') {
      try {
        const body = await this.readJsonBody<{
          username?: string;
          password?: string;
        }>(req);
        if (!body.username || !body.password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Username and password are required' }),
          );
          return true;
        }
        const result = await this.authManager.register(
          body.username,
          body.password,
        );
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Registration failed';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return true;
    }

    if (method === 'POST' && url.pathname === '/auth/login') {
      try {
        const body = await this.readJsonBody<{
          username?: string;
          password?: string;
        }>(req);
        if (!body.username || !body.password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Username and password are required' }),
          );
          return true;
        }
        const result = await this.authManager.login(
          body.username,
          body.password,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Authentication failed';
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return true;
    }

    return false;
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
   * @param host - Host interface to bind (defaults to 'localhost').
   * @returns A promise resolving to the running `http.Server`.
   */
  async listen(port: number, host = 'localhost'): Promise<http.Server> {
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
