/**
 * Client-to-server wire messages.
 *
 * @module tetherdb/shared/types/client-messages
 */

import type { ChangeRecord } from './records.js';

/**
 * Types of messages sent from the client to the server over the sync connection.
 */
export enum ClientMessageType {
  /** Heartbeat ping message to verify connection liveness. */
  Ping = 'ping',
  /** Authenticate connection with user token and initial sync sequence. */
  Auth = 'auth',
  /** Register a new user account. */
  Register = 'register',
  /** Login with user credentials or token. */
  Login = 'login',
  /** Log out and unbind active user session. */
  Logout = 'logout',
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
 * Client user registration request message.
 */
export interface RegisterClientMessage {
  type: ClientMessageType.Register;
  /** Unique request correlation identifier. */
  requestId: string;
  /** Desired account username. */
  userName: string;
  /** Account password. */
  password: string;
}

/**
 * Client user login request message.
 */
export interface LoginClientMessage {
  type: ClientMessageType.Login;
  /** Unique request correlation identifier. */
  requestId: string;
  /** Account username (when logging in with credentials). */
  userName?: string;
  /** Account password (when logging in with credentials). */
  password?: string;
  /** Signed authentication token (when authenticating with existing token). */
  token?: string;
}

/**
 * Client user logout request message.
 */
export interface LogoutClientMessage {
  type: ClientMessageType.Logout;
  /** Unique request correlation identifier. */
  requestId: string;
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
  | RegisterClientMessage
  | LoginClientMessage
  | LogoutClientMessage
  | ChangeBatchClientMessage;
