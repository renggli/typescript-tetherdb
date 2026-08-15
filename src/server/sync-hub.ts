import type { WebSocket } from 'ws';
import { calculateByteSize, validateIdentifier } from '../shared/sanitize.js';
import {
  type ClientMessage,
  ClientMessageType,
  type ServerLimits,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import type { AuthManager } from './auth.js';
import type { StorageAdapter } from './storage/adapter.js';

interface ActiveClient {
  ws: WebSocket;
  clientId: string;
  userId: string;
}

/**
 * Real-time WebSocket connection hub managing authentication handshakes,
 * snapshot/diff delivery, change ingestion, acknowledgments, and peer broadcasts per user.
 */
export class SyncHub {
  private storage: StorageAdapter;
  private authManager: AuthManager;
  private limits: ServerLimits;
  private userClients: Map<string, Set<ActiveClient>> = new Map();
  private wsToClient: Map<WebSocket, ActiveClient> = new Map();

  /**
   * Initializes a new SyncHub instance.
   *
   * @param storage - Pluggable backend storage adapter.
   * @param authManager - User authentication and token verification manager.
   * @param limits - Optional server quota and payload limits.
   */
  constructor(
    storage: StorageAdapter,
    authManager: AuthManager,
    limits: ServerLimits = {},
  ) {
    this.storage = storage;
    this.authManager = authManager;
    this.limits = limits;
  }

  /**
   * Handles an incoming WebSocket connection, binding message, error, and disconnection events.
   *
   * @param ws - Active WebSocket connection.
   */
  /**
   * Handles an incoming WebSocket connection, binding message, error, and disconnection events.
   *
   * @param ws - Active WebSocket connection.
   */
  handleConnection(ws: WebSocket): void {
    ws.on('message', async (data) => {
      const client = this.wsToClient.get(ws);
      const userContext = client
        ? ` (user: "${client.userId}", client: "${client.clientId}")`
        : '';

      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const msg: ClientMessage = JSON.parse(raw);
        await this.handleMessage(ws, msg);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Invalid message format';
        console.error(
          `[BeamedServer] WebSocket message error${userContext}:`,
          errorMsg,
        );
        this.send(ws, {
          type: ServerMessageType.Error,
          message: `${errorMsg}${userContext}`,
        });
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      const client = this.wsToClient.get(ws);
      const userContext = client
        ? ` (user: "${client.userId}", client: "${client.clientId}")`
        : '';
      console.error(
        `[BeamedServer] WebSocket client error${userContext}:`,
        err,
      );
      this.handleDisconnect(ws);
    });
  }

  private handleDisconnect(ws: WebSocket): void {
    const client = this.wsToClient.get(ws);
    if (!client) return;

    this.wsToClient.delete(ws);
    const set = this.userClients.get(client.userId);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.userClients.delete(client.userId);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(
    ws: WebSocket,
    msg: ClientMessage,
  ): Promise<void> {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      throw new Error(
        'Invalid message format: Message must be an object with a type string.',
      );
    }

    switch (msg.type) {
      case ClientMessageType.Auth: {
        if (typeof msg.token !== 'string' || !msg.token) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: 'Missing or invalid authentication token',
          });
          ws.close();
          return;
        }

        const session = this.authManager.verifyToken(msg.token);
        if (!session) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: 'Invalid or expired authentication token',
          });
          ws.close();
          return;
        }

        const clientId = validateIdentifier(
          msg.clientId ?? 'client_anon',
          'clientId',
          session.userId,
        );
        const client: ActiveClient = {
          ws,
          clientId,
          userId: session.userId,
        };

        this.wsToClient.set(ws, client);
        let set = this.userClients.get(session.userId);
        if (!set) {
          set = new Set();
          this.userClients.set(session.userId, set);
        }
        set.add(client);

        const currentSeq = await this.storage.getCurrentSeq(session.userId);
        this.send(ws, {
          type: ServerMessageType.AuthSuccess,
          userId: session.userId,
          currentSeq,
        });

        // Initial sync: snapshot or diff
        await this.performSync(client, msg.lastSyncSeq);
        break;
      }

      case ClientMessageType.InitSync: {
        const client = this.wsToClient.get(ws);
        if (!client) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: 'Not authenticated',
          });
          return;
        }
        await this.performSync(client, msg.lastSyncSeq);
        break;
      }

      case ClientMessageType.ChangeBatch: {
        const client = this.wsToClient.get(ws);
        if (!client) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: 'Not authenticated',
          });
          return;
        }

        if (!Array.isArray(msg.changes)) {
          throw new Error(
            `Invalid change batch: changes must be an array for user "${client.userId}".`,
          );
        }

        const maxBatchSize = this.limits.maxBatchSizeBytes ?? 5 * 1024 * 1024;
        const batchBytes = calculateByteSize(msg.changes);
        if (batchBytes > maxBatchSize) {
          throw new Error(
            `Change batch size (${batchBytes} bytes) exceeds maximum allowed size of ${maxBatchSize} bytes for user "${client.userId}".`,
          );
        }

        const batchId = validateIdentifier(
          msg.batchId,
          'batchId',
          client.userId,
        );

        const { applied, newSeq } = await this.storage.applyChanges(
          client.userId,
          msg.changes,
        );

        // Acknowledge to sender
        this.send(ws, {
          type: ServerMessageType.ChangeAck,
          batchId,
          appliedSeq: newSeq,
        });

        // Broadcast applied changes to other active clients of the same user
        if (applied.length > 0) {
          this.broadcastToUser(client.userId, client.clientId, {
            type: ServerMessageType.BroadcastChanges,
            fromClientId: client.clientId,
            seq: newSeq,
            changes: applied,
          });
        }
        break;
      }

      case ClientMessageType.Ping: {
        this.send(ws, { type: ServerMessageType.Pong });
        break;
      }

      default: {
        throw new Error(
          `Unsupported message type: "${(msg as { type: string }).type}"`,
        );
      }
    }
  }

  private async performSync(
    client: ActiveClient,
    lastSyncSeq?: number,
  ): Promise<void> {
    const seq = lastSyncSeq ?? 0;
    if (seq === 0) {
      // Client has no sync point: deliver full snapshot
      const snapshot = await this.storage.getAllRecords(client.userId);
      const currentSeq = await this.storage.getCurrentSeq(client.userId);
      this.send(client.ws, {
        type: ServerMessageType.SyncSnapshot,
        seq: currentSeq,
        snapshot,
      });
    } else {
      // Client has lastSyncSeq: deliver diff or snapshot if compacted
      const { changes, currentSeq, requiresSnapshot } =
        await this.storage.getChangesSince(client.userId, seq);

      // If changelog was pruned OR diff is large (> 50 changes), deliver full snapshot for maximum efficiency
      if (requiresSnapshot || changes.length > 50) {
        const snapshot = await this.storage.getAllRecords(client.userId);
        this.send(client.ws, {
          type: ServerMessageType.SyncSnapshot,
          seq: currentSeq,
          snapshot,
        });
      } else {
        this.send(client.ws, {
          type: ServerMessageType.SyncDiff,
          fromSeq: seq,
          toSeq: currentSeq,
          changes,
        });
      }
    }
  }

  private broadcastToUser(
    userId: string,
    excludeClientId: string,
    msg: ServerMessage,
  ): void {
    const clients = this.userClients.get(userId);
    if (!clients) return;

    for (const client of clients) {
      if (client.clientId !== excludeClientId) {
        this.send(client.ws, msg);
      }
    }
  }
}
