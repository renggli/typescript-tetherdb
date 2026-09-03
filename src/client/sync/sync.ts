import { EventRegistry } from '../../shared/event.js';
import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageType,
  type SnapshotRecord,
} from '../../shared/types.js';
import { TetherClientError, TetherClientErrorCode } from '../errors.js';
import type { Storage } from '../storage/storage.js';
import type { TableChangeEvent } from '../table.js';
import { ConnectionManager } from './connection.js';
import { type SyncOptions, SyncStatus } from './types.js';

/**
 * Two-way sync coordinator managing initial snapshot / diff downloads,
 * batched outbox queue flushing, acknowledgments, and auto-reconnect backoff.
 */
export class Sync {
  /** Client identifier used for conflict resolution tie-breaking. */
  readonly clientId: string;
  /** Reactive event registry triggered whenever synchronization status transitions. */
  readonly onStatusChange = new EventRegistry<SyncStatus>();
  /** Reactive event registry triggered whenever background sync or network errors occur. */
  readonly onError = new EventRegistry<TetherClientError>();
  /** Reactive event registry triggered whenever the server provides a refreshed session token. */
  readonly onTokenRefresh = new EventRegistry<string>();
  /** Reactive event registry triggered whenever remote changes from the server are applied to local tables. */
  readonly onRemoteChangeBatch = new EventRegistry<{
    tableName: string;
    events: TableChangeEvent[];
  }>();

