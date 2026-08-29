/**
 * Operational state of the synchronization coordinator.
 */
export enum SyncStatus {
  /** Disconnected from the remote synchronization server. */
  Disconnected,
  /** Currently establishing a connection. */
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
  protocols?: string | string[],
) => WebSocket;

/**
 * Configuration options for Sync.
 */
export interface SyncOptions {
  /** Remote sync endpoint URL (e.g. 'ws://localhost:8080'). */
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
  /** Custom WebSocket constructor for non-browser or test environments. */
  webSocketClass?: WebSocketConstructor;
}
