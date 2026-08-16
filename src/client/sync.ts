import { EventRegistry } from '../shared/event.js';
import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type ServerMessage,
  ServerMessageType,
  type SnapshotRecord,
} from '../shared/types.js';
import { TetherClientError, TetherClientErrorCode } from './errors.js';
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
  url: string,
  protocols?: string | string[],
) => WebSocket;

/**
 * Configuration options for Sync.
 */
export interface SyncOptions {
  /** WebSocket URL of the sync endpoint (e.g. 'ws://localhost:8080/sync'). */
  url?: string;
  /** Signed authentication session token. */
  token?: string;
  /** Application namespace identifier. */
  appId: string;
  /** Unique client instance identifier. */
  clientId: string;
  /** Initial reconnection backoff delay in milliseconds (defaults to 1000). */
  reconnectIntervalMs?: number;
  /** Maximum reconnection backoff delay in milliseconds (defaults to 30000). */
  maxReconnectIntervalMs?: number;
  /** Periodic keepalive ping interval in milliseconds (defaults to 30000). Set to 0 to disable. */
  pingIntervalMs?: number;
  /** Custom WebSocket constructor for Node.js environments. */
  webSocketClass?: WebSocketConstructor;
  /** Callback invoked when the server provides a refreshed session token. */
  onTokenRefresh?: (token: string) => void;
  /** Callback invoked when the server rejects authentication. */
  onAuthError?: (message: string) => void;
}

/**
 * Two-way WebSocket sync coordinator managing initial snapshot / diff downloads,
 * batched outbox queue flushing, acknowledgments, and auto-reconnect backoff.
 */
export class Sync {
  /** Remote WebSocket endpoint URL. */
  url?: string;
  /** Application namespace identifier for partitioning synchronization channels. */
  readonly appId: string;
  /** Client identifier used for conflict resolution tie-breaking. */
  readonly clientId: string;
  /** Reactive event registry triggered whenever synchronization status transitions. */
  readonly onStatusChange = new EventRegistry<SyncStatus>();

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

  /**
   * Creates a new Sync instance.
   *
   * @param storage - Local storage coordinator.
   * @param options - Configuration options for sync and connection.
   */
  constructor(storage: Storage, options: SyncOptions) {
    if (!options.appId) {
      throw new TetherClientError(
        TetherClientErrorCode.MissingConfiguration,
        'Missing required appId in SyncOptions.',
      );
    }
    if (!options.clientId) {
      throw new TetherClientError(
        TetherClientErrorCode.MissingConfiguration,
        'Missing required clientId in SyncOptions.',
      );
    }
    this.url = options.url;
    this.token = options.token;
    this.storage = storage;
    this.appId = options.appId;
    this.clientId = options.clientId;
    this.options = {
      reconnectIntervalMs: 1000,
      maxReconnectIntervalMs: 30000,
      pingIntervalMs: 30000,
      ...options,
    };

    if (this.token && this.url) {
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
   * Retrieves the current operational status of the sync coordinator.
   *
   * @returns Current `SyncStatus` value.
   */
  getStatus(): SyncStatus {
    return this.currentStatus;
  }

  /**
   * Initiates a WebSocket connection to the sync endpoint and sends authentication.
   *
   * @param token - Optional session token to connect with.
   * @param url - Optional WebSocket URL override.
   */
  connect(token?: string, url?: string): void {
    if (token) this.token = token;
    if (url) this.url = url;

    if (!this.url) {
      return;
    }

    if (this.webSocket) {
      this.disconnect();
    }

    this.setStatus(SyncStatus.Connecting);

    const wsUrl = this.url;
    const WebSocketImpl =
      this.options.webSocketClass ??
      (typeof WebSocket !== 'undefined' ? WebSocket : null);

    if (!WebSocketImpl) {
      this.setStatus(SyncStatus.Error);
      console.error(
        '[Sync] No WebSocket implementation available in this environment.',
      );
      return;
    }

    try {
      this.webSocket = new WebSocketImpl(wsUrl);
    } catch (err) {
      this.setStatus(SyncStatus.Error);
      console.error('[Sync] Failed to construct WebSocket:', err);
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
        this.handleServerMessage(msg);
      } catch (err) {
        console.error(
          '[Sync] Failed to parse incoming WebSocket message:',
          err,
        );
      }
    };

    this.webSocket.onerror = (err) => {
      console.error('[Sync] WebSocket error:', err);
    };

    this.webSocket.onclose = (event) => {
      this.stopPing();
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
        ws.close();
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
    this.disconnect();
  }

  /**
   * Schedules a debounced push of pending outbox mutations.
   *
   * @param delayMs - Debounce delay in milliseconds (defaults to 10).
   */
  schedulePush(delayMs = 10): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushOutbox();
    }, delayMs);
  }

  /**
   * Immediately extracts queued outbox changes and transmits them to the server.
   */
  async pushOutbox(): Promise<void> {
    if (
      this.isPushing ||
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
      console.error('[Sync] Failed to push outbox batch:', err);
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

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isDestroyed) return;
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
    const lastSyncSeq =
      (await this.storage.getMeta<number>('lastSyncSeq')) ?? 0;
    this.send({
      type: ClientMessageType.Auth,
      token: this.token ?? '',
      appId: this.options.appId,
      clientId: this.clientId,
      lastSyncSeq,
    });
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
        console.error('[Sync] Authentication failed:', msg.message);
        this.setStatus(SyncStatus.Error);
        this.disconnect();
        this.options.onAuthError?.(msg.message);
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
        console.error('[Sync] Server error:', msg.message);
        break;
    }
  }

  private async handleSnapshot(
    records: SnapshotRecord[],
    seq: number,
  ): Promise<void> {
    const tableEvents = new Map<
      string,
      Array<{ op: OperationType; id: string; data?: unknown; isRemote: true }>
    >();

    for (const item of records) {
      if (!tableEvents.has(item.table)) {
        tableEvents.set(item.table, []);
      }
      tableEvents.get(item.table)?.push({
        op: item.deleted ? OperationType.Delete : OperationType.Put,
        id: item.id,
        data: item.deleted ? undefined : item.data,
        isRemote: true,
      });
    }

    await this.storage.applySnapshotBatch(records, seq);

    for (const [tableName, events] of tableEvents.entries()) {
      const table = this.storage.table(tableName);
      table.notifyRemoteChanges(events);
    }
  }

  private async handleDiff(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    const tableEvents = new Map<
      string,
      Array<{ op: OperationType; id: string; data?: unknown; isRemote: true }>
    >();

    for (const change of changes) {
      if (!tableEvents.has(change.table)) {
        tableEvents.set(change.table, []);
      }
      const isDelete =
        change.op === OperationType.Delete || Boolean(change.deleted);
      tableEvents.get(change.table)?.push({
        op: isDelete ? OperationType.Delete : OperationType.Put,
        id: change.id,
        data: isDelete ? undefined : change.data,
        isRemote: true,
      });
    }

    await this.storage.applyRemoteChangesBatch(changes, seq);

    for (const [tableName, events] of tableEvents.entries()) {
      const table = this.storage.table(tableName);
      table.notifyRemoteChanges(events);
    }
  }
}
