import type { WebSocket } from 'ws';
import {
  calculateByteSize,
  validateAppId,
  validateIdentifier,
} from '../shared/sanitize.js';
import {
  type ClientMessage,
  ClientMessageType,
  type RecordSnapshotItem,
  type ServerLimits,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import type { Storage } from './storage/storage.js';
import type { UserStorage } from './storage/user.js';

interface ActiveClient {
  ws: WebSocket;
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
  private limits: ServerLimits;
  private userClients: Map<string, Set<ActiveClient>> = new Map(); // key = `${appId}:${userId}`
  private wsToClient: Map<WebSocket, ActiveClient> = new Map();

  /**
   * Initializes a new SyncHub instance.
   *
   * @param storage - Pluggable backend storage engine.
   * @param limits - Optional server quota and payload limits.
   */
  constructor(storage: Storage, limits: ServerLimits = {}) {
    this.storage = storage;
    this.limits = limits;
  }

  /**
   * Handles an incoming WebSocket connection, binding message, error, and disconnection events.
   *
   * @param ws - Active WebSocket connection.
   */
  handleConnection(ws: WebSocket): void {
    ws.on('message', async (data) => {
      const client = this.wsToClient.get(ws);
      const userContext = client
        ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
        : '';

      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const msg: ClientMessage = JSON.parse(raw);
        await this.handleMessage(ws, msg);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Invalid message format';
        console.error(
          `[TetherServer] WebSocket message error${userContext}:`,
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
        ? ` (app: "${client.appId}", user: "${client.user.id}", client: "${client.clientId}")`
        : '';
      console.error(
        `[TetherServer] WebSocket client error${userContext}:`,
        err,
      );
      this.handleDisconnect(ws);
    });
  }

  private handleDisconnect(ws: WebSocket): void {
    const client = this.wsToClient.get(ws);
    if (!client) return;

    this.wsToClient.delete(ws);
    const channelKey = `${client.appId}:${client.user.id}`;
    const set = this.userClients.get(channelKey);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.userClients.delete(channelKey);
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

        const user = await this.storage.getUserByToken(msg.token);
        if (!user) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: 'Invalid or expired authentication token',
          });
          ws.close();
          return;
        }

        const appId = validateAppId(msg.appId);
        const app = await this.storage.getApp(appId);
        if (!app) {
          this.send(ws, {
            type: ServerMessageType.AuthError,
            message: `Application "${appId}" does not exist. Create it first using "tetherdb apps add ${appId}".`,
          });
          ws.close();
          return;
        }

        const clientId = validateIdentifier(
          msg.clientId ?? 'client_anon',
          'clientId',
          user.id,
        );
        const client: ActiveClient = {
          ws,
          clientId,
          user,
          appId,
        };

        this.wsToClient.set(ws, client);
        const channelKey = `${appId}:${user.id}`;
        let set = this.userClients.get(channelKey);
        if (!set) {
          set = new Set();
          this.userClients.set(channelKey, set);
        }
        set.add(client);

        const currentSeq = await app.getCurrentSeq(user);
        this.send(ws, {
          type: ServerMessageType.AuthSuccess,
          userId: user.id,
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
            `Invalid change batch: changes must be an array for user "${client.user.id}" in app "${client.appId}".`,
          );
        }

        const maxBatchSize = this.limits.maxBatchSizeBytes ?? 5 * 1024 * 1024;
        const batchBytes = calculateByteSize(msg.changes);
        if (batchBytes > maxBatchSize) {
          throw new Error(
            `Change batch size (${batchBytes} bytes) exceeds maximum allowed size of ${maxBatchSize} bytes for user "${client.user.id}".`,
          );
        }

        const batchId = validateIdentifier(
          msg.batchId,
          'batchId',
          client.user.id,
        );

        const app = await this.storage.getApp(client.appId);
        if (!app) {
          throw new Error(
            `Application "${client.appId}" does not exist. Create it first using "tetherdb apps add ${client.appId}".`,
          );
        }

        const { applied, newSeq } = await app.applyChanges(
          client.user,
          msg.changes,
        );

        // Acknowledge to sender
        this.send(ws, {
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
      this.send(client.ws, {
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
        this.send(client.ws, msg);
      }
    }
  }
}
