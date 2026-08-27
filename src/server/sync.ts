import type { WebSocket } from 'ws';
import {
  type AuthClientMessage,
  type ChangeBatchClientMessage,
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageType,
  type SnapshotRecord,
} from '../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from './errors.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TetherLogger } from './server.js';
import { canRead, isPrivateTable } from './storage/base/index.js';
import type { Storage } from './storage/storage.js';
import type { TableStorage } from './storage/table.js';
import type { UserStorage } from './storage/user.js';
import { calculateByteSize, validateIdentifier } from './validate.js';

/**
 * Configuration options for the WebSocket synchronization coordinator.
 */
export interface SyncOptions {
  /** Maximum number of concurrent active connections allowed per user channel (defaults to 20). */
  maxConcurrentConnectionsPerUser?: number;
  /** Maximum duration in milliseconds to wait for authentication before terminating socket (defaults to 10,000ms). */
  authTimeoutMs?: number;
  /** Optional rate limiter for connection handshakes and invalid token tracking. */
  rateLimiter?: RateLimiter | null;
  /** Optional logger instance (or null to suppress internal error logs). */
  logger?: TetherLogger | null;
}

/**
 * Real-time WebSocket synchronization coordinator managing authentication handshakes,
 * snapshot/diff delivery, change ingestion, acknowledgments, and peer broadcasts per table and user.
 */
export class Sync {
  private readonly storage: Storage;
  private readonly maxConcurrentConnectionsPerUser: number;
  private readonly authTimeoutMs: number;
  private readonly rateLimiter: RateLimiter | null;
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
    this.rateLimiter = options.rateLimiter ?? null;
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
        if (c.user?.id === user.id) userCount++;
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
      userId: user?.id ?? 'anonymous',
      currentSeq,
      token: refreshedToken,
    });

    // Initial sync: snapshot or diff
    await this.performSync(client, msg.lastSyncSeq, msg.tables);
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
      ? ` (user: "${client.user?.id ?? 'guest'}", client: "${client.clientId}")`
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

    this.send(client.webSocket, {
      type: ServerMessageType.SyncDiff,
      fromSeq: seq,
      toSeq: currentSeq,
      changes,
    });
  }

  private async buildSnapshot(
    user?: UserStorage,
    tableFilters?: string[],
  ): Promise<SnapshotRecord[]> {
    const tables = await this.storage.getTables();
    const snapshot: SnapshotRecord[] = [];

    for (const table of tables) {
      if (tableFilters && !tableFilters.includes(table.name)) continue;
      if (!canRead(table, user)) continue;
      const records = await table.getAllRecords(user);
      snapshot.push(...records);
    }

    return snapshot;
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
            if (client.user && senderUser && client.user.id === senderUser.id) {
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
}

// -- Private Types ----------------------------------------------------------

interface ActiveClient {
  webSocket: WebSocket;
  clientId: string;
  user?: UserStorage;
  tables?: string[];
}
