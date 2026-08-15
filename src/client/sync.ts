import {
  type ChangeRecord,
  type ClientMessage,
  ClientMessageType,
  OperationType,
  type RecordSnapshotItem,
  type ServerMessage,
  ServerMessageType,
  type StoredRecord,
} from '../shared/types.js';
import type { IDBManager } from './idb.js';
import type { ITable } from './table.js';

/**
 * Operational state of the synchronization coordinator.
 */
export enum SyncStatus {
  /** Not connected to the server. */
  Disconnected = 'disconnected',
  /** Currently attempting to establish a WebSocket connection. */
  Connecting = 'connecting',
  /** Authenticated and connected in real time. */
  Connected = 'connected',
  /** Actively synchronizing dataset or changes. */
  Syncing = 'syncing',
  /** An error occurred with the connection or authentication. */
  Error = 'error',
}

/**
 * Constructor signature for injectable WebSocket implementations (browser or Node.js).
 */
export type WebSocketConstructor = new (
  url: string | URL,
  protocols?: string | string[],
) => WebSocket;

/**
 * Options for configuring synchronization behavior.
 */
export interface SyncOptions {
  /** The WebSocket endpoint URL (e.g., 'ws://localhost:8080/sync'). */
  url: string;
  /** Authentication session token for the user account. */
  token: string;
  /** Whether to automatically connect upon initialization (defaults to true). */
  autoConnect?: boolean;
  /** Interval in milliseconds between reconnection attempts (defaults to 2000ms). */
  reconnectIntervalMs?: number;
  /** Custom WebSocket constructor (useful for Node.js test environments). */
  WebSocketClass?: WebSocketConstructor;
}

/**
 * Two-way WebSocket sync coordinator managing initial snapshot / diff downloads,
 * outbox queue flushing, acknowledgments, and auto-reconnect backoff.
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
   * Retrieves the current synchronization connection status.
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

    this.ws.onerror = () => {
      this.setStatus(SyncStatus.Error);
    };
  }

  /**
   * Closes the active WebSocket connection and enters the disconnected state.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus(SyncStatus.Disconnected);
  }

  /**
   * Permanently tears down the sync client, cancelling pending retries and closing connections.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.disconnect();
    this.statusListeners.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isDestroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, this.options.reconnectIntervalMs);
  }

  private async sendAuth(): Promise<void> {
    const lastSyncSeq = (await this.idb.getMeta<number>('lastSyncSeq')) ?? 0;
    const authMsg: ClientMessage = {
      type: ClientMessageType.Auth,
      token: this.options.token,
      clientId: this.getClientId(),
      lastSyncSeq,
    };
    this.send(authMsg);
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case ServerMessageType.AuthSuccess: {
        this.setStatus(SyncStatus.Connected);
        // Push any local changes queued in outbox
        await this.pushOutbox();
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
        break;
      }

      case ServerMessageType.SyncDiff: {
        await this.applyChanges(msg.changes, msg.toSeq);
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
    for (const item of snapshot) {
      const table = this.getTable(item.store);
      const record: StoredRecord = {
        id: item.id,
        data: item.data,
        timestamp: item.timestamp,
        version: item.version,
        deleted: item.deleted,
      };
      await table.applyRemoteRecord(record);
    }
    await this.idb.setMeta('lastSyncSeq', seq);
  }

  private async applyChanges(
    changes: ChangeRecord[],
    seq: number,
  ): Promise<void> {
    for (const change of changes) {
      const table = this.getTable(change.store);
      const record: StoredRecord = {
        id: change.id,
        data: change.data,
        timestamp: change.timestamp,
        version: change.version ?? 1,
        deleted: change.op === OperationType.Delete || change.deleted,
      };
      await table.applyRemoteRecord(record);
    }
    await this.idb.setMeta('lastSyncSeq', seq);
  }

  /**
   * Pushes un-synced outbox changes to the server in a correlated batch.
   */
  async pushOutbox(): Promise<void> {
    if (this.isPushing || !this.ws || this.ws.readyState !== 1) return;
    this.isPushing = true;

    try {
      const pending = await this.idb.getPendingOutbox();
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
