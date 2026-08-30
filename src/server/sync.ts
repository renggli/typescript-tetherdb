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
  type SnapshotRecord,
} from '../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from './errors.js';
import type { TetherLogger } from './server.js';
import { verifyDummyPasswordHash } from './shared/crypto.js';
import type { RateLimiter } from './shared/rate-limiter.js';
import {
  calculateByteSize,
  normalizeUserName,
  validateIdentifier,
} from './shared/validate.js';
import { canRead, isPrivateTable } from './storage/base/index.js';
import type { Storage } from './storage/storage.js';
import type { TableStorage } from './storage/table.js';
import type { UserStorage } from './storage/user.js';

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

    let messageQueue: Promise<void> = Promise.resolve();

    webSocket.on('message', (data) => {
      const userContext = this.getClientContext(webSocket);

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
          }
        })
        .catch((err) => {
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
    this.clearPendingAuthTimer(webSocket);

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.rateLimiter?.recordFailure(ip);
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: `Unsupported protocol version: expected ${PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
      });
      webSocket.close();
      return;
    }

    let user: UserStorage | undefined;
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
    this.clearPendingAuthTimer(webSocket);

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

    let user: UserStorage;
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
    this.clearPendingAuthTimer(webSocket);

    let user: UserStorage | undefined;

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
      user = await this.storage.getUserByToken(msg.token);
      if (!user) {
        this.send(webSocket, {
          type: ServerMessageType.AuthError,
          requestId: msg.requestId,
          message: 'Invalid or expired authentication token',
        });
        return;
      }
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

    const { applied, newSeq } = await this.storage.applyChanges(
      client.user,
      msg.changes,
    );

    // Acknowledge to sender
    this.send(webSocket, {
      type: ServerMessageType.ChangeAck,
      batchId,
      appliedSeq: newSeq,
    });

    // Broadcast applied changes to other active clients who have access to the modified tables
    if (applied.length > 0) {
      await this.broadcastChanges(
        client.clientId,
        client.user,
        applied,
        newSeq,
      );
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
    const snapshot = await this.buildSnapshot(client.user, tableFilters);
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

    const populatedChanges = await this.populateChangeUserNames(
      changes,
      client.user,
    );

    this.send(client.webSocket, {
      type: ServerMessageType.SyncDiff,
      fromSeq: seq,
      toSeq: currentSeq,
      changes: populatedChanges,
    });
  }

  private async buildSnapshot(
    user?: UserStorage,
    tableFilters?: string[],
  ): Promise<SnapshotRecord[]> {
    const snapshot: SnapshotRecord[] = [];
    const tables = await this.storage.getTables();
    const userCache = new Map<string, string>();

    for (const table of tables) {
      if (!canRead(table, user)) continue;
      if (tableFilters && !tableFilters.includes(table.name)) continue;

      const records = await table.getAllRecords(user);
      for (const rec of records) {
        let userName = rec.userName;
        const internalUserId = (rec as { userId?: string }).userId;
        if (internalUserId && !userName) {
          userName = await this.resolveUserName(
            internalUserId,
            user,
            userCache,
          );
        }
        snapshot.push({
          table: rec.table,
          id: rec.id,
          data: rec.data,
          version: rec.version,
          timestamp: rec.timestamp,
          deleted: rec.deleted,
          clientId: rec.clientId,
          userName,
        });
      }
    }
    return snapshot;
  }

  private async populateChangeUserNames(
    changes: ChangeRecord[],
    user?: UserStorage,
    userCache = new Map<string, string>(),
  ): Promise<ChangeRecord[]> {
    const populated: ChangeRecord[] = [];
    for (const change of changes) {
      let userName = change.userName ?? user?.userName;
      const internalUserId = (change as { userId?: string }).userId;
      if (internalUserId && !userName) {
        userName = await this.resolveUserName(internalUserId, user, userCache);
      }
      populated.push({
        table: change.table,
        id: change.id,
        op: change.op,
        data: change.data,
        version: change.version,
        seq: change.seq,
        timestamp: change.timestamp,
        clientId: change.clientId,
        userName,
      });
    }
    return populated;
  }

  private async resolveUserName(
    userId?: string,
    user?: UserStorage,
    userCache?: Map<string, string>,
  ): Promise<string | undefined> {
    if (!userId) return undefined;
    if (user && userId === user.userId) return user.userName;
    if (userCache?.has(userId)) return userCache.get(userId);

    const foundUser = await this.storage.getUser(userId);
    if (foundUser) {
      userCache?.set(userId, foundUser.userName);
      return foundUser.userName;
    }
    return undefined;
  }

  private async broadcastChanges(
    senderClientId: string,
    senderUser: UserStorage | undefined,
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    const tableCache = new Map<string, TableStorage | undefined>();

    for (const client of this.clients) {
      if (client.clientId === senderClientId) continue;

      const clientChanges: ChangeRecord[] = [];
      for (const change of changes) {
        if (client.tables && !client.tables.includes(change.table)) continue;

        let table = tableCache.get(change.table);
        if (!table && !tableCache.has(change.table)) {
          table = await this.storage.getTable(change.table);
          tableCache.set(change.table, table);
        }

        if (table && canRead(table, client.user)) {
          const isPrivate = isPrivateTable(table);
          if (isPrivate) {
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
        const populatedChanges = await this.populateChangeUserNames(
          clientChanges,
          client.user ?? senderUser,
        );

        this.send(client.webSocket, {
          type: ServerMessageType.BroadcastChanges,
          fromClientId: senderClientId,
          changes: populatedChanges,
          seq,
        });
      }
    }
  }

  private async completeAuthentication(
    webSocket: WebSocket,
    user: UserStorage,
    requestId?: string,
  ): Promise<void> {
    let client = this.webSocketToClient.get(webSocket);
    if (!client) {
      const clientId = `client_${Math.random().toString(36).substring(2, 8)}`;
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
  user?: UserStorage;
  tables?: string[];
}
