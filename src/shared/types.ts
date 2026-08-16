/**
 * The type of mutation operation performed on a record.
 */
export enum OperationType {
  /** Insert or update a record payload. */
  Put = 'put',
  /** Delete a record (tombstone). */
  Delete = 'delete',
}

/**
 * Represents an individual mutation operation record to be synced.
 *
 * @typeParam T - The data type of the record payload.
 */
export interface ChangeRecord<T = unknown> {
  /** The target table name. */
  table: string;
  /** The unique record identifier within the table. */
  id: string;
  /** The mutation operation type. */
  op: OperationType;
  /** The data payload for 'put' operations. */
  data?: T;
  /** Monotonic epoch timestamp when the change was initiated. */
  timestamp: number;
  /** Identifier of the client that originated the change. */
  clientId: string;
  /** Incremental version counter for the record. */
  version?: number;
  /** Server-assigned global sequential index. */
  seq?: number;
  /** Flag indicating whether this record represents a tombstone/deletion. */
  deleted?: boolean;
  /** Application namespace identifier. */
  appId?: string;
}

/**
 * Represents a persisted record with local metadata.
 *
 * @typeParam T - The data type of the stored record value.
 */
export interface StoredRecord<T = unknown> {
  /** The unique record identifier. */
  id: string;
  /** The stored value payload. */
  data: T;
  /** Epoch timestamp of the last write. */
  timestamp: number;
  /** Record revision version. */
  version: number;
  /** Flag indicating whether the record is marked as deleted. */
  deleted?: boolean;
  /** Identifier of client that performed the write. */
  clientId?: string;
}

/**
 * Represents a single record entry in a full database snapshot.
 *
 * @typeParam T - The data type of the record payload.
 */
export interface RecordSnapshotItem<T = unknown> {
  /** The table name. */
  table: string;
  /** The unique record identifier. */
  id: string;
  /** The record payload value. */
  data: T;
  /** Epoch timestamp of the last write. */
  timestamp: number;
  /** Record revision version. */
  version: number;
  /** Flag indicating whether the record is marked as deleted. */
  deleted?: boolean;
  /** Optional application namespace identifier. */
  appId?: string;
  /** Identifier of client that performed the write. */
  clientId?: string;
}

/**
 * Types of messages sent from the client to the server over the WebSocket sync connection.
 */
export enum ClientMessageType {
  /** Authenticate connection with user token and initial sync sequence. */
  Auth = 'auth',
  /** Explicitly request synchronization data (snapshot or diff). */
  InitSync = 'init_sync',
  /** Submit a batch of local pending changes to the server. */
  ChangeBatch = 'change_batch',
  /** Heartbeat ping message to verify connection liveness. */
  Ping = 'ping',
}

/**
 * Discriminated union of all messages sent from client to server.
 */
export type ClientMessage =
  | {
      type: ClientMessageType.Auth;
      /** Signed authentication session token. */
      token: string;
      /** Unique client instance identifier. */
      clientId: string;
      /** Last synchronized sequence number known to the client. */
      lastSyncSeq?: number;
      /** Application namespace identifier. */
      appId: string;
    }
  | {
      type: ClientMessageType.InitSync;
      /** Unique client instance identifier. */
      clientId: string;
      /** Last synchronized sequence number known to the client. */
      lastSyncSeq?: number;
    }
  | {
      type: ClientMessageType.ChangeBatch;
      /** Unique client instance identifier. */
      clientId: string;
      /** Unique batch correlation identifier. */
      batchId: string;
      /** Array of change operations to apply. */
      changes: ChangeRecord[];
    }
  | {
      type: ClientMessageType.Ping;
    };

/**
 * Types of messages sent from the server to the client over the WebSocket sync connection.
 */
export enum ServerMessageType {
  /** Authentication succeeded. */
  AuthSuccess = 'auth_success',
  /** Authentication failed. */
  AuthError = 'auth_error',
  /** Full dataset snapshot sent when client connects without prior sync sequence. */
  SyncSnapshot = 'sync_snapshot',
  /** Delta diff of changes that occurred since client's lastSyncSeq. */
  SyncDiff = 'sync_diff',
  /** Confirmation that a client change batch was applied. */
  ChangeAck = 'change_ack',
  /** Real-time broadcast of changes applied by another client session of the same user. */
  BroadcastChanges = 'broadcast_changes',
  /** Heartbeat pong response. */
  Pong = 'pong',
  /** General server error notification. */
  Error = 'error',
}

/**
 * Discriminated union of all messages sent from server to client.
 */
export type ServerMessage =
  | {
      type: ServerMessageType.AuthSuccess;
      /** Authenticated user account identifier. */
      userId: string;
      /** Current global sequence number of the user's data on the server. */
      currentSeq: number;
      /** Refreshed session token for sliding session validity. */
      token?: string;
    }
  | {
      type: ServerMessageType.AuthError;
      /** Error description message. */
      message: string;
    }
  | {
      type: ServerMessageType.SyncSnapshot;
      /** Sequence number corresponding to the snapshot state. */
      seq: number;
      /** All active records across tables. */
      snapshot: RecordSnapshotItem[];
    }
  | {
      type: ServerMessageType.SyncDiff;
      /** Starting sequence number (exclusive). */
      fromSeq: number;
      /** Ending sequence number (inclusive). */
      toSeq: number;
      /** Array of applied changes in sequential order. */
      changes: ChangeRecord[];
    }
  | {
      type: ServerMessageType.ChangeAck;
      /** The correlation identifier of the acknowledged batch. */
      batchId: string;
      /** The new global sequence number after applying the batch. */
      appliedSeq: number;
    }
  | {
      type: ServerMessageType.BroadcastChanges;
      /** Client ID that originated the change. */
      fromClientId: string;
      /** Global sequence number assigned to these changes. */
      seq: number;
      /** Array of applied changes. */
      changes: ChangeRecord[];
    }
  | {
      type: ServerMessageType.Pong;
    }
  | {
      type: ServerMessageType.Error;
      /** Error description message. */
      message: string;
    };

/**
 * Metadata stored locally tracking synchronization progress.
 */
export interface SyncMetadata {
  /** The latest sequence number synchronized with the server. */
  lastSyncSeq: number;
  /** Epoch timestamp of the last successful synchronization. */
  lastSyncTimestamp: number;
  /** Unique client instance identifier. */
  clientId: string;
}
