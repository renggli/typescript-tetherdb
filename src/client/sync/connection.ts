import { EventRegistry } from '../../shared/event.js';
import { TetherClientError, TetherClientErrorCode } from '../errors.js';
import type { SyncOptions, WebSocketConstructor } from './types.js';

export enum SyncStatus {
  Disconnected,
  Connecting,
  Connected,
  Error,
}

export interface ConnectionCallbacks {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onError: (error: TetherClientError) => void;
  onClose: (code?: number) => void;
}

export class ConnectionManager {
  url?: string;
  readonly onStatusChange = new EventRegistry<SyncStatus>();
  private webSocket: WebSocket | null = null;
  private currentStatus: SyncStatus = SyncStatus.Disconnected;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;
  private readonly options: SyncOptions;
  private readonly callbacks: ConnectionCallbacks;

  constructor(options: SyncOptions, callbacks: ConnectionCallbacks) {
    this.url = options.url;
    this.options = options;
    this.callbacks = callbacks;

    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
    }
  }

  get status(): SyncStatus {
    return this.currentStatus;
  }

  get isOpen(): boolean {
    return (
      this.webSocket !== null &&
      this.webSocket.readyState === (this.webSocket.OPEN ?? 1)
    );
  }

  get isConnecting(): boolean {
    return (
      this.webSocket !== null &&
      this.webSocket.readyState === (this.webSocket.CONNECTING ?? 0)
    );
  }

  connect(url?: string): void {
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
      if (this.isOpen) {
        if (this.currentStatus !== SyncStatus.Connected) {
          // Open but not yet fully authenticated — re-trigger the Auth handshake.
          this.setStatus(SyncStatus.Connecting);
          this.callbacks.onOpen();
        }
        // If already Connected, the caller already updated the token; no re-auth needed.
        return;
      }
      if (this.isConnecting) {
        this.setStatus(SyncStatus.Connecting);
        return;
      }
    }

    this.setStatus(SyncStatus.Connecting);

    try {
      const WebSocketClass: WebSocketConstructor | null =
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
      this.callbacks.onError(
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
      this.callbacks.onOpen();
    };

    this.webSocket.onmessage = (event) => {
      const raw =
        typeof event.data === 'string'
          ? event.data
          : event.data.toString('utf8');
      this.callbacks.onMessage(raw);
    };

    this.webSocket.onerror = () => {
      this.callbacks.onError(
        new TetherClientError(
          TetherClientErrorCode.NetworkError,
          'WebSocket connection encountered an error',
        ),
      );
    };

    this.webSocket.onclose = (event) => {
      this.stopPing();
      this.webSocket = null;
      if (!this.isDestroyed) {
        this.setStatus(SyncStatus.Disconnected);
        this.callbacks.onClose(event.code);
        if (event.code !== 1000 && event.code !== 1005) {
          this.scheduleReconnect();
        }
      }
    };
  }

  send(data: string): boolean {
    if (this.isOpen && this.webSocket) {
      this.webSocket.send(data);
      return true;
    }
    return false;
  }

  startPing(): void {
    this.stopPing();
    const interval = this.options.pingIntervalMs ?? 30000;
    if (interval <= 0) return;

    this.pingTimer = setInterval(() => {
      this.send(JSON.stringify({ type: 'ping' }));
    }, interval);
  }

  stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

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
        const wsWithTerminate = ws as unknown as { terminate?: () => void };
        if (typeof wsWithTerminate.terminate === 'function') {
          wsWithTerminate.terminate();
        } else {
          ws.close();
        }
      } catch {
        // Ignored during disconnect
      }
    }
    this.setStatus(SyncStatus.Disconnected);
  }

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

  setStatus(newStatus: SyncStatus): void {
    if (this.currentStatus === newStatus) return;
    this.currentStatus = newStatus;
    this.onStatusChange.publish(newStatus);
  }

  private scheduleReconnect(): void {
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
}
