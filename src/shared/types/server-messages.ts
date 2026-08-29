/**
 * Server-to-client wire messages.
 *
 * @module tetherdb/shared/types/server-messages
 */

import type { ChangeRecord, SnapshotRecord } from './records.js';

/**
 * Types of messages sent from the server to the client over the sync connection.
 */
export enum ServerMessageType {
  /** Heartbeat pong response. */
  Pong = 'pong',
  /** General server error notification. */
  Error = 'error',
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
  /** Real-time broadcast of changes applied by another client session. */
  BroadcastChanges = 'broadcast_changes',
}

/**
 * Server heartbeat pong response message.
 */
export interface PongServerMessage {
  type: ServerMessageType.Pong;
}

/**
 * Server error notification message.
 */
export interface ErrorServerMessage {
  type: ServerMessageType.Error;
  /** Error description message. */
  message: string;
}

/**
 * Server authentication success response message.
 */
export interface AuthSuccessServerMessage {
  type: ServerMessageType.AuthSuccess;
  /** Correlation identifier if in response to a register/login/logout request. */
  requestId?: string;
  /** Wire protocol version number. */
  protocolVersion: number;
  /** Server capabilities supported by this server instance. */
  capabilities?: string[];
  /** Authenticated user display username. */
  userName?: string;
  /** Refreshed session token for sliding session validity. */
  token?: string;
  /** Current global sequence number on the server. */
  currentSeq: number;
}

/**
 * Server authentication failure response message.
 */
export interface AuthErrorServerMessage {
  type: ServerMessageType.AuthError;
  /** Correlation identifier if in response to a register/login/logout request. */
  requestId?: string;
  /** Error description message. */
  message: string;
}

/**
 * Server full dataset snapshot message.
 */
export interface SyncSnapshotServerMessage {
  type: ServerMessageType.SyncSnapshot;
  /** Sequence number corresponding to the snapshot state. */
  seq: number;
  /** Active records across accessible tables. */
  snapshot: SnapshotRecord[];
}

/**
 * Server incremental delta diff message.
 */
export interface SyncDiffServerMessage {
  type: ServerMessageType.SyncDiff;
  /** Starting sequence number exclusive. */
  fromSeq: number;
  /** Ending sequence number inclusive. */
  toSeq: number;
  /** Array of applied changes in sequential order. */
  changes: ChangeRecord[];
}

/**
 * Server batch acknowledgement message.
 */
export interface ChangeAckServerMessage {
  type: ServerMessageType.ChangeAck;
  /** Correlation identifier of the acknowledged batch. */
  batchId: string;
  /** New global sequence number after applying the batch. */
  appliedSeq: number;
}

/**
 * Server real-time changes broadcast message.
 */
export interface BroadcastChangesServerMessage {
  type: ServerMessageType.BroadcastChanges;
  /** Global sequence number assigned to these changes. */
  seq: number;
  /** Client identifier that originated the change. */
  fromClientId: string;
  /** Array of applied changes. */
  changes: ChangeRecord[];
}

/**
 * Discriminated union of all messages sent from server to client.
 */
export type ServerMessage =
  | PongServerMessage
  | ErrorServerMessage
  | AuthSuccessServerMessage
  | AuthErrorServerMessage
  | SyncSnapshotServerMessage
  | SyncDiffServerMessage
  | ChangeAckServerMessage
  | BroadcastChangesServerMessage;
