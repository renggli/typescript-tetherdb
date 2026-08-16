import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type RecordSnapshotItem,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import type { Database } from './database.js';

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
  WebSocketClass?: WebSocketConstructor;
}

/**
 * Two-way WebSocket sync coordinator managing initial snapshot / diff downloads,
 * batched outbox queue flushing, acknowledgments, and auto-reconnect backoff.
 */
export class Sync {
  url?: string;
  readonly appId: string;
  readonly clientId: string;
  private token?: string;
  private database: Database;
  private options: SyncOptions;
  private webSocket: WebSocket | null = null;
  private currentStatus: SyncStatus = SyncStatus.Disconnected;
  private statusListeners: Set<(status: SyncStatus) => void> = new Set();
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
   * @param database - Database transaction coordinator.
   * @param options - Configuration options for sync and connection.
   */
  constructor(database: Database, options: SyncOptions) {
    if (!options.appId) {
      throw new Error('Missing required appId in SyncOptions.');
    }
    if (!options.clientId) {
      throw new Error('Missing required clientId in SyncOptions.');
    }
    this.url = options.url;
    this.token = options.token;
    this.database = database;
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
   * Registers a listener callback invoked whenever the synchronization status changes.
   *
   * @param listener - Callback receiving the new `SyncStatus`.
   * @returns Unsubscribe function to remove the listener.
   */
  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
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

    if (!this.token || !this.url) return;
    if (this.isDestroyed || this.webSocket) return;

    this.setStatus(SyncStatus.Connecting);

    const WS =
      this.options.WebSocketClass ??
      (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) {
      console.warn('[Sync] No WebSocket implementation found.');
      this.setStatus(SyncStatus.Error);
      return;
    }

    try {
      this.webSocket = new WS(this.url) as WebSocket;
    } catch (_err) {
      this.setStatus(SyncStatus.Error);
      this.scheduleReconnect();
      return;
    }

    this.webSocket.onopen = async () => {
      if (this.isDestroyed) {
        this.disconnect();
        return;
      }
      await this.sendAuth();
    };

    this.webSocket.onmessage = async (event) => {
      try {
        const raw =
          typeof event.data === 'string' ? event.data : event.data.toString();
        const msg: ServerMessage = JSON.parse(raw);
        await this.handleServerMessage(msg);
      } catch (err) {
        console.error('[Sync] Failed to process message from server:', err);
      }
    };

    this.webSocket.onclose = () => {
      this.webSocket = null;
      if (!this.isDestroyed) {
        this.setStatus(SyncStatus.Disconnected);
        this.scheduleReconnect();
      }
    };

    this.webSocket.onerror = (err) => {
      console.error('[Sync] WebSocket error:', err);
      this.webSocket?.close();
    };
  }

  /**
   * Disconnects the active WebSocket connection without marking the client as destroyed.
   */
  disconnect(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
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
    this.statusListeners.clear();
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
      const pending = await this.database.getPendingOutbox(500);
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
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus);
      } catch (err) {
        console.error('[Sync] Status listener error:', err);
      }
    }
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
      (await this.database.getMeta<number>('lastSyncSeq')) ?? 0;
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
        this.startPing();
        await this.pushOutbox();
        break;
      }
      case ServerMessageType.AuthError: {
        console.error('[Sync] Authentication failed:', msg.message);
        this.setStatus(SyncStatus.Error);
        this.disconnect();
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
          await this.database.removeOutboxEntries(localIds);
        }
        if (msg.appliedSeq !== undefined) {
          await this.database.setMeta('lastSyncSeq', msg.appliedSeq);
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
    records: RecordSnapshotItem[],
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

    await this.database.applySnapshotBatch(records, seq);

    for (const [tableName, events] of tableEvents.entries()) {
      const table = this.database.table(tableName);
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

    await this.database.applyRemoteChangesBatch(changes, seq);

    for (const [tableName, events] of tableEvents.entries()) {
      const table = this.database.table(tableName);
      table.notifyRemoteChanges(events);
    }
  }
}
