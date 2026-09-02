import * as crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  type AuthClientMessage,
  type ChangeBatchClientMessage,
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  type LoginClientMessage,
  type LogoutClientMessage,
  PROTOCOL_VERSION,
  type RegisterClientMessage,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from './errors.js';
import { filterAndSanitizeSnapshot } from './security/filter.js';
import { UserResolver } from './security/resolver.js';
import type { TetherLogger } from './server.js';
import { verifyDummyPasswordHash } from './shared/crypto.js';
import type { RateLimiter } from './shared/rate-limiter.js';
import {
  calculateByteSize,
  normalizeUserName,
  validateIdentifier,
} from './shared/validate.js';
import type { Storage } from './storage/storage.js';
import type { Table } from './storage/table.js';
import type { User } from './storage/user.js';

/**
 * Configuration options for the synchronization coordinator.
 */
export interface SyncOptions {
  /** Maximum number of concurrent active connections allowed per user channel (defaults to 20). */
  maxConcurrentConnectionsPerUser?: number;
  /** Maximum duration in milliseconds to wait for authentication before terminating socket (defaults to 10,000ms). */
  authTimeoutMs?: number;
  /** Whether user self-registration is allowed (defaults to true). */
  allowRegistration?: boolean;
  /** Optional rate limiter for connection handshakes and invalid token tracking. */
  rateLimiter?: RateLimiter | null;
  /** Optional rate limiter for IP-based login requests. */
  ipLoginLimiter?: RateLimiter | null;
  /** Optional rate limiter for user-based login requests. */
  userLoginLimiter?: RateLimiter | null;
  /** Optional rate limiter for IP-based registration requests. */
  ipRegisterLimiter?: RateLimiter | null;
  /** Optional logger instance (or null to suppress internal error logs). */
  logger?: TetherLogger | null;
}

/**
 * Real-time synchronization coordinator managing authentication handshakes,
 * snapshot/diff delivery, change ingestion, acknowledgments, and peer broadcasts per table and user.
 */
export class Sync {
  private readonly storage: Storage;
  private readonly maxConcurrentConnectionsPerUser: number;
  private readonly authTimeoutMs: number;
  private readonly allowRegistration: boolean;
  private readonly rateLimiter: RateLimiter | null;
  private readonly ipLoginLimiter: RateLimiter | null;
  private readonly userLoginLimiter: RateLimiter | null;
  private readonly ipRegisterLimiter: RateLimiter | null;
  private readonly logger: TetherLogger | null;
  private readonly clients = new Set<ActiveClient>();
  private readonly webSocketToClient = new Map<WebSocket, ActiveClient>();
  private readonly pendingAuthTimers = new Map<WebSocket, NodeJS.Timeout>();
  private readonly webSocketToIp = new Map<WebSocket, string>();

  /**
   * Initializes a new Sync coordinator instance.
   *
   * @param storage - Pluggable backend storage engine.
   * @param options - Configuration options for concurrency limits, auth timeout, and rate limiting.
   */
  constructor(storage: Storage, options: SyncOptions = {}) {
    this.storage = storage;
    this.maxConcurrentConnectionsPerUser =
      options.maxConcurrentConnectionsPerUser ?? 20;
    this.authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.allowRegistration = options.allowRegistration ?? true;
    this.rateLimiter = options.rateLimiter ?? null;
    this.ipLoginLimiter = options.ipLoginLimiter ?? null;
    this.userLoginLimiter = options.userLoginLimiter ?? null;
    this.ipRegisterLimiter = options.ipRegisterLimiter ?? null;
    this.logger = options.logger ?? null;
  }

  /**
   * Total number of currently active authenticated WebSocket client connections.
   */
  get connectedClientsCount(): number {
    return this.webSocketToClient.size;
  }

