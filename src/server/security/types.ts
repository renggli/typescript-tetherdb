import type { OperationType } from '../../shared/types.js';

/**
 * Internal representation of a stored record in local persistence.
 *
 * @typeParam T - Payload data type.
 */
export interface InternalStoredRecord<T = unknown> {
  /** Unique record identifier within the table partition. */
  id: string;
  /** Stored value payload. */
  data: T;
  /** Record revision version. */
  version: number;
  /** Epoch timestamp of the last write. */
  timestamp: number;
  /** Flag indicating whether the record is marked as deleted. */
  deleted?: boolean;
  /** Identifier of client that performed the write. */
  clientId?: string;
  /** Internal owner user identifier. */
  userId?: string;
}

/**
 * Internal representation of a changelog mutation record.
 *
 * @typeParam T - Payload data type.
 */
export interface InternalChangeRecord<T = unknown> {
  /** Target table name. */
  table: string;
  /** Unique record identifier within the table. */
  id: string;
  /** Mutation operation type. */
  op: OperationType;
  /** Data payload for put operations. */
  data?: T;
  /** Incremental version counter for the record. */
  version?: number;
  /** Server-assigned global sequential index. */
  seq: number;
  /** Monotonic epoch timestamp when the change was initiated. */
  timestamp: number;
  /** Identifier of the client that originated the change. */
  clientId?: string;
  /** Internal author user identifier. */
  userId?: string;
}

/**
 * Internal snapshot record representation combining table identifier and internal record fields.
 *
 * @typeParam T - Payload data type.
 */
export interface InternalSnapshotRecord<T = unknown>
  extends InternalStoredRecord<T> {
  /** Target table name. */
  table: string;
}
