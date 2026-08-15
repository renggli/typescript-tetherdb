import type {
  ChangeRecord,
  RecordSnapshotItem,
  StoredRecord,
} from '../../shared/types.js';

/**
 * Pluggable server-side storage abstraction managing user-isolated, application-partitioned
 * database records, discovery APIs, and incremental changelog histories.
 */
export interface StorageAdapter {
  /**
   * Retrieves a single stored record by table and identifier for a user and application.
   *
   * @param userId - Target user account identifier.
   * @param store - Table/store name.
   * @param id - Record identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Stored record or `undefined` if not found.
   */
  getRecord(
    userId: string,
    store: string,
    id: string,
    appId?: string,
  ): Promise<StoredRecord | undefined>;

  /**
   * Retrieves all active records across all stores (or for a specific store) for a user and application.
   *
   * @param userId - Target user account identifier.
   * @param store - Optional specific table name to filter records.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of snapshot record items.
   */
  getAllRecords(
    userId: string,
    store?: string,
    appId?: string,
  ): Promise<RecordSnapshotItem[]>;

  /**
   * Applies an array of mutation change operations applying Last-Write-Wins rules,
   * assigning sequential change numbers, and appending to the app-scoped changelog.
   *
   * @param userId - Target user account identifier.
   * @param changes - Array of change records to apply.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Object containing the applied changes with sequence numbers and the new current sequence number.
   */
  applyChanges(
    userId: string,
    changes: ChangeRecord[],
    appId?: string,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Retrieves all change operations recorded for a user since a given sequence number within an application.
   * If the requested `fromSeq` is older than the compacted changelog retention window,
   * `requiresSnapshot` will be true, indicating the client should receive a full snapshot instead.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of applied change records, current sequence number, and optional snapshot requirement flag.
   */
  getChangesSince(
    userId: string,
    fromSeq: number,
    appId?: string,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  /**
   * Retrieves the current global sequence number for a user's dataset in an application.
   *
   * @param userId - Target user account identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Current integer sequence number.
   */
  getCurrentSeq(userId: string, appId?: string): Promise<number>;

  /**
   * Lists all active application namespace identifiers on the server, or created by a user.
   *
   * @param userId - Optional user ID filter.
   * @returns Array of unique application IDs.
   */
  listApps(userId?: string): Promise<string[]>;

  /**
   * Lists all table/store names created within an application for a user.
   *
   * @param userId - Target user account identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of table names.
   */
  listStores(userId: string, appId?: string): Promise<string[]>;

  /**
   * Optional cleanup callback invoked when shutting down the storage adapter.
   */
  close?(): Promise<void>;
}