  private token?: string;
  private storage: Storage;
  private options: SyncOptions;
  private connection: ConnectionManager;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private isPushing = false;
  private accessibleTables?: Set<string>;
  private pendingBatches: Map<string, number[]> = new Map();
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: { userName?: string; token?: string }) => void;
      reject: (err: TetherClientError) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private messageQueue: Promise<void> = Promise.resolve();

  /**
   * Creates a new Sync instance.
   *
   * @param storage - Local storage coordinator.
   * @param options - Configuration options for sync and connection.
   */
  constructor(storage: Storage, options: SyncOptions) {
    if (!options.clientId) {
      throw new TetherClientError(
        TetherClientErrorCode.MissingConfiguration,
        'Missing required clientId in SyncOptions',
      );
    }
    this.token = options.token;
    this.storage = storage;
    this.clientId = options.clientId;
    this.options = {
      reconnectIntervalMs: 1000,
      maxReconnectIntervalMs: 30000,
      pingIntervalMs: 30000,
      ...options,
    };

    this.connection = new ConnectionManager(this.options, {
      onOpen: () => this.sendAuth(),
      onMessage: (raw) => this.enqueueIncomingMessage(raw),
      onError: (err) => this.handleConnectionError(err),
      onClose: () => this.handleConnectionClose(),
    });

    this.connection.onStatusChange.register((status) => {
      this.onStatusChange.publish(status);
    });

    if (this.url) {
      this.connect();
    }
  }

  /** Remote endpoint URL. */
  get url(): string | undefined {
    return this.connection.url;
  }

  set url(value: string | undefined) {
    this.connection.url = value;
  }

  /**
   * Current operational status of the sync coordinator.
   */
  get status(): SyncStatus {
    return this.connection.status;
  }

  /**
   * Initiates a connection to the sync endpoint and sends authentication.
   *
   * @param token - Optional session token to connect with. Pass `undefined` to connect unauthenticated.
   * @param url - Optional URL override.
   */
  connect(token?: string, url?: string): void {
    this.token = token;
    this.connection.connect(url);
  }

  /**
   * Registers a new user account.
   *
   * @param userName - Desired username.
   * @param password - Account password.
   */
  async register(
    userName: string,
    password: string,
  ): Promise<{ userName: string; token: string }> {
    return this.sendRequest<{ userName: string; token: string }>(
      (requestId) => ({
        type: ClientMessageType.Register,
        requestId,
        userName,
        password,
      }),
    );
  }

  /**
   * Logs into an account using credentials or token.
   *
   * @param options - Login options (username/password or token).
   */
  async login(
    options: { userName?: string; password?: string; token?: string } = {},
  ): Promise<{ userName?: string; token?: string }> {
    return this.sendRequest<{ userName?: string; token?: string }>(
      (requestId) => ({
        type: ClientMessageType.Login,
        requestId,
        userName: options.userName,
        password: options.password,
        token: options.token,
      }),
    );
  }

  /**
   * Logs out of the current session.
   */
  async logout(): Promise<void> {
    this.token = undefined;
    await this.sendRequest<Record<string, never>>((requestId) => ({
      type: ClientMessageType.Logout,
      requestId,
    }));
  }

  /**
   * Ensures that the connection is open, establishing it if necessary.
   */
  async ensureConnected(): Promise<void> {
    if (!this.url) {
      throw new TetherClientError(
        TetherClientErrorCode.MissingConfiguration,
        'No remote sync URL configured',
      );
    }

    if (this.connection.isOpen) {
      return;
    }

    if (this.status === SyncStatus.Disconnected) {
      this.connect();
    }

    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.connection.isOpen) {
          resolve();
        } else if (
          this.status === SyncStatus.Error ||
          this.status === SyncStatus.Disconnected
        ) {
          reject(
            new TetherClientError(
              TetherClientErrorCode.NetworkError,
              'Failed to establish WebSocket connection',
            ),
          );
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  /**
   * Disconnects the active connection.
   */
  disconnect(): void {
    this.accessibleTables = undefined;
    this.pendingBatches.clear();
    this.rejectPendingRequests(
      new TetherClientError(
        TetherClientErrorCode.NetworkError,
        'WebSocket disconnected',
      ),
    );
    this.messageQueue = Promise.resolve();
    this.connection.disconnect();
  }

  /**
   * Permanently tears down the sync coordinator and cancels reconnection timers.
   */
  destroy(): void {
    this.connection.destroy();
    this.disconnect();
  }

  /**
   * Schedules a debounced push of pending outbox mutations.
   *
   * @param delayMs - Optional override for debounce delay in milliseconds.
   */
  schedulePush(delayMs?: number): void {
    const delay = delayMs ?? this.options.pushDebounceMs ?? 10;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushOutbox();
    }, delay);
  }

  /**
   * Immediately extracts queued outbox changes and transmits them to the server.
   */
  async pushOutbox(): Promise<void> {
    if (
      this.isPushing ||
      this.pendingBatches.size > 0 ||
      this.status !== SyncStatus.Connected ||
      !this.connection.isOpen
    ) {
      return;
    }

    this.isPushing = true;
    try {
      const pending = await this.storage.getPendingOutbox(500);
      if (pending.length === 0) return;

      const batchId = `batch_${Math.random().toString(36).substring(2, 10)}`;
      const localIds: number[] = [];
      const changes: ChangeRecord[] = [];

      for (const entry of pending) {
        if (
          !this.token &&
          this.accessibleTables !== undefined &&
          !this.accessibleTables.has(entry.change.table)
        ) {
          continue;
        }
        if (
          this.options.tables !== undefined &&
          !this.options.tables.includes(entry.change.table)
        ) {
          continue;
        }
        if (entry.localId !== undefined) {
          localIds.push(entry.localId);
        }
        changes.push(entry.change);
      }

      if (changes.length === 0) return;

      this.pendingBatches.set(batchId, localIds);

      const sent = this.connection.send(
        JSON.stringify({
          type: ClientMessageType.ChangeBatch,
          clientId: this.clientId,
          batchId,
          changes,
        }),
      );
      if (!sent) {
        this.pendingBatches.delete(batchId);
        this.schedulePush(200);
      }
    } catch (err) {
      this.onError.publish(
        new TetherClientError(
          TetherClientErrorCode.SyncError,
          err instanceof Error
            ? err.message
            : 'Failed to push outbox batch to server',
        ),
      );
    } finally {
      this.isPushing = false;
    }
  }

  // -- Private Helpers ------------------------------------------------------

  private async sendRequest<T extends { userName?: string; token?: string }>(
    createMessage: (requestId: string) => ClientMessage,
  ): Promise<T> {
    await this.ensureConnected();
    const requestId = `req_${Math.random().toString(36).substring(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new TetherClientError(
            TetherClientErrorCode.NetworkError,
            'Authentication request timed out waiting for server response',
          ),
        );
      }, 15000);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: {
          userName?: string;
          token?: string;
        }) => void,
        reject,
        timeout,
      });

      this.send(createMessage(requestId));
    });
  }

  private rejectPendingRequests(err: TetherClientError): void {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private handleConnectionError(err: TetherClientError): void {
    this.rejectPendingRequests(err);
    this.onError.publish(err);
  }

  private handleConnectionClose(): void {
    this.accessibleTables = undefined;
    this.pendingBatches.clear();
    this.rejectPendingRequests(
      new TetherClientError(
        TetherClientErrorCode.NetworkError,
        'WebSocket connection closed',
      ),
    );
    this.messageQueue = Promise.resolve();
  }

  private send(msg: ClientMessage): void {
    if (this.connection.isOpen) {
      this.connection.send(JSON.stringify(msg));
    }
  }

  private sendAuth(): void {
    this.storage
      .getMeta<number>('lastSyncSeq')
      .then((lastSyncSeq) => {
        this.send({
          type: ClientMessageType.Auth,
          protocolVersion: PROTOCOL_VERSION,
          clientId: this.clientId,
          token: this.token,
          lastSyncSeq,
          tables: this.options.tables,
        });
      })
      .catch((err) => {
        this.onError.publish(
          new TetherClientError(
            TetherClientErrorCode.SyncError,
            err instanceof Error
              ? err.message
              : 'Failed to read lastSyncSeq metadata for authentication',
          ),
        );
      });
  }

  private enqueueIncomingMessage(data: string | Buffer): void {
    try {
      const raw = typeof data === 'string' ? data : data.toString();
      const msg = JSON.parse(raw) as ServerMessage;
      this.messageQueue = this.messageQueue
        .then(() => this.handleServerMessage(msg))
        .catch((err) => {
          this.onError.publish(
            new TetherClientError(
              TetherClientErrorCode.SyncError,
              err instanceof Error
                ? err.message
                : 'Failed to process incoming WebSocket message',
            ),
          );
        });
    } catch (err) {
      this.onError.publish(
        new TetherClientError(
          TetherClientErrorCode.SyncError,
          err instanceof Error
            ? err.message
            : 'Failed to parse incoming WebSocket message',
        ),
      );
    }
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case ServerMessageType.AuthSuccess: {
        this.connection.setStatus(SyncStatus.Connected);
        if (msg.tables) {
          this.accessibleTables = new Set(msg.tables);
        } else {
          this.accessibleTables = undefined;
        }
        if (msg.token) {
          this.token = msg.token;
          this.onTokenRefresh.publish(msg.token);
        }
        if (msg.requestId) {
          const req = this.pendingRequests.get(msg.requestId);
          if (req) {
            clearTimeout(req.timeout);
            this.pendingRequests.delete(msg.requestId);
            req.resolve({ userName: msg.userName, token: msg.token });
          }
        }
        this.connection.startPing();
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.AuthError: {
        this.accessibleTables = undefined;
        this.connection.setStatus(SyncStatus.Error);
        if (msg.requestId) {
          const req = this.pendingRequests.get(msg.requestId);
          if (req) {
            clearTimeout(req.timeout);
            this.pendingRequests.delete(msg.requestId);
            req.reject(
              new TetherClientError(
                TetherClientErrorCode.AuthenticationFailed,
                msg.message,
              ),
            );
          }
        }
        this.disconnect();
        this.onError.publish(
          new TetherClientError(
            TetherClientErrorCode.AuthenticationFailed,
            msg.message,
          ),
        );
        break;
      }
      case ServerMessageType.SyncSnapshot: {
        await this.handleSnapshot(msg.snapshot, msg.seq);
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.SyncDiff: {
        await this.handleDiff(msg.changes, msg.toSeq);
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.BroadcastChanges: {
        await this.handleDiff(msg.changes, msg.seq);
        break;
      }
      case ServerMessageType.ChangeAck: {
        const localIds = this.pendingBatches.get(msg.batchId);
        if (localIds) {
          this.pendingBatches.delete(msg.batchId);
          await this.storage.removeOutboxEntries(localIds);
        }
        if (msg.appliedSeq !== undefined) {
          await this.storage.setMeta('lastSyncSeq', msg.appliedSeq);
        }
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.Pong:
        break;
      case ServerMessageType.Error:
        if (msg.batchId) {
          this.pendingBatches.delete(msg.batchId);
        } else {
          this.pendingBatches.clear();
        }
        this.onError.publish(
          new TetherClientError(TetherClientErrorCode.SyncError, msg.message),
        );
        break;
    }
  }

  private async handleSnapshot(
    records: SnapshotRecord[],
    seq: number,
  ): Promise<void> {
    await this.storage.applySnapshotBatch(records, seq);
    this.notifyTableRemoteEvents(
      records.map((item) => ({
        table: item.table,
        id: item.id,
        isDelete: item.deleted ?? false,
        data: item.data,
      })),
    );
  }

  private async handleDiff(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    await this.storage.applyRemoteChangesBatch(changes, seq);
    this.notifyTableRemoteEvents(
      changes.map((change) => ({
        table: change.table,
        id: change.id,
        isDelete: change.op === OperationType.Delete,
        data: change.data,
      })),
    );
  }

  private notifyTableRemoteEvents(
    items: Array<{
      table: string;
      id: string;
      isDelete: boolean;
      data?: unknown;
    }>,
  ): void {
    const tableEvents = new Map<
      string,
      Array<{ op: OperationType; id: string; data?: unknown; isRemote: true }>
    >();

    for (const item of items) {
      let events = tableEvents.get(item.table);
      if (!events) {
        events = [];
        tableEvents.set(item.table, events);
      }
      events.push({
        op: item.isDelete ? OperationType.Delete : OperationType.Put,
        id: item.id,
        data: item.isDelete ? undefined : item.data,
        isRemote: true,
      });
    }

    for (const [tableName, events] of tableEvents.entries()) {
      const table = this.storage.table(tableName);
      table.notifyRemoteChanges(events);
      this.onRemoteChangeBatch.publish({ tableName, events });
    }
  }
}
