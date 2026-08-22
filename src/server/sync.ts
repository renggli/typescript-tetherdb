import type { WebSocket } from 'ws';
import {
  type AuthClientMessage,
  type ChangeBatchClientMessage,
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
import type { AppStorage } from './storage/app.js';
import type { Storage } from './storage/storage.js';
import type { UserStorage } from './storage/user.js';
import {
  calculateByteSize,
  validateAppId,
  validateIdentifier,
} from './validate.js';

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
 * snapshot/diff delivery, change ingestion, acknowledgments, and peer broadcasts per application and user.
 */
export class Sync {
  private readonly storage: Storage;
  private readonly maxConcurrentConnectionsPerUser: number;
  private readonly authTimeoutMs: number;
  private readonly rateLimiter: RateLimiter | null;
  private readonly logger: TetherLogger | null;
  private readonly userClients = new Map<string, Set<ActiveClient>>(); // key = `${appId}:${userId}`
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
      const client = this.webSocketToClient.get(webSocket);
      const userContext = client
        ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
        : '';

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
      const client = this.webSocketToClient.get(webSocket);
      const userContext = client
        ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
        : '';
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

    const authTimer = this.pendingAuthTimers.get(webSocket);
    if (authTimer) {
      clearTimeout(authTimer);
      this.pendingAuthTimers.delete(webSocket);
    }

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.rateLimiter?.recordFailure(ip);
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: `Unsupported protocol version: expected ${PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
      });
      webSocket.close();
      return;
    }

    if (typeof msg.token !== 'string' || !msg.token) {
      this.rateLimiter?.recordFailure(ip);
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Missing or invalid authentication token',
      });
      webSocket.close();
      return;
    }

    const user = await this.storage.getUserByToken(msg.token);
    if (!user) {
      this.rateLimiter?.recordFailure(ip);
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Invalid or expired authentication token',
      });
      webSocket.close();
      return;
    }

    if (typeof msg.appId !== 'string' || !msg.appId) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Missing required field: appId',
      });
      webSocket.close();
      return;
    }

    const appId = validateAppId(msg.appId);
    const app = await this.storage.getApp(appId);
    if (!app) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Application not found',
      });
      webSocket.close();
      return;
    }

    const channelKey = `${appId}:${user.id}`;
    let set = this.userClients.get(channelKey);
    if (!set) {
      set = new Set();
      this.userClients.set(channelKey, set);
    }

    if (set.size >= this.maxConcurrentConnectionsPerUser) {
      this.send(webSocket, {
        type: ServerMessageType.AuthError,
        message: 'Maximum concurrent connections exceeded for this user',
      });
      webSocket.close();
      return;
    }

    this.rateLimiter?.reset(ip);

    const clientId = validateIdentifier(
      msg.clientId ?? 'client_anon',
      'clientId',
    );
    const existingClient = this.webSocketToClient.get(webSocket);
    if (existingClient) {
      const oldChannelKey = `${existingClient.appId}:${existingClient.user.id}`;
      const oldSet = this.userClients.get(oldChannelKey);
      if (oldSet) {
        oldSet.delete(existingClient);
        if (oldSet.size === 0) {
          this.userClients.delete(oldChannelKey);
        }
      }
      this.webSocketToClient.delete(webSocket);
    }

    const client: ActiveClient = {
      webSocket,
      clientId,
      user,
      appId,
    };

    this.webSocketToClient.set(webSocket, client);
    set.add(client);

    const currentSeq = await app.getCurrentSeq(user);
    const refreshedToken = await user.createToken();
    this.send(webSocket, {
      type: ServerMessageType.AuthSuccess,
      protocolVersion: PROTOCOL_VERSION,
      userId: user.id,
      currentSeq,
      token: refreshedToken,
    });

    // Initial sync: snapshot or diff
    await this.performSync(client, msg.lastSyncSeq);
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

    const app = await this.storage.getApp(client.appId);
    if (!app) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'Application not found',
      );
    }

    const { applied, newSeq } = await app.applyChanges(
      client.user,
      msg.changes,
    );

    // Acknowledge to sender
    this.send(webSocket, {
      type: ServerMessageType.ChangeAck,
      batchId,
      appliedSeq: newSeq,
    });

    // Broadcast applied changes to other active clients of the same app and user
    if (applied.length > 0) {
      this.broadcastToAppUser(client.appId, client.user.id, client.clientId, {
        type: ServerMessageType.BroadcastChanges,
        fromClientId: client.clientId,
        changes: applied,
        seq: newSeq,
      });
    }
  }

  private handlePingMessage(webSocket: WebSocket): void {
    this.send(webSocket, {
      type: ServerMessageType.Pong,
    });
  }

  // -- Private Helpers ------------------------------------------------------

  private cleanupConnection(webSocket: WebSocket): void {
    const authTimer = this.pendingAuthTimers.get(webSocket);
    if (authTimer) {
      clearTimeout(authTimer);
      this.pendingAuthTimers.delete(webSocket);
    }
    this.webSocketToIp.delete(webSocket);

    const client = this.webSocketToClient.get(webSocket);
    if (!client) return;

    this.webSocketToClient.delete(webSocket);
    const channelKey = `${client.appId}:${client.user.id}`;
    const set = this.userClients.get(channelKey);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.userClients.delete(channelKey);
      }
    }
  }

  private send(webSocket: WebSocket, msg: ServerMessage): void {
    if (webSocket.readyState === 1 /* OPEN */) {
      webSocket.send(JSON.stringify(msg));
    }
  }

  private async performSync(
    client: ActiveClient,
    lastSyncSeq?: number,
  ): Promise<void> {
    const app = await this.storage.getApp(client.appId);
    if (!app) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'Application not found',
      );
    }

    const seq = lastSyncSeq ?? 0;
    if (seq === 0) {
      // Client has no sync point: deliver full snapshot for this app
      const snapshot = await this.getAppSnapshot(app, client.user);
      const currentSeq = await app.getCurrentSeq(client.user);
      this.send(client.webSocket, {
        type: ServerMessageType.SyncSnapshot,
        seq: currentSeq,
        snapshot,
      });
    } else {
      // Client has lastSyncSeq: deliver diff or snapshot if compacted
      const { changes, currentSeq, requiresSnapshot } =
        await app.getChangesSince(client.user, seq);

      // If changelog was pruned or compacted, deliver full snapshot
      if (requiresSnapshot) {
        const snapshot = await this.getAppSnapshot(app, client.user);
        this.send(client.webSocket, {
          type: ServerMessageType.SyncSnapshot,
          seq: currentSeq,
          snapshot,
        });
      } else {
        this.send(client.webSocket, {
          type: ServerMessageType.SyncDiff,
          fromSeq: seq,
          toSeq: currentSeq,
          changes,
        });
      }
    }
  }

  private async getAppSnapshot(
    app: AppStorage,
    user: UserStorage,
  ): Promise<SnapshotRecord[]> {
    const tables = await app.getTables();
    const snapshot: SnapshotRecord[] = [];
    for (const table of tables) {
      const records = await table.getAllRecords(user);
      snapshot.push(...records);
    }
    return snapshot;
  }

  private broadcastToAppUser(
    appId: string,
    userId: string,
    excludeClientId: string,
    msg: ServerMessage,
  ): void {
    const channelKey = `${appId}:${userId}`;
    const clients = this.userClients.get(channelKey);
    if (!clients) return;

    for (const client of clients) {
      if (client.clientId !== excludeClientId) {
        this.send(client.webSocket, msg);
      }
    }
  }
}

// -- Private Helpers --------------------------------------------------------

interface ActiveClient {
  webSocket: WebSocket;
  clientId: string;
  user: UserStorage;
  appId: string;
}
