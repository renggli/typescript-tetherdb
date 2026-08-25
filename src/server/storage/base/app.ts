import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../../../shared/types.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';

/**
 * Common abstract base class for AppStorage implementations.
 */
export abstract class AppBaseStorage implements AppStorage {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  /** Creates/registers a new table within this application. */
  abstract createTable(tableName: string): Promise<TableStorage>;

  /** Retrieves a table handle if it exists. */
  abstract getTable(tableName: string): Promise<TableStorage | undefined>;

  /** Lists all registered tables in this application. */
  abstract getTables(): Promise<TableStorage[]>;

  /** Applies batch mutation changes for a user. */
  abstract applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /** Retrieves changes for a user since a given sequence number. */
  abstract getChangesSince(
    user: UserStorage,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  /** Returns the current global sequence number for a user within this application. */
  abstract getCurrentSeq(user: UserStorage): Promise<number>;

  /** Deletes this entire application and all associated data. */
  abstract delete(): Promise<boolean>;
}

/**
 * Applies a change to an existing (or undefined) record and assigns the sequence number.
 */
export function applyChangeToRecord(
  change: ChangeRecord,
  existing: StoredRecord | undefined,
  seq: number,
): {
  updatedRecord: StoredRecord;
  appliedChange: ChangeRecord & { seq: number };
} {
  const isDeleted = change.op === OperationType.Delete;
  const nextVersion = (existing?.version ?? 0) + 1;

  const updatedRecord: StoredRecord = {
    id: change.id,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    deleted: isDeleted,
    data: isDeleted ? null : (change.data ?? null),
  };

  const appliedChange: ChangeRecord & { seq: number } = {
    seq,
    table: change.table,
    id: change.id,
    op: change.op,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    data: isDeleted ? undefined : change.data,
  };

  return { updatedRecord, appliedChange };
}
