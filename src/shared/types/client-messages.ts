/**
 * WebSocket client-to-server wire messages.
 *
 * @module tetherdb/shared/types/client-messages
 */

import type { ChangeRecord } from './records.js';

/**
 * Types of messages sent from the client to the server over the WebSocket sync connection.
 */
export enum ClientMessageType {
  /** Heartbeat ping message to verify connection liveness. */
  Ping = 'ping',
  /** Authenticate connection with user token and initial sync sequence. */
  Auth = 'auth',
  /** Submit a batch of local pending changes to the server. */
  ChangeBatch = 'change_batch',
}

/**
 * Client heartbeat ping message.
 */
export interface PingClientMessage {
  type: ClientMessageType.Ping;
}

/**
 * Client authentication handshake message.
 */
export interface AuthClientMessage {
  type: ClientMessageType.Auth;
  /** Wire protocol version number. */
  protocolVersion: number;
  /** Client capabilities supported by this client session. */
  capabilities?: string[];
  /** Unique client instance identifier. */
  clientId: string;
  /** Signed authentication session token. */
  token?: string;
  /** Last synchronized sequence number known to the client. */
  lastSyncSeq?: number;
  /** Specific table names to subscribe to. */
  tables?: string[];
}

/**
 * Client mutation batch message.
 */
export interface ChangeBatchClientMessage {
  type: ClientMessageType.ChangeBatch;
  /** Unique batch correlation identifier. */
  batchId: string;
  /** Unique client instance identifier. */
  clientId: string;
  /** Array of change operations to apply. */
  changes: ChangeRecord[];
}

/**
 * Discriminated union of all messages sent from client to server.
 */
export type ClientMessage =
  | PingClientMessage
  | AuthClientMessage
  | ChangeBatchClientMessage;
