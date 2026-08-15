import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type RecordSnapshotItem,
  type ServerMessage,
  ServerMessageType,
} from '../shared/types.js';
import type { IDBManager } from './idb.js';
import type { ITable } from './table.js';

/**
 * Operational state of the synchronization coordinator.
 */
export enum SyncStatus {
  /** Disconnected from the remote synchronization server. */
  Disconnected = 'disconnected',
  /** Currently establishing a WebSocket connection. */
  Connecting = 'connecting',
  /** Authenticated and actively synchronizing in real time. */
  Connected = 'connected',
  /** Synchronization halted due to an unrecoverable error (e.g. invalid auth token). */
  Error = 'error',
}

/**
 * Constructor signature for WebSocket implementations (native browser WebSocket or 'ws' package).
 */
export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocket;

/**
 * Configuration options for TetherSyncClient.
 */
export interface SyncOptions {
  /** WebSocket URL of the sync endpoint (e.g. 'ws://localhost:8080/sync'). */
  url: string;
  /** Signed authentication session token. */
  token: string;
  /** Optional application namespace identifier (defaults to 'default'). */
  appId?: string;
  /** Whether to automatically connect on creation (defaults to `true`). */
  autoConnect?: boolean;
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
export class TetherSyncClient {
  private idb: IDBManager;
  private getTable: (name: string) => ITable;
  private getClientId: () => string;
  private options: SyncOptions;
  private ws: WebSocket | null = null;
  private status: SyncStatus = SyncStatus.Disconnected;
  private statusListeners: Set<(status: SyncStatus) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private isPushing = false;
  private isDestroyed = false;
  private pendingBatches: Map<string, number[]> = new Map(); // batchId -> localIds

  /**
   * Creates a new TetherSyncClient instance.
   *
   * @param idb - IndexedDB transaction manager.
   * @param getTable - Function to resolve a table by name.
   * @param getClientId - Function providing the unique client identifier.
   * @param options - Configuration options for sync and connection.
   */
  constructor(
    idb: IDBManager,
    getTable: (name: string) => ITable,
    getClientId: () => string,
    options: SyncOptions,
  ) {
    this.idb = idb;
    this.getTable = getTable;
    this.getClientId = getClientId;
    this.options = {
      autoConnect: true,
      reconnectIntervalMs: 1000,
      maxReconnectIntervalMs: 30000,
      pingIntervalMs: 30000,
      ...options,
    };

    if (this.options.autoConnect) {
      this.connect();
    }
  }

