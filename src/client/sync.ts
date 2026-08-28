import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageType,
  type SnapshotRecord,
} from '../shared/types.js';
import { TetherClientError, TetherClientErrorCode } from './errors.js';
import { EventRegistry } from './shared/event.js';
import type { Storage } from './storage.js';

/**
 * Operational state of the synchronization coordinator.
 */
export enum SyncStatus {
  /** Disconnected from the remote synchronization server. */
  Disconnected,
  /** Currently establishing a WebSocket connection. */
  Connecting,
  /** Authenticated and actively synchronizing in real time. */
  Connected,
  /** Synchronization halted due to an unrecoverable error (e.g. invalid auth token). */
  Error,
}

/**
 * Constructor signature for WebSocket implementations (native browser WebSocket or 'ws' package).
 */
export type WebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[] | WebSocketInit,
) => WebSocket;

/**
 * Configuration options for Sync.
 */
export interface SyncOptions {
  /** WebSocket URL of the sync endpoint (e.g. 'ws://localhost:8080/sync'). */
  url?: string;
  /** Signed authentication session token. */
  token?: string;
  /** Unique client instance identifier. */
  clientId: string;
  /** Optional table filter array. */
  tables?: string[];
  /** Initial reconnection backoff delay in milliseconds (defaults to 1000). */
  reconnectIntervalMs?: number;
  /** Maximum reconnection backoff delay in milliseconds (defaults to 30000). */
  maxReconnectIntervalMs?: number;
  /** Periodic keepalive ping interval in milliseconds (defaults to 30000). Set to 0 to disable. */
  pingIntervalMs?: number;
  /** Debounce delay in milliseconds before pushing queued local outbox changes (defaults to 10). */
  pushDebounceMs?: number;
  /** Custom WebSocket constructor for Node.js environments. */
  webSocketClass?: WebSocketConstructor;
  /** Callback invoked when the server provides a refreshed session token. */
  onTokenRefresh?: (token: string) => void;
  /** Callback invoked when the server rejects authentication. */
  onAuthError?: (message: string) => void;
}

/**
 * Metadata stored locally tracking synchronization progress.
 */
export interface SyncMetadata {
  /** Unique client instance identifier. */
  clientId: string;
  /** Latest sequence number synchronized with the server. */
  lastSyncSeq: number;
  /** Epoch timestamp of the last successful synchronization. */
  lastSyncTimestamp: number;
}

/**
 * Two-way WebSocket sync coordinator managing initial snapshot / diff downloads,
 * batched outbox queue flushing, acknowledgments, and auto-reconnect backoff.
 */
export class Sync {
  /** Remote WebSocket endpoint URL. */
  url?: string;
  /** Client identifier used for conflict resolution tie-breaking. */
  readonly clientId: string;
  /** Reactive event registry triggered whenever synchronization status transitions. */
  readonly onStatusChange = new EventRegistry<SyncStatus>();
  /** Reactive event registry triggered whenever background sync or network errors occur. */
  readonly onError = new EventRegistry<TetherClientError>();

