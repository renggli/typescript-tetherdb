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
 * Configuration options for BeamedSyncClient.
 */
export interface SyncOptions {
  /** WebSocket URL of the sync endpoint (e.g. 'ws://localhost:8080/sync'). */
  url: string;
  /** Signed authentication session token. */
  token: string;
  /** Whether to automatically connect on creation (defaults to `true`). */
  autoConnect?: boolean;
  /** Interval in milliseconds to wait before attempting auto-reconnect (defaults to 2000). */
  reconnectIntervalMs?: number;
  /** Custom WebSocket constructor for Node.js environments. */
  WebSocketClass?: WebSocketConstructor;
}

/**
 * Two-way WebSocket sync coordinator managing initial snapshot / diff downloads,
 * batched outbox queue flushing, acknowledgments, and auto-reconnect backoff.
 */
export class BeamedSyncClient {
  private idb: IDBManager;
  private getTable: (name: string) => ITable;
  private getClientId: () => string;
  private options: SyncOptions;
  private ws: WebSocket | null = null;
  private status: SyncStatus = SyncStatus.Disconnected;
  private statusListeners: Set<(status: SyncStatus) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private isPushing = false;
  private isDestroyed = false;
  private pendingBatches: Map<string, number[]> = new Map(); // batchId -> localIds

  /**
   * Creates a new BeamedSyncClient instance.
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
      reconnectIntervalMs: 2000,
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
        console.error('[BeamedDB] Sync status listener error:', err);
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
      console.warn('[BeamedDB] No WebSocket implementation found.');
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
        console.error('[BeamedDB] Failed to process message from server:', err);
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
      console.error('[BeamedDB] WebSocket error:', err);
      this.ws?.close();
    };
  }

  /**
   * Disconnects the active WebSocket connection without marking the client as destroyed.
   */
  disconnect(): void {
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectIntervalMs ?? 2000);
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async sendAuth(): Promise<void> {
    const lastSyncSeq = (await this.idb.getMeta<number>('lastSyncSeq')) ?? 0;
    const msg: ClientMessage = {
      type: ClientMessageType.Auth,
      token: this.options.token,
      clientId: this.getClientId(),
      lastSyncSeq,
    };
    this.send(msg);
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case ServerMessageType.AuthSuccess: {
        this.setStatus(SyncStatus.Connected);
        this.schedulePush(0);
        break;
      }

      case ServerMessageType.AuthError: {
        console.error('[BeamedDB] Auth error from server:', msg.message);
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

      case ServerMessageType.Error:
        console.error('[BeamedDB] Server error:', msg.message);
        break;
    }
  }

  private async applySnapshot(
    snapshot: RecordSnapshotItem[],
    seq: number,
  ): Promise<void> {
    await this.idb.applySnapshotBatch(snapshot, seq);

    const eventsByStore = new Map<
      string,
      Array<{
        op: OperationType;
        id: string;
        data?: unknown;
        isRemote?: boolean;
      }>
    >();

    for (const item of snapshot) {
      let list = eventsByStore.get(item.store);
      if (!list) {
        list = [];
        eventsByStore.set(item.store, list);
      }
      list.push({
        op: item.deleted ? OperationType.Delete : OperationType.Put,
        id: item.id,
        data: item.deleted ? undefined : item.data,
        isRemote: true,
      });
    }

    for (const [storeName, events] of eventsByStore.entries()) {
      const table = this.getTable(storeName);
      table.notifyRemoteChanges(events);
    }
  }

  private async applyChanges(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    await this.idb.applyRemoteChangesBatch(changes, seq);

    const eventsByStore = new Map<
      string,
      Array<{
        op: OperationType;
        id: string;
        data?: unknown;
        isRemote?: boolean;
      }>
    >();

    for (const change of changes) {
      let list = eventsByStore.get(change.store);
      if (!list) {
        list = [];
        eventsByStore.set(change.store, list);
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

    for (const [storeName, events] of eventsByStore.entries()) {
      const table = this.getTable(storeName);
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