  /**
   * Handles an incoming WebSocket connection, binding message, error, and disconnection events.
   *
   * @param webSocket - Active WebSocket connection.
   * @param clientIp - Remote client IP address.
   */
  handleConnection(webSocket: WebSocket, clientIp = '127.0.0.1'): void {
    this.webSocketToIp.set(webSocket, clientIp);

    if (this.rateLimiter && !this.rateLimiter.consume(clientIp)) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Too many connection attempts',
      });
      webSocket.close();
      return;
    }

    if (this.authTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (!this.webSocketToClient.has(webSocket)) {
          this.send(webSocket, {
            type: ServerMessageType.AuthError,
            message: 'Authentication timeout',
          });
          webSocket.close();
        }
      }, this.authTimeoutMs);
      this.pendingAuthTimers.set(webSocket, timer);
    }

    const maxPendingMessages = 1000;
    const maxPendingBytes = 10 * 1024 * 1024;
    let pendingCount = 0;
    let pendingBytes = 0;
    let messageQueue: Promise<void> = Promise.resolve();

    webSocket.on('message', (data) => {
      const userContext = this.getClientContext(webSocket);
      const dataLength =
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : Array.isArray(data)
            ? data.reduce((acc, chunk) => acc + chunk.length, 0)
            : (data as Buffer).length;

      if (
        pendingCount >= maxPendingMessages ||
        pendingBytes + dataLength > maxPendingBytes
      ) {
        this.logger?.warn(
          `[TetherServer.Sync] WebSocket message queue exceeded limit${userContext}`,
        );
        this.send(webSocket, {
          type: ServerMessageType.Error,
          message: 'Message queue limit exceeded',
        });
        webSocket.terminate();
        return;
      }

      pendingCount++;
      pendingBytes += dataLength;
      messageQueue = messageQueue
        .then(async () => {
          try {
            const raw = typeof data === 'string' ? data : data.toString();
            const msg = JSON.parse(raw) as ClientMessage;
            await this.handleMessage(webSocket, msg);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Unknown server error';
            this.logger?.error(
              `[TetherServer.Sync] Error processing WebSocket message${userContext}:`,
              err,
            );
            this.send(webSocket, {
              type: ServerMessageType.Error,
              message,
            });
          } finally {
            pendingCount--;
            pendingBytes -= dataLength;
          }
        })
        .catch((err) => {
          pendingCount--;
          pendingBytes -= dataLength;
          this.logger?.error(
            `[TetherServer.Sync] Unhandled error in message queue${userContext}:`,
            err,
          );
        });
    });

    webSocket.on('error', (err) => {
      const userContext = this.getClientContext(webSocket);
      this.logger?.error(
        `[TetherServer.Sync] WebSocket connection error${userContext}:`,
        err,
      );
      this.cleanupConnection(webSocket);
    });

    webSocket.on('close', () => {
      this.cleanupConnection(webSocket);
    });
  }

  /**
   * Routes and executes incoming client protocol messages.
   *
   * @param webSocket - The connection that sent the message.
   * @param msg - Parsed client protocol message.
   */
  async handleMessage(webSocket: WebSocket, msg: ClientMessage): Promise<void> {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        'Invalid message format',
      );
    }

    switch (msg.type) {
      case ClientMessageType.Auth:
        await this.handleAuthMessage(webSocket, msg);
        break;

      case ClientMessageType.Register:
        await this.handleRegisterMessage(webSocket, msg);
        break;

      case ClientMessageType.Login:
        await this.handleLoginMessage(webSocket, msg);
        break;

      case ClientMessageType.Logout:
        await this.handleLogoutMessage(webSocket, msg);
        break;

      case ClientMessageType.ChangeBatch:
        await this.handleChangeBatchMessage(webSocket, msg);
        break;

      case ClientMessageType.Ping:
        this.handlePingMessage(webSocket);
        break;

      default:
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          'Unsupported message type',
        );
    }
  }

  // -- Private Message Handlers ---------------------------------------------

  private async handleAuthMessage(
    webSocket: WebSocket,
    msg: AuthClientMessage,
  ): Promise<void> {
    const ip = this.webSocketToIp.get(webSocket) ?? '127.0.0.1';

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.rateLimiter?.recordFailure(ip);
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: `Unsupported protocol version: expected ${PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
      });
      webSocket.close();
      return;
    }

    let user: User | undefined;
    if (typeof msg.token === 'string' && msg.token) {
      user = await this.storage.getUserByToken(msg.token);
      if (!user) {
        this.rateLimiter?.recordFailure(ip);
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          message: 'Invalid or expired authentication token',
        });
        webSocket.close();
        return;
      }
    }

    if (user) {
      let userCount = 0;
      for (const c of this.clients) {
        if (c.user?.userId === user.userId) userCount++;
      }
      if (userCount >= this.maxConcurrentConnectionsPerUser) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          message: 'Maximum concurrent connections exceeded for this user',
        });
        webSocket.close();
        return;
      }
    }

    this.rateLimiter?.reset(ip);

    const clientId = validateIdentifier(
      msg.clientId ?? 'client_anon',
      'clientId',
    );
    const existingClient = this.webSocketToClient.get(webSocket);
    if (existingClient) {
      this.clients.delete(existingClient);
      this.webSocketToClient.delete(webSocket);
    }

    const client: ActiveClient = {
      webSocket,
      clientId,
      user,
      tables: Array.isArray(msg.tables) ? msg.tables : undefined,
    };

    this.webSocketToClient.set(webSocket, client);
    this.clients.add(client);
    this.clearPendingAuthTimer(webSocket);

    const currentSeq = await this.storage.getCurrentSeq(user);
    const refreshedToken = user ? await user.createToken() : undefined;
    this.send(webSocket, {
      type: ServerMessageType.AuthSuccess,
      protocolVersion: PROTOCOL_VERSION,
      userName: user?.userName,
      currentSeq,
      token: refreshedToken,
    });

    // Initial sync: snapshot or diff
    await this.performSync(client, msg.lastSyncSeq, msg.tables);
  }

  private async handleRegisterMessage(
    webSocket: WebSocket,
    msg: RegisterClientMessage,
  ): Promise<void> {
    const ip = this.webSocketToIp.get(webSocket) ?? '127.0.0.1';

    if (!this.allowRegistration) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Registration is disabled on this server',
      });
      return;
    }

    if (!msg.userName || !msg.password) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Username and password are required',
      });
      return;
    }

    if (this.ipRegisterLimiter && !this.ipRegisterLimiter.consume(ip)) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Registration rate limit exceeded for this IP',
      });
      return;
    }

    let safeUserName: string;
    try {
      safeUserName = validateIdentifier(msg.userName, 'userName');
    } catch {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Invalid username format',
      });
      return;
    }

    const existingUser = await this.storage.getUserByUserName(safeUserName);
    if (existingUser) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Username already taken',
      });
      return;
    }

    let user: User;
    try {
      user = await this.storage.createUser(safeUserName, msg.password);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed';
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message,
      });
      return;
    }

    await this.completeAuthentication(webSocket, user, msg.requestId);
  }

  private async handleLoginMessage(
    webSocket: WebSocket,
    msg: LoginClientMessage,
  ): Promise<void> {
    const ip = this.webSocketToIp.get(webSocket) ?? '127.0.0.1';

    let user: User | undefined;

    if (msg.userName !== undefined && msg.password !== undefined) {
      if (!msg.userName || !msg.password) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Username and password cannot be empty',
        });
        return;
      }

      if (this.ipLoginLimiter && !this.ipLoginLimiter.consume(ip)) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Too many login attempts',
        });
        return;
      }

      const normalizedTarget = normalizeUserName(msg.userName);
      const userKey = `user:${normalizedTarget}`;
      if (this.userLoginLimiter && !this.userLoginLimiter.consume(userKey)) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Too many login attempts for this account',
        });
        return;
      }

      const candidateUser = await this.storage.getUserByUserName(msg.userName);
      const valid = candidateUser
        ? await candidateUser.verifyPassword(msg.password)
        : await verifyDummyPasswordHash(msg.password);

      if (!valid || !candidateUser) {
        this.ipLoginLimiter?.recordFailure(ip);
        this.userLoginLimiter?.recordFailure(userKey);
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Invalid username or password',
        });
        return;
      }

      this.ipLoginLimiter?.reset(ip);
      this.userLoginLimiter?.reset(userKey);
      user = candidateUser;
    } else if (msg.token) {
      if (this.ipLoginLimiter && !this.ipLoginLimiter.consume(ip)) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Too many login attempts',
        });
        return;
      }

      user = await this.storage.getUserByToken(msg.token);
      if (!user) {
        this.ipLoginLimiter?.recordFailure(ip);
        this.rateLimiter?.recordFailure(ip);
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Invalid or expired authentication token',
        });
        return;
      }

      this.ipLoginLimiter?.reset(ip);
      this.rateLimiter?.reset(ip);
    } else {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        requestId: msg.requestId,
        message: 'Missing login credentials or token',
      });
      return;
    }

    if (user) {
      let userCount = 0;
      for (const c of this.clients) {
        if (c.user?.userId === user.userId && c.webSocket !== webSocket) {
          userCount++;
        }
      }
      if (userCount >= this.maxConcurrentConnectionsPerUser) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Maximum concurrent connections exceeded for this user',
        });
        return;
      }
    }

    await this.completeAuthentication(webSocket, user, msg.requestId);
  }

  private async handleLogoutMessage(
    webSocket: WebSocket,
    msg: LogoutClientMessage,
  ): Promise<void> {
    const client = this.webSocketToClient.get(webSocket);
    if (client) {
      client.user = undefined;
    }

    const currentSeq = await this.storage.getCurrentSeq(undefined);

    this.send(webSocket, {
      type: ServerMessageType.AuthSuccess,
      requestId: msg.requestId,
      protocolVersion: PROTOCOL_VERSION,
      userName: undefined,
      currentSeq,
      token: undefined,
    });

    if (client) {
      await this.performSync(client, 0, client.tables);
    }
  }

  private async handleChangeBatchMessage(
    webSocket: WebSocket,
    msg: ChangeBatchClientMessage,
  ): Promise<void> {
    const client = this.webSocketToClient.get(webSocket);
    if (!client) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Not authenticated',
      });
      return;
    }

    if (!Array.isArray(msg.changes)) {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        'Invalid change batch: changes must be an array',
      );
    }

    const maxBatchSize =
      this.storage.options?.maxBatchSizeBytes ?? 5 * 1024 * 1024;
    const batchBytes = calculateByteSize(msg.changes);
    if (batchBytes > maxBatchSize) {
      throw new TetherServerError(
        TetherServerErrorCode.LimitExceeded,
        'Change batch exceeds maximum allowed size',
      );
    }

    const batchId = validateIdentifier(msg.batchId, 'batchId');

    const sanitizedChanges = msg.changes.map((change) => ({
      ...change,
      clientId: client.clientId,
    }));

    const { applied, newSeq } = await this.storage.applyChanges(
      client.user,
      sanitizedChanges,
    );

    // Acknowledge to sender
    this.send(webSocket, {
      type: ServerMessageType.ChangeAck,
      batchId,
      appliedSeq: newSeq,
    });

    // Broadcast applied changes to other active clients who have access to the modified tables
    if (applied.length > 0) {
      await this.broadcastChanges(webSocket, client.user, applied, newSeq);
    }
  }

  private handlePingMessage(webSocket: WebSocket): void {
    this.send(webSocket, {
      type: ServerMessageType.Pong,
    });
  }

  // -- Private Helpers ------------------------------------------------------

  private clearPendingAuthTimer(webSocket: WebSocket): void {
    const authTimer = this.pendingAuthTimers.get(webSocket);
    if (authTimer) {
      clearTimeout(authTimer);
      this.pendingAuthTimers.delete(webSocket);
    }
  }

  private getClientContext(webSocket: WebSocket): string {
    const client = this.webSocketToClient.get(webSocket);
    return client
      ? ` (user: "${client.user?.userId ?? 'guest'}", client: "${client.clientId}")`
      : '';
  }

  private cleanupConnection(webSocket: WebSocket): void {
    this.clearPendingAuthTimer(webSocket);
    this.webSocketToIp.delete(webSocket);

    const client = this.webSocketToClient.get(webSocket);
    if (!client) return;

    this.webSocketToClient.delete(webSocket);
    this.clients.delete(client);
  }

  private send(webSocket: WebSocket, msg: ServerMessage): void {
    if (webSocket.readyState === 1 /* OPEN */) {
      webSocket.send(JSON.stringify(msg));
    }
  }

  private async sendSyncSnapshot(
    client: ActiveClient,
    currentSeq: number,
    tableFilters?: string[],
  ): Promise<void> {
    const tables = await this.storage.getTables();
    const resolver = new UserResolver(this.storage);
    const snapshot = await filterAndSanitizeSnapshot(
      tables,
      client.user,
      resolver,
      tableFilters,
    );

    this.send(client.webSocket, {
      type: ServerMessageType.SyncSnapshot,
      seq: currentSeq,
      snapshot,
    });
  }

  private async performSync(
    client: ActiveClient,
    lastSyncSeq?: number,
    tableFilters?: string[],
  ): Promise<void> {
    const seq = lastSyncSeq ?? 0;

    if (seq === 0) {
      const currentSeq = await this.storage.getCurrentSeq(client.user);
      await this.sendSyncSnapshot(client, currentSeq, tableFilters);
      return;
    }

    const { changes, currentSeq, requiresSnapshot } =
      await this.storage.getChangesSince(client.user, seq, tableFilters);

    if (requiresSnapshot) {
      await this.sendSyncSnapshot(client, currentSeq, tableFilters);
      return;
    }

    this.send(client.webSocket, {
      type: ServerMessageType.SyncDiff,
      fromSeq: seq,
      toSeq: currentSeq,
      changes,
    });
  }

  private async broadcastChanges(
    senderWebSocket: WebSocket,
    senderUser: User | undefined,
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    const senderClient = this.webSocketToClient.get(senderWebSocket);
    const senderClientId = senderClient?.clientId ?? 'client_anon';
    const tableCache = new Map<string, Table | undefined>();

    for (const client of this.clients) {
      if (client.webSocket === senderWebSocket) continue;

      const clientChanges: ChangeRecord[] = [];
      for (const change of changes) {
        if (client.tables && !client.tables.includes(change.table)) continue;

        let table = tableCache.get(change.table);
        if (!table && !tableCache.has(change.table)) {
          table = await this.storage.getTable(change.table);
          tableCache.set(change.table, table);
        }

        if (table?.canRead(client.user)) {
          if (table.isPrivate) {
            if (
              client.user &&
              senderUser &&
              client.user.userId === senderUser.userId
            ) {
              clientChanges.push(change);
            }
          } else {
            clientChanges.push(change);
          }
        }
      }

      if (clientChanges.length > 0) {
        this.send(client.webSocket, {
          type: ServerMessageType.BroadcastChanges,
          fromClientId: senderClientId,
          changes: clientChanges,
          seq,
        });
      }
    }
  }

  private async completeAuthentication(
    webSocket: WebSocket,
    user: User,
    requestId?: string,
  ): Promise<void> {
    let client = this.webSocketToClient.get(webSocket);
    if (!client) {
      const clientId = `client_${crypto.randomBytes(4).toString('hex')}`;
      client = {
        webSocket,
        clientId,
        user,
      };
      this.webSocketToClient.set(webSocket, client);
      this.clients.add(client);
    } else {
      client.user = user;
    }
    this.clearPendingAuthTimer(webSocket);

    const currentSeq = await this.storage.getCurrentSeq(user);
    const token = await user.createToken();

    this.send(webSocket, {
      type: ServerMessageType.AuthSuccess,
      requestId,
      protocolVersion: PROTOCOL_VERSION,
      userName: user.userName,
      currentSeq,
      token,
    });

    await this.performSync(client, 0, client.tables);
  }
}

// -- Private Types ----------------------------------------------------------

interface ActiveClient {
  webSocket: WebSocket;
  clientId: string;
  user?: User;
  tables?: string[];
}