  private token?: string;
  private storage: Storage;
  private options: SyncOptions;
  private webSocket: WebSocket | null = null;
  private currentStatus: SyncStatus = SyncStatus.Disconnected;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private isPushing = false;
  private isDestroyed = false;
  private pendingBatches: Map<string, number[]> = new Map(); // batchId -> localIds
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
    this.url = options.url;
    this.token = options.token;
    this.storage = storage;
    this.clientId = options.clientId;
    this.options = {
      reconnectIntervalMs: 1000,
      maxReconnectIntervalMs: 30000,
      pingIntervalMs: 30000,
      ...options,
    };

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }

    if (this.url) {
      this.connect();
    }
  }

  /**
   * Current operational status of the sync coordinator.
   */
  get status(): SyncStatus {
    return this.currentStatus;
  }

  /**
   * Initiates a WebSocket connection to the sync endpoint and sends authentication.
   *
   * @param token - Optional session token to connect with.
   * @param url - Optional WebSocket URL override.
   */
  connect(token?: string, url?: string): void {
    if (token !== undefined) {
      this.token = token;
    }
    if (url) {
      this.url = url;
    }

    if (this.isDestroyed || !this.url) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.webSocket) {
      if (this.webSocket.readyState === (this.webSocket.OPEN ?? 1)) {
        this.setStatus(SyncStatus.Connecting);
        this.sendAuth();
        return;
      }
      if (this.webSocket.readyState === (this.webSocket.CONNECTING ?? 0)) {
        this.setStatus(SyncStatus.Connecting);
        return;
      }
    }

    this.setStatus(SyncStatus.Connecting);

    try {
      const WebSocketClass =
        this.options.webSocketClass !== undefined
          ? this.options.webSocketClass
          : typeof WebSocket !== 'undefined'
            ? WebSocket
            : null;

      if (!WebSocketClass) {
        throw new TetherClientError(
          TetherClientErrorCode.MissingConfiguration,
          'No WebSocket implementation available',
        );
      }

      this.webSocket = new WebSocketClass(this.url);
    } catch (err) {
      this.setStatus(SyncStatus.Error);
      this.onError.publish(
        new TetherClientError(
          TetherClientErrorCode.NetworkError,
          err instanceof Error
            ? err.message
            : 'Failed to construct WebSocket connection',
        ),
      );
      this.scheduleReconnect();
      return;
    }

    this.webSocket.onopen = () => {
      this.reconnectAttempts = 0;
      this.startPing();
      this.sendAuth();
    };

    this.webSocket.onmessage = (event) => {
      try {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : event.data.toString('utf8');
        const msg: ServerMessage = JSON.parse(raw);
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
    };

    this.webSocket.onerror = () => {
      this.onError.publish(
        new TetherClientError(
          TetherClientErrorCode.NetworkError,
          'WebSocket connection encountered an error',
        ),
      );
    };

    this.webSocket.onclose = (event) => {
      this.stopPing();
      this.pendingBatches.clear();
      this.messageQueue = Promise.resolve();
      this.webSocket = null;
      if (!this.isDestroyed) {
        this.setStatus(SyncStatus.Disconnected);
        if (event.code !== 1000 && event.code !== 1005) {
          this.scheduleReconnect();
        }
      }
    };
  }

  /**
   * Disconnects the active WebSocket connection.
   */
  disconnect(): void {
    this.stopPing();
    this.pendingBatches.clear();
    this.messageQueue = Promise.resolve();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.webSocket) {
      const ws = this.webSocket;
      this.webSocket = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = () => {};
      ws.onclose = null;
      try {
        const wsWithTerminate = ws as unknown as { terminate?: () => void };
        if (typeof wsWithTerminate.terminate === 'function') {
          wsWithTerminate.terminate();
        } else {
          ws.close();
        }
      } catch {
        // Ignored during intentional disconnect
      }
    }
    this.setStatus(SyncStatus.Disconnected);
  }

  /**
   * Permanently tears down the sync coordinator and cancels reconnection timers.
   */
  destroy(): void {
    this.isDestroyed = true;
    if (
      typeof window !== 'undefined' &&
      typeof window.removeEventListener === 'function'
    ) {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('offline', this.handleOffline);
    }
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
      this.currentStatus !== SyncStatus.Connected ||
      !this.webSocket ||
      this.webSocket.readyState !== (this.webSocket.OPEN ?? 1)
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
        if (entry.localId !== undefined) {
          localIds.push(entry.localId);
        }
        changes.push(entry.change);
      }

      this.pendingBatches.set(batchId, localIds);

      this.send({
        type: ClientMessageType.ChangeBatch,
        clientId: this.clientId,
        batchId,
        changes,
      });
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

  private setStatus(newStatus: SyncStatus) {
    if (this.currentStatus === newStatus) return;
    this.currentStatus = newStatus;
    this.onStatusChange.publish(newStatus);
  }

  private startPing() {
    this.stopPing();
    const interval = this.options.pingIntervalMs ?? 30000;
    if (interval <= 0) return;

    this.pingTimer = setInterval(() => {
      this.send({ type: ClientMessageType.Ping });
    }, interval);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private isOnline(): boolean {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.onLine === 'boolean'
    ) {
      return navigator.onLine;
    }
    return true;
  }

  private handleOnline = () => {
    if (this.isDestroyed || !this.url) return;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  };

  private handleOffline = () => {
    if (this.isDestroyed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.webSocket) {
      this.disconnect();
    }
  };

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isDestroyed || !this.isOnline()) return;
    const base = this.options.reconnectIntervalMs ?? 1000;
    const max = this.options.maxReconnectIntervalMs ?? 30000;
    const delay = Math.min(base * 2 ** this.reconnectAttempts, max);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(msg: ClientMessage) {
    if (
      this.webSocket &&
      this.webSocket.readyState === (this.webSocket.OPEN ?? 1)
    ) {
      this.webSocket.send(JSON.stringify(msg));
    }
  }

  private async sendAuth() {
    this.pendingBatches.clear();
    try {
      const lastSyncSeq =
        (await this.storage.getMeta<number>('lastSyncSeq')) ?? 0;
      this.send({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        token: this.token,
        clientId: this.clientId,
        tables: this.options.tables,
        lastSyncSeq,
      });
    } catch {
      // Ignored if storage closed during reconnect
    }
  }

  private async handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case ServerMessageType.AuthSuccess: {
        this.reconnectAttempts = 0;
        this.setStatus(SyncStatus.Connected);
        if (msg.token) {
          this.token = msg.token;
          this.options.onTokenRefresh?.(msg.token);
        }
        this.startPing();
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.AuthError: {
        this.setStatus(SyncStatus.Error);
        this.disconnect();
        this.options.onAuthError?.(msg.message);
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
        this.pendingBatches.clear();
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
    }
  }
}
