/**
 * The type of mutation operation performed on a record.
 */
export enum OperationType {
  /** Insert or update a record payload. */
  Put = 'put',
  /** Delete a record with a tombstone. */
  Delete = 'delete',
}

/**
 * Represents a persisted record with local metadata.
 *
 * @typeParam T - The data type of the stored record value.
 */
export interface StoredRecord<T = unknown> {
  /** Unique record identifier. */
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
  /** Creator user identifier of the record. */
  ownerId?: string;
}

/**
 * Represents a single record entry in a full database snapshot.
 *
 * @typeParam T - The data type of the record payload.
 */
export interface SnapshotRecord<T = unknown> extends StoredRecord<T> {
  /** Target table name. */
  table: string;
}

/**
 * Represents an individual mutation operation record to be synced.
 *
 * @typeParam T - The data type of the record payload.
 */
export interface ChangeRecord<T = unknown> {
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
  seq?: number;
  /** Monotonic epoch timestamp when the change was initiated. */
  timestamp: number;
  /** Identifier of the client that originated the change. */
  clientId: string;
  /** Creator user identifier of the record. */
  ownerId?: string;
}
