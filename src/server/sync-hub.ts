import type { WebSocket } from 'ws';
import {
  type ClientMessage,
  ClientMessageType,
  type RecordSnapshotItem,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import type { Storage } from './storage/storage.js';
import type { UserStorage } from './storage/user.js';
import {
  calculateByteSize,
  validateAppId,
  validateIdentifier,
} from './validate.js';

interface ActiveClient {
  webSocket: WebSocket;
  clientId: string;
  user: UserStorage;
  appId: string;
}

/**
 * Real-time WebSocket connection hub managing authentication handshakes,
 * snapshot/diff delivery, change ingestion, acknowledgments, and peer broadcasts per application and user.
 */
export class SyncHub {
  private storage: Storage;
  private userClients: Map<string, Set<ActiveClient>> = new Map(); // key = `${appId}:${userId}`
  private webSocketToClient: Map<WebSocket, ActiveClient> = new Map();

  /**
   * Initializes a new SyncHub instance.
   *
   * @param storage - Pluggable backend storage engine.
   */
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Handles an incoming WebSocket connection, binding message, error, and disconnection events.
   *
   * @param webSocket - Active WebSocket connection.
   */
  handleConnection(webSocket: WebSocket): void {
    let messageQueue: Promise<void> = Promise.resolve();

    webSocket.on('message', (data) => {
      messageQueue = messageQueue
        .then(async () => {
          const client = this.webSocketToClient.get(webSocket);
          const userContext = client
            ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
            : '';

          try {
            const raw = typeof data === 'string' ? data : data.toString();
            const msg: ClientMessage = JSON.parse(raw);
            await this.handleMessage(webSocket, msg);
          } catch (err) {
            const errorMsg =
              err instanceof Error ? err.message : 'Invalid message format';
            console.error(
              `[TetherServer] WebSocket message error${userContext}:`,
              errorMsg,
            );
            this.send(webSocket, {
              type: ServerMessageType.Error,
              message: `${errorMsg}${userContext}`,
            });
          }
        })
        .catch(() => {});
    });

    webSocket.on('close', () => {
      this.handleDisconnect(webSocket);
    });

    webSocket.on('error', (err) => {
      const client = this.webSocketToClient.get(webSocket);
      const userContext = client
        ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
        : '';
      console.error(
        `[TetherServer] WebSocket client error${userContext}:`,
        err,
      );
      this.handleDisconnect(webSocket);
    });
  }

  private handleDisconnect(webSocket: WebSocket): void {
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

  private async handleMessage(
    webSocket: WebSocket,
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
          this.send(webSocket, {
            type: ServerMessageType.AuthError,
            message: 'Missing or invalid authentication token',
          });
          webSocket.close();
          return;
        }

        const user = await this.storage.getUserByToken(msg.token);
        if (!user) {
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
            message: `Application "${appId}" does not exist.`,
          });
          webSocket.close();
          return;
        }

        const clientId = validateIdentifier(
          msg.clientId ?? 'client_anon',
          'clientId',
        );
        const client: ActiveClient = {
          webSocket,
          clientId,
          user,
          appId,
        };

        this.webSocketToClient.set(webSocket, client);
        const channelKey = `${appId}:${user.id}`;
        let set = this.userClients.get(channelKey);
        if (!set) {
          set = new Set();
          this.userClients.set(channelKey, set);
        }
        set.add(client);

        const currentSeq = await app.getCurrentSeq(user);
        this.send(webSocket, {
          type: ServerMessageType.AuthSuccess,
          userId: user.id,
          currentSeq,
        });

        // Initial sync: snapshot or diff
        await this.performSync(client, msg.lastSyncSeq);
        break;
      }

      case ClientMessageType.InitSync: {
        const client = this.webSocketToClient.get(webSocket);
        if (!client) {
          this.send(webSocket, {
            type: ServerMessageType.AuthError,
            message: 'Not authenticated',
          });
          return;
        }
        await this.performSync(client, msg.lastSyncSeq);
        break;
      }

      case ClientMessageType.ChangeBatch: {
        const client = this.webSocketToClient.get(webSocket);
        if (!client) {
          this.send(webSocket, {
            type: ServerMessageType.AuthError,
            message: 'Not authenticated',
          });
          return;
        }

        if (!Array.isArray(msg.changes)) {
          throw new Error(
            `Invalid change batch: changes must be an array for user "${client.user.id}" in app "${client.appId}".`,
          );
        }

        const maxBatchSize =
          this.storage.options?.maxBatchSizeBytes ?? 5 * 1024 * 1024;
        const batchBytes = calculateByteSize(msg.changes);
        if (batchBytes > maxBatchSize) {
          throw new Error(
            `Change batch size (${batchBytes} bytes) exceeds maximum allowed size of ${maxBatchSize} bytes for user "${client.user.id}".`,
          );
        }

        const batchId = validateIdentifier(msg.batchId, 'batchId');

        const app = await this.storage.getApp(client.appId);
        if (!app) {
          throw new Error(`Application "${client.appId}" does not exist.`);
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
          this.broadcastToAppUser(
            client.appId,
            client.user.id,
            client.clientId,
            {
              type: ServerMessageType.BroadcastChanges,
              fromClientId: client.clientId,
              changes: applied,
              seq: newSeq,
            },
          );
        }
        break;
      }

      case ClientMessageType.Ping: {
        this.send(webSocket, {
          type: ServerMessageType.Pong,
        });
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
    const app = await this.storage.getApp(client.appId);
    if (!app) {
      throw new Error(`Application "${client.appId}" not found.`);
    }

    const seq = lastSyncSeq ?? 0;
    if (seq === 0) {
      // Client has no sync point: deliver full snapshot for this app
      const tables = await app.getTables();
      const snapshot: RecordSnapshotItem[] = [];
      for (const table of tables) {
        const records = await table.getAllRecords(client.user);
        snapshot.push(...records);
      }
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

      // If changelog was pruned OR diff is large (> 50 changes), deliver full snapshot for maximum efficiency
      if (requiresSnapshot || changes.length > 50) {
        const tables = await app.getTables();
        const snapshot: RecordSnapshotItem[] = [];
        for (const table of tables) {
          const records = await table.getAllRecords(client.user);
          snapshot.push(...records);
        }
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