  /**
   * Retrieves the current operational status of the sync coordinator.
   *
   * @returns Current `SyncStatus` value.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Registers a listener callback invoked whenever the synchronization status changes.
   *
   * @param listener - Callback receiving the new `SyncStatus`.
   * @returns Unsubscribe function to remove the listener.
   */
  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(newStatus: SyncStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus);
      } catch (err) {
        console.error('[TetherDB] Sync status listener error:', err);
      }
    }
  }

  /**
   * Initiates a WebSocket connection to the sync endpoint and sends authentication.
   */
  connect(): void {
    if (this.isDestroyed || this.ws) return;
    this.setStatus(SyncStatus.Connecting);

    const WS =
      this.options.WebSocketClass ??
      (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) {
      console.warn('[TetherDB] No WebSocket implementation found.');
      this.setStatus(SyncStatus.Error);
      return;
    }

    try {
      this.ws = new WS(this.options.url) as WebSocket;
    } catch (_err) {
      this.setStatus(SyncStatus.Error);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = async () => {
      if (this.isDestroyed) {
        this.disconnect();
        return;
      }
      await this.sendAuth();
    };

    this.ws.onmessage = async (event) => {
      try {
        const raw =
          typeof event.data === 'string' ? event.data : event.data.toString();
        const msg: ServerMessage = JSON.parse(raw);
        await this.handleServerMessage(msg);
      } catch (err) {
        console.error('[TetherDB] Failed to process message from server:', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (!this.isDestroyed) {
        this.setStatus(SyncStatus.Disconnected);
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('[TetherDB] WebSocket error:', err);
      this.ws?.close();
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const baseInterval = this.options.reconnectIntervalMs ?? 1000;
    const maxInterval = this.options.maxReconnectIntervalMs ?? 30000;
    const delay = Math.min(
      baseInterval * 1.5 ** Math.min(this.reconnectAttempts - 1, 8),
      maxInterval,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.options.pingIntervalMs ?? 30000;
    if (interval <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 /* OPEN */) {
        this.send({ type: ClientMessageType.Ping });
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async sendAuth(): Promise<void> {
    if (!this.options.appId) {
      throw new Error('Missing required appId for sync authentication.');
    }
    const lastSyncSeq = (await this.idb.getMeta<number>('lastSyncSeq')) ?? 0;
    const msg: ClientMessage = {
      type: ClientMessageType.Auth,
      token: this.options.token,
      clientId: this.getClientId(),
      lastSyncSeq,
      appId: this.options.appId,
    };
    this.send(msg);
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case ServerMessageType.AuthSuccess: {
        this.reconnectAttempts = 0;
        this.startPing();
        this.setStatus(SyncStatus.Connected);
        this.schedulePush(0);
        break;
      }

      case ServerMessageType.AuthError: {
        console.error('[TetherDB] Auth error from server:', msg.message);
        this.setStatus(SyncStatus.Error);
        this.disconnect();
        break;
      }

      case ServerMessageType.SyncSnapshot: {
        await this.applySnapshot(msg.snapshot, msg.seq);
        this.schedulePush(0);
        break;
      }

      case ServerMessageType.SyncDiff: {
        await this.applyChanges(msg.changes, msg.toSeq);
        this.schedulePush(0);
        break;
      }

      case ServerMessageType.BroadcastChanges: {
        await this.applyChanges(msg.changes, msg.seq);
        break;
      }

      case ServerMessageType.ChangeAck: {
        const localIds = this.pendingBatches.get(msg.batchId);
        if (localIds) {
          await this.idb.removeOutboxEntries(localIds);
          this.pendingBatches.delete(msg.batchId);
        }
        if (msg.appliedSeq) {
          await this.idb.setMeta('lastSyncSeq', msg.appliedSeq);
        }
        // Drain any pending entries that arrived while the previous batch was in-flight
        this.schedulePush(0);
        break;
      }

      case ServerMessageType.Pong:
        break;

      case ServerMessageType.Error: {
        console.error('[TetherDB] Server error:', msg.message);
        break;
      }
    }
  }

  private async applySnapshot(
    snapshot: RecordSnapshotItem[],
    seq: number,
  ): Promise<void> {
    await this.idb.applySnapshotBatch(snapshot, seq);

    const eventsByTable = new Map<
      string,
      Array<{
        op: OperationType;
        id: string;
        data?: unknown;
        isRemote?: boolean;
      }>
    >();

    for (const item of snapshot) {
      let list = eventsByTable.get(item.table);
      if (!list) {
        list = [];
        eventsByTable.set(item.table, list);
      }
      list.push({
        op: item.deleted ? OperationType.Delete : OperationType.Put,
        id: item.id,
        data: item.deleted ? undefined : item.data,
        isRemote: true,
      });
    }

    for (const [tableName, events] of eventsByTable.entries()) {
      const table = this.getTable(tableName);
      table.notifyRemoteChanges(events);
    }
  }

  private async applyChanges(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    await this.idb.applyRemoteChangesBatch(changes, seq);

    const eventsByTable = new Map<
      string,
      Array<{
        op: OperationType;
        id: string;
        data?: unknown;
        isRemote?: boolean;
      }>
    >();

    for (const change of changes) {
      let list = eventsByTable.get(change.table);
      if (!list) {
        list = [];
        eventsByTable.set(change.table, list);
      }
      const isDelete =
        change.op === OperationType.Delete || Boolean(change.deleted);
      list.push({
        op: isDelete ? OperationType.Delete : OperationType.Put,
        id: change.id,
        data: isDelete ? undefined : change.data,
        isRemote: true,
      });
    }

    for (const [tableName, events] of eventsByTable.entries()) {
      const table = this.getTable(tableName);
      table.notifyRemoteChanges(events);
    }
  }

  /**
   * Schedules an outbox push, debouncing rapid mutations into a single cohesive batch.
   *
   * @param delayMs - Debounce delay in milliseconds (defaults to 10ms).
   */
  schedulePush(delayMs = 10): void {
    if (this.isDestroyed || !this.ws || this.ws.readyState !== 1) return;
    if (this.pushTimer !== null) return;

    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushOutbox();
    }, delayMs);
  }

  /**
   * Pushes un-synced outbox changes to the server in a correlated batch.
   */
  async pushOutbox(): Promise<void> {
    if (this.pushTimer !== null) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.isPushing || !this.ws || this.ws.readyState !== 1) return;
    this.isPushing = true;

    try {
      const pending = await this.idb.getPendingOutbox(500);
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

      const msg: ClientMessage = {
        type: ClientMessageType.ChangeBatch,
        clientId: this.getClientId(),
        batchId,
        changes,
      };

      this.send(msg);
    } finally {
      this.isPushing = false;
    }
  }
}
